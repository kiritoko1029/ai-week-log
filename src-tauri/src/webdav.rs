//! WebDAV 同步：对齐 src/main/webdav.js。
//! 基于 reqwest（自定义方法 PROPFIND/MKCOL）+ flate2(gzip) + url(SSRF 校验)，无 reqwest_dav 依赖。
//! 同步范围：notes/*.md、memory/entries/*.md、memory/index.json、history.json、config.json(白名单)。
//! 策略：notes/entries 文件级 last-write-wins；index/history 按 id 并集合并；config 仅同步偏好。
//! 注：JS 版的 logger.debug 细粒度日志省略（仅诊断、不改变同步行为）；命令层在 lib.rs 记关键日志。

use std::collections::{BTreeSet, HashMap};
use std::fs;
use std::path::{Path, PathBuf};

use base64::Engine;
use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use flate2::Compression;
use regex::Regex;
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::sync::LazyLock;

const NOTES_DIR: &str = "notes";
const MEMORY_DIR: &str = "memory";
const MEMORY_ENTRIES_DIR: &str = "memory/entries";
pub const STATUS_FILE: &str = "webdav-status.json";
const BACKUPS_DIR: &str = "backups";
const DEFAULT_BACKUP_RETENTION: u64 = 10;

/// config 同步白名单（对齐 webdav.js CONFIG_SYNC_FIELDS）。
static CONFIG_SYNC_FIELDS: &[&[&str]] = &[
    &["schemaVersion"],
    &["weekStart"],
    &["timezone"],
    &["dateBasis"],
    &["filters"],
    &["notes", "enabled"],
    &["notes", "miscProject"],
    &["codexHook", "enabled"],
    &["codexHook", "port"],
    &["zcodeHook", "enabled"],
    &["zcodeHook", "port"],
    &["ui", "theme"],
    &["ai", "provider"],
    &["ai", "concurrency"],
    &["ai", "anthropic", "model"],
    &["ai", "anthropic", "temperature"],
    &["ai", "anthropic", "maxTokens"],
    &["ai", "openai", "model"],
    &["ai", "openai", "temperature"],
    &["ai", "openai", "maxTokens"],
    &["output"],
    &["memory", "enabled"],
    &["memory", "embeddingSource"],
    &["memory", "embeddingModel"],
    &["memory", "topK"],
];

#[derive(Clone)]
pub struct Creds {
    pub username: String,
    pub password: String,
}

pub type WebResult<T> = Result<T, String>;

// ── 工具：base64 / 私网判定 / URL 规范化 ──

fn basic_auth(username: &str, password: &str) -> String {
    let raw = format!("{username}:{password}");
    format!("Basic {}", base64::engine::general_purpose::STANDARD.encode(raw.as_bytes()))
}

fn is_private_hostname(hostname: &str) -> bool {
    let h = hostname.to_lowercase();
    if h.is_empty() {
        return true;
    }
    if h == "localhost" || h.ends_with(".localhost") {
        return true;
    }
    if h == "::1" || h == "[::1]" {
        return true;
    }
    if h.starts_with("127.") || h.starts_with("10.") || h.starts_with("192.168.") {
        return true;
    }
    let parts: Vec<Option<u32>> = h.split('.').map(|p| p.parse::<u32>().ok()).collect();
    if parts.len() == 4 && parts.iter().all(|p| matches!(p, Some(n) if *n <= 255)) {
        let nums: Vec<u32> = parts.iter().map(|p| p.unwrap()).collect();
        if nums[0] == 172 && (16..=31).contains(&nums[1]) {
            return true;
        }
        if nums[0] == 169 && nums[1] == 254 {
            return true;
        }
        if nums[0] == 0 {
            return true;
        }
    }
    if h == "fc00::" || h == "fe80::" || h.starts_with("fc") || h.starts_with("fd") || h.starts_with("fe80:") {
        return true;
    }
    false
}

/// 规范化 WebDAV base URL（对齐 normalizeWebdavBaseUrl）：https-only + 拦私网 + 尾斜杠。
fn normalize_webdav_base_url(input: &str) -> WebResult<String> {
    let raw = input.trim();
    if raw.is_empty() {
        return Err("未配置 WebDAV URL".to_string());
    }
    let mut parsed = url::Url::parse(raw).map_err(|_| "WebDAV URL 格式无效".to_string())?;
    let allow_insecure = std::env::var("WEEKLOG_ALLOW_INSECURE_WEBDAV").ok().as_deref() == Some("1");
    let allow_private = std::env::var("WEEKLOG_ALLOW_PRIVATE_WEBDAV").ok().as_deref() == Some("1");
    let scheme = parsed.scheme().to_string();
    if scheme != "https" && !(allow_insecure && scheme == "http") {
        return Err("WebDAV URL 必须使用 HTTPS".to_string());
    }
    let host = parsed.host_str().unwrap_or("").to_string();
    if !allow_private && is_private_hostname(&host) {
        return Err("WebDAV URL 不能指向本机或私有网络地址".to_string());
    }
    parsed.set_fragment(None);
    parsed.set_query(None);
    let path = parsed.path().to_string();
    if !path.ends_with('/') {
        parsed.set_path(&format!("{path}/"));
    }
    Ok(parsed.to_string())
}

fn join_url(base: &str, rel: &str) -> String {
    let b = if base.ends_with('/') { base.to_string() } else { format!("{base}/") };
    let r = rel.trim_start_matches('/');
    format!("{b}{r}")
}

/// 最小 percent-decode（对齐 decodeURIComponent，仅处理 %XX + UTF-8）。
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hi = (bytes[i + 1] as char).to_digit(16);
            let lo = (bytes[i + 2] as char).to_digit(16);
            if let (Some(h), Some(l)) = (hi, lo) {
                out.push((h * 16 + l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

/// 最小 percent-encode（对齐 encodeURIComponent，用于文件名拼 URL）。保留 A-Za-z0-9-_.!~*'()
fn percent_encode(s: &str) -> String {
    let mut out = String::new();
    for b in s.as_bytes() {
        let c = *b as char;
        if c.is_ascii_alphanumeric() || "-_.!~*'()".contains(c) {
            out.push(c);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

// ── PROPFIND XML 解析（轻量正则，对齐 parsePropfind）──

static RE_RESPONSE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?is)<[Dd]?:?response[^>]*>(.*?)</[Dd]?:?response>").unwrap());
static RE_HREF: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?is)<[Dd]?:?href[^>]*>(.*?)</[Dd]?:?href>").unwrap());
static RE_NAME: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?is)<[Dd]?:?displayname[^>]*>(.*?)</[Dd]?:?displayname>").unwrap());
static RE_COLLECTION: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)<[Dd]?:?collection[^>]*/?>").unwrap());
static RE_SIZE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?is)<[Dd]?:?getcontentlength[^>]*>(.*?)</[Dd]?:?getcontentlength>").unwrap());
static RE_MOD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?is)<[Dd]?:?getlastmodified[^>]*>(.*?)</[Dd]?:?getlastmodified>").unwrap());

#[derive(Clone)]
struct DavItem {
    #[allow(dead_code)]
    href: String,
    display_name: String,
    is_collection: bool,
    size: u64,
    last_modified: String,
}

fn parse_propfind(xml: &str) -> Vec<DavItem> {
    let mut items = Vec::new();
    for cap in RE_RESPONSE.captures_iter(xml) {
        let block = &cap[1];
        let href = RE_HREF.captures(block).map(|c| c[1].trim().to_string()).unwrap_or_default();
        let is_collection = RE_COLLECTION.is_match(block);
        let display_name = RE_NAME.captures(block).map(|c| c[1].trim().to_string()).unwrap_or_default();
        let size = RE_SIZE
            .captures(block)
            .and_then(|c| c[1].trim().parse::<u64>().ok())
            .unwrap_or(0);
        let last_modified = RE_MOD.captures(block).map(|c| c[1].trim().to_string()).unwrap_or_default();
        items.push(DavItem {
            href: percent_decode(href.trim()),
            display_name,
            is_collection,
            size,
            last_modified,
        });
    }
    // 第一个总是目录自身，跳过（对齐 items.slice(1)）
    if items.is_empty() {
        items
    } else {
        items[1..].to_vec()
    }
}

// ── WebDAV HTTP 原语 ──

fn method(name: &str) -> reqwest::Method {
    reqwest::Method::from_bytes(name.as_bytes()).unwrap()
}

async fn propfind(client: &reqwest::Client, url: &str, creds: &Creds) -> WebResult<Vec<DavItem>> {
    let body = r#"<?xml version="1.0" encoding="utf-8"?>
<D:propfind xmlns:D="DAV:">
  <D:prop>
    <D:displayname/>
    <D:resourcetype/>
    <D:getcontentlength/>
    <D:getlastmodified/>
  </D:prop>
</D:propfind>"#;
    let resp = client
        .request(method("PROPFIND"), url)
        .header("Authorization", basic_auth(&creds.username, &creds.password))
        .header("Depth", "1")
        .header("Content-Type", "application/xml; charset=utf-8")
        .body(body)
        .send()
        .await
        .map_err(|e| format!("PROPFIND {url} → 网络错误：{e}"))?;
    let status = resp.status().as_u16();
    if status != 207 && status != 200 {
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("PROPFIND {url} → {status}: {}", snippet(&text, 200)));
    }
    let xml = resp.text().await.unwrap_or_default();
    Ok(parse_propfind(&xml))
}

/// 逐级 MKCOL 确保目录存在（对齐 ensureCollection）。返回是否新建了目录。
async fn ensure_collection(client: &reqwest::Client, url: &str, creds: &Creds) -> WebResult<bool> {
    let probe = if url.ends_with('/') { url.to_string() } else { format!("{url}/") };
    if propfind(client, &probe, creds).await.is_ok() {
        return Ok(false);
    }
    let no_scheme = url.trim_start_matches("https://").trim_start_matches("http://");
    let parts: Vec<&str> = no_scheme.split('/').filter(|s| !s.is_empty()).collect();
    if parts.len() < 2 {
        return Ok(false);
    }
    let proto = if url.starts_with("https") { "https://" } else { "http://" };
    let host = parts[0];
    let mut cur = format!("{proto}{host}");
    let mut created_any = false;
    for seg in &parts[1..] {
        cur = format!("{cur}/{}", percent_decode(seg));
        if propfind(client, &format!("{cur}/"), creds).await.is_ok() {
            continue;
        }
        let resp = client
            .request(method("MKCOL"), format!("{cur}/"))
            .header("Authorization", basic_auth(&creds.username, &creds.password))
            .send()
            .await
            .map_err(|e| format!("MKCOL {cur} → 网络错误：{e}"))?;
        let st = resp.status().as_u16();
        if st == 201 {
            created_any = true;
            continue;
        }
        if st == 405 || st == 301 || (200..400).contains(&st) {
            continue;
        }
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("MKCOL {cur} → {st} {}", snippet(&text, 120)));
    }
    Ok(created_any)
}

async fn dav_get(client: &reqwest::Client, url: &str, creds: &Creds) -> WebResult<Option<String>> {
    let resp = client
        .get(url)
        .header("Authorization", basic_auth(&creds.username, &creds.password))
        .send()
        .await
        .map_err(|e| format!("GET {url} → 网络错误：{e}"))?;
    let st = resp.status().as_u16();
    if st == 404 {
        return Ok(None);
    }
    if st != 200 {
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("GET {url} → {st}: {}", snippet(&text, 200)));
    }
    Ok(Some(resp.text().await.unwrap_or_default()))
}

async fn dav_get_buffer(client: &reqwest::Client, url: &str, creds: &Creds) -> WebResult<Vec<u8>> {
    let resp = client
        .get(url)
        .header("Authorization", basic_auth(&creds.username, &creds.password))
        .send()
        .await
        .map_err(|e| format!("GET {url} → 网络错误：{e}"))?;
    let st = resp.status().as_u16();
    if st != 200 {
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("GET {url} → {st}: {}", snippet(&text, 200)));
    }
    Ok(resp.bytes().await.map_err(|e| format!("读取响应失败：{e}"))?.to_vec())
}

async fn dav_put(client: &reqwest::Client, url: &str, creds: &Creds, content: Vec<u8>, content_type: &str) -> WebResult<()> {
    let resp = client
        .put(url)
        .header("Authorization", basic_auth(&creds.username, &creds.password))
        .header("Content-Type", content_type)
        .body(content)
        .send()
        .await
        .map_err(|e| format!("PUT {url} → 网络错误：{e}"))?;
    let st = resp.status().as_u16();
    if st == 200 || st == 201 || st == 204 {
        Ok(())
    } else {
        let text = resp.text().await.unwrap_or_default();
        Err(format!("PUT {url} → {st}: {}", snippet(&text, 200)))
    }
}

async fn dav_delete(client: &reqwest::Client, url: &str, creds: &Creds) -> WebResult<()> {
    let resp = client
        .delete(url)
        .header("Authorization", basic_auth(&creds.username, &creds.password))
        .send()
        .await
        .map_err(|e| format!("DELETE {url} → 网络错误：{e}"))?;
    let st = resp.status().as_u16();
    if matches!(st, 200 | 202 | 204 | 404) {
        Ok(())
    } else {
        Err(format!("DELETE {url} → {st}"))
    }
}

fn snippet(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

// ── 本地 IO 辅助 ──

fn read_local_file(p: &Path) -> Option<String> {
    fs::read_to_string(p).ok()
}

fn write_local_file(p: &Path, content: &str) -> WebResult<()> {
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建目录失败：{e}"))?;
    }
    fs::write(p, content).map_err(|e| format!("写入失败：{e}"))
}

fn notes_dir_from_config(cfg: &Value, base_dir: &Path) -> PathBuf {
    let d = cfg.get("notes").and_then(|n| n.get("dir")).and_then(|v| v.as_str());
    match d {
        Some(p) if !p.is_empty() && Path::new(p).is_absolute() => PathBuf::from(p),
        Some(p) if !p.is_empty() => base_dir.join(p),
        _ => base_dir.join(NOTES_DIR),
    }
}

// ── 状态文件 ──

pub fn read_status(dir: &Path) -> Value {
    let p = dir.join(STATUS_FILE);
    fs::read_to_string(&p)
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .unwrap_or_else(|| json!({}))
}

fn write_status(dir: &Path, status: &Value) {
    let p = dir.join(STATUS_FILE);
    if let Ok(s) = serde_json::to_string_pretty(status) {
        let _ = fs::write(p, s);
    }
}

// ── config 白名单 get/set ──

fn get_by_path<'a>(obj: &'a Value, path: &[&str]) -> Option<&'a Value> {
    let mut cur = obj;
    for k in path {
        cur = cur.get(*k)?;
    }
    Some(cur)
}

fn set_by_path(obj: &mut Value, path: &[&str], value: Value) {
    let mut cur = obj;
    for k in &path[..path.len() - 1] {
        if !cur.get(*k).map(|v| v.is_object()).unwrap_or(false) {
            cur[*k] = json!({});
        }
        cur = cur.get_mut(*k).unwrap();
    }
    cur[path[path.len() - 1]] = value;
}

fn pick_config_for_backup(cfg: &Value) -> Value {
    let mut out = json!({});
    for field in CONFIG_SYNC_FIELDS {
        if let Some(v) = get_by_path(cfg, field) {
            set_by_path(&mut out, field, v.clone());
        }
    }
    out
}

// ── 时间戳 / 备份名 ──

fn iso_now() -> String {
    chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

fn compact_timestamp() -> String {
    use chrono::{Datelike, Local, Timelike};
    let d = Local::now();
    format!(
        "{:04}{:02}{:02}-{:02}{:02}{:02}",
        d.year(), d.month(), d.day(), d.hour(), d.minute(), d.second()
    )
}

fn safe_file_name_part(input: &str) -> String {
    let mut folded = String::new();
    let mut prev_dash = false;
    for c in input.trim().chars() {
        if c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-' {
            folded.push(c);
            prev_dash = false;
        } else if !prev_dash {
            folded.push('-');
            prev_dash = true;
        }
    }
    let clipped: String = folded.trim_matches('-').chars().take(48).collect();
    if clipped.is_empty() { "device".to_string() } else { clipped }
}

fn hostname() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "device".to_string())
}

fn backup_name(device_name: &str) -> String {
    format!("weeklog-{}-{}.json.gz", safe_file_name_part(device_name), compact_timestamp())
}

fn parse_backup_name(name: &str) -> (String, String) {
    // 返回 (deviceName, createdAt)
    static RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^weeklog-(.+)-(\d{8}-\d{6})\.json\.gz$").unwrap());
    if let Some(c) = RE.captures(name) {
        let ts = &c[2];
        let created = format!(
            "{}-{}-{}T{}:{}:{}.000Z",
            &ts[0..4], &ts[4..6], &ts[6..8], &ts[9..11], &ts[11..13], &ts[13..15]
        );
        (c[1].replace('-', " "), created)
    } else {
        (String::new(), String::new())
    }
}

// ── gzip ──

fn gzip(data: &[u8]) -> Vec<u8> {
    let mut e = GzEncoder::new(Vec::new(), Compression::default());
    let _ = e.write_all(data);
    e.finish().unwrap_or_default()
}

fn gunzip(data: &[u8]) -> WebResult<Vec<u8>> {
    let mut d = GzDecoder::new(data);
    let mut out = Vec::new();
    d.read_to_end(&mut out).map_err(|e| format!("解压失败：{e}"))?;
    Ok(out)
}

// ── 目录树读取（备份用）──

fn read_tree_files(base_dir: &Path, rel_prefix: &str, ext: Option<&str>, out: &mut HashMap<String, String>) {
    if !base_dir.exists() {
        return;
    }
    fn walk(dir: &Path, base: &Path, prefix: &str, ext: Option<&str>, out: &mut HashMap<String, String>) {
        let entries = match fs::read_dir(dir) {
            Ok(e) => e,
            Err(_) => return,
        };
        for ent in entries.flatten() {
            let p = ent.path();
            if p.is_dir() {
                walk(&p, base, prefix, ext, out);
            } else {
                let ok = match ext {
                    Some(e) => p.file_name().and_then(|n| n.to_str()).map(|n| n.ends_with(e)).unwrap_or(false),
                    None => true,
                };
                if ok {
                    if let (Ok(rel), Ok(text)) = (p.strip_prefix(base), fs::read_to_string(&p)) {
                        let rel_str = rel.components().map(|c| c.as_os_str().to_string_lossy()).collect::<Vec<_>>().join("/");
                        out.insert(format!("{prefix}/{rel_str}"), text);
                    }
                }
            }
        }
    }
    walk(base_dir, base_dir, rel_prefix, ext, out);
}

/// 构建备份载荷（对齐 createBackupPayload）：{ manifest, files }。
fn create_backup_payload(cfg: &Value, base_dir: &Path, device_name: &str, app_version: &str) -> Value {
    let mut files: HashMap<String, String> = HashMap::new();
    let notes_dir = notes_dir_from_config(cfg, base_dir);
    read_tree_files(&notes_dir, NOTES_DIR, Some(".md"), &mut files);
    read_tree_files(&base_dir.join(MEMORY_ENTRIES_DIR), MEMORY_ENTRIES_DIR, Some(".md"), &mut files);
    for rel in [format!("{MEMORY_DIR}/index.json"), "history.json".to_string()] {
        if let Ok(text) = fs::read_to_string(base_dir.join(&rel)) {
            files.insert(rel, text);
        }
    }
    if let Ok(text) = fs::read_to_string(base_dir.join("config.json")) {
        if let Ok(parsed) = serde_json::from_str::<Value>(&text) {
            if let Ok(s) = serde_json::to_string_pretty(&pick_config_for_backup(&parsed)) {
                files.insert("config.json".to_string(), s);
            }
        }
    }
    let manifest = json!({
        "schemaVersion": 1,
        "createdAt": iso_now(),
        "deviceName": if device_name.is_empty() { hostname() } else { device_name.to_string() },
        "appVersion": app_version,
        "fileCount": files.len(),
    });
    json!({ "manifest": manifest, "files": files })
}

// ── 按 id 并集合并 JSON ──

fn item_key(item: &Value, id_field: &str) -> String {
    item.get(id_field)
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| item.to_string())
}

fn item_timestamp(item: &Value) -> String {
    for k in ["updatedAt", "_updatedAt", "createdAt"] {
        if let Some(s) = item.get(k).and_then(|v| v.as_str()) {
            return s.to_string();
        }
    }
    String::new()
}

/// 返回 (合并后数组, pulled 计数)，对齐 mergeJsonArraysById（保持本地顺序 + 远端新增/更新）。
fn merge_json_arrays_by_id(local: &[Value], remote: &[Value], id_field: &str) -> (Vec<Value>, usize) {
    let mut order: Vec<String> = Vec::new();
    let mut map: HashMap<String, Value> = HashMap::new();
    for it in local {
        let k = item_key(it, id_field);
        if !map.contains_key(&k) {
            order.push(k.clone());
        }
        map.insert(k, it.clone());
    }
    let mut pulled = 0;
    for it in remote {
        let k = item_key(it, id_field);
        match map.get(&k) {
            None => {
                order.push(k.clone());
                map.insert(k, it.clone());
                pulled += 1;
            }
            Some(existing) => {
                let lu = item_timestamp(existing);
                let ru = item_timestamp(it);
                if !ru.is_empty() && (lu.is_empty() || ru > lu) {
                    map.insert(k, it.clone());
                    pulled += 1;
                }
            }
        }
    }
    let out = order.into_iter().filter_map(|k| map.get(&k).cloned()).collect();
    (out, pulled)
}

fn parse_json_array(raw: &str) -> Vec<Value> {
    serde_json::from_str::<Value>(raw)
        .ok()
        .and_then(|v| v.as_array().cloned())
        .unwrap_or_default()
}

fn want_pull(d: &str) -> bool {
    d == "pull" || d == "both"
}
fn want_push(d: &str) -> bool {
    d == "push" || d == "both"
}

// ── 同步单文件（last-write-wins）──

async fn sync_file(client: &reqwest::Client, remote_url: &str, local_path: &Path, creds: &Creds, direction: &str) -> WebResult<&'static str> {
    let local = read_local_file(local_path);
    let mut remote: Option<String> = None;
    let mut remote_checked = false;
    let mut result: &'static str = "noop";

    if want_pull(direction) {
        remote = dav_get(client, remote_url, creds).await?;
        remote_checked = true;
        if let Some(ref r) = remote {
            match &local {
                None => {
                    write_local_file(local_path, r)?;
                    result = "pulled";
                }
                Some(l) if r != l => {
                    write_local_file(local_path, r)?;
                    result = "pulled";
                }
                _ => {}
            }
        }
    }

    if want_push(direction) && result != "pulled" {
        if !remote_checked {
            remote = dav_get(client, remote_url, creds).await?;
        }
        if let Some(l) = &local {
            if remote.as_deref() != Some(l.as_str()) {
                dav_put(client, remote_url, creds, l.clone().into_bytes(), "text/plain; charset=utf-8").await?;
                result = "pushed";
            }
        }
    }
    Ok(result)
}

async fn sync_directory(client: &reqwest::Client, remote_base: &str, local_dir: &Path, creds: &Creds, direction: &str, ext: &str) -> (usize, usize) {
    let mut pulled = 0;
    let mut pushed = 0;
    let mut remote_files: Vec<String> = Vec::new();
    match propfind(client, remote_base, creds).await {
        Ok(items) => {
            for i in items {
                if !i.is_collection && i.display_name.ends_with(ext) {
                    remote_files.push(i.display_name);
                }
            }
        }
        Err(_) => {
            if want_push(direction) {
                let _ = ensure_collection(client, remote_base, creds).await;
            }
        }
    }
    let mut local_files: Vec<String> = Vec::new();
    if let Ok(rd) = fs::read_dir(local_dir) {
        for ent in rd.flatten() {
            if let Some(name) = ent.file_name().to_str() {
                if name.ends_with(ext) {
                    local_files.push(name.to_string());
                }
            }
        }
    }
    let names: BTreeSet<String> = remote_files.into_iter().chain(local_files).collect();
    for name in names {
        let remote = join_url(remote_base, &percent_encode(&name));
        let local = local_dir.join(&name);
        match sync_file(client, &remote, &local, creds, direction).await {
            Ok("pulled") => pulled += 1,
            Ok("pushed") => pushed += 1,
            _ => {}
        }
    }
    (pulled, pushed)
}

async fn sync_merged_json(client: &reqwest::Client, remote_url: &str, local_path: &Path, creds: &Creds, direction: &str, id_field: &str) -> WebResult<(usize, usize)> {
    let mut pushed = 0;
    let local_arr = read_local_file(local_path).map(|s| parse_json_array(&s)).unwrap_or_default();

    let mut remote_arr: Vec<Value> = Vec::new();
    if want_pull(direction) {
        if let Some(raw) = dav_get(client, remote_url, creds).await? {
            remote_arr = parse_json_array(&raw);
        }
    }
    let (out, pulled) = merge_json_arrays_by_id(&local_arr, &remote_arr, id_field);
    if pulled > 0 && want_pull(direction) {
        write_local_file(local_path, &serde_json::to_string_pretty(&out).unwrap_or_default())?;
    }
    if want_push(direction) {
        let remote_existing = match dav_get(client, remote_url, creds).await? {
            Some(raw) => parse_json_array(&raw),
            None => Vec::new(),
        };
        let out_str = serde_json::to_string_pretty(&out).unwrap_or_default();
        let existing_str = serde_json::to_string_pretty(&remote_existing).unwrap_or_default();
        if out.len() != remote_existing.len() || out_str != existing_str {
            dav_put(client, remote_url, creds, out_str.into_bytes(), "text/plain; charset=utf-8").await?;
            pushed = out.len().saturating_sub(remote_existing.len());
        }
    }
    Ok((pulled, pushed))
}

async fn sync_config(client: &reqwest::Client, remote_url: &str, local_path: &Path, creds: &Creds, direction: &str) -> WebResult<(usize, usize)> {
    let mut pulled = 0;
    let mut pushed = 0;
    let mut local_cfg = read_local_file(local_path)
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .unwrap_or_else(|| json!({}));

    let mut remote_cfg: Option<Value> = None;
    if want_pull(direction) {
        if let Some(raw) = dav_get(client, remote_url, creds).await? {
            remote_cfg = serde_json::from_str::<Value>(&raw).ok();
        }
    }
    if let Some(rc) = &remote_cfg {
        for field in CONFIG_SYNC_FIELDS {
            if let Some(v) = get_by_path(rc, field) {
                set_by_path(&mut local_cfg, field, v.clone());
                pulled += 1;
            }
        }
        write_local_file(local_path, &serde_json::to_string_pretty(&local_cfg).unwrap_or_default())?;
    }
    if want_push(direction) {
        let mut remote_base = match &remote_cfg {
            Some(rc) => rc.clone(),
            None => match dav_get(client, remote_url, creds).await? {
                Some(raw) => serde_json::from_str::<Value>(&raw).unwrap_or_else(|_| json!({})),
                None => json!({}),
            },
        };
        let mut changed = false;
        for field in CONFIG_SYNC_FIELDS {
            if let Some(v) = get_by_path(&local_cfg, field) {
                let cur = get_by_path(&remote_base, field);
                if cur.map(|c| c.to_string()) != Some(v.to_string()) {
                    set_by_path(&mut remote_base, field, v.clone());
                    changed = true;
                    pushed += 1;
                }
            }
        }
        if changed {
            dav_put(client, remote_url, creds, serde_json::to_string_pretty(&remote_base).unwrap_or_default().into_bytes(), "text/plain; charset=utf-8").await?;
        }
    }
    Ok((pulled, pushed))
}

fn format_connection_error(raw: &str) -> String {
    if Regex::new(r"\b401\b").unwrap().is_match(raw) {
        "WebDAV 连接失败：认证失败（401），请检查用户名或密码".to_string()
    } else if Regex::new(r"\b403\b").unwrap().is_match(raw) {
        "WebDAV 连接失败：没有访问权限（403），请检查账号权限或目录授权".to_string()
    } else if Regex::new(r"\b404\b").unwrap().is_match(raw) {
        "WebDAV 连接失败：远端路径不存在（404）且无法自动创建，请检查服务器 URL".to_string()
    } else {
        format!("WebDAV 连接失败：{raw}")
    }
}

// ── 对外：测试连接 / 同步 / 备份 / 列表 / 恢复 ──

fn client() -> reqwest::Client {
    reqwest::Client::new()
}

/// 对齐 testConnection。
pub async fn test_connection(url: &str, username: &str, password: &str) -> Value {
    let base = match normalize_webdav_base_url(url) {
        Ok(b) => b,
        Err(e) => return json!({ "ok": false, "message": e }),
    };
    let creds = Creds { username: username.to_string(), password: password.to_string() };
    let c = client();
    match propfind(&c, &base, &creds).await {
        Ok(items) => {
            let _ = ensure_collection(&c, &join_url(&base, &format!("{BACKUPS_DIR}/")), &creds).await;
            json!({ "ok": true, "message": format!("连接成功，远端有 {} 个项目", items.len()) })
        }
        Err(e) => {
            if e.contains("404") {
                match ensure_collection(&c, &base, &creds).await {
                    Ok(created) => {
                        if created {
                            json!({ "ok": true, "message": format!("连接成功，已自动创建远端目录 {base}") })
                        } else {
                            match propfind(&c, &base, &creds).await {
                                Ok(items) => {
                                    let _ = ensure_collection(&c, &join_url(&base, &format!("{BACKUPS_DIR}/")), &creds).await;
                                    json!({ "ok": true, "message": format!("连接成功，远端有 {} 个项目", items.len()) })
                                }
                                Err(e2) => json!({ "ok": false, "message": format!("目标目录不存在且自动创建失败：{e2}") }),
                            }
                        }
                    }
                    Err(e2) => json!({ "ok": false, "message": format!("目标目录不存在且自动创建失败：{e2}") }),
                }
            } else {
                json!({ "ok": false, "message": e })
            }
        }
    }
}

/// 对齐 syncAll。返回 { pulled, pushed, errors }。
pub async fn sync_all(cfg: &Value, dir: &Path, password: &str, direction: &str) -> WebResult<Value> {
    let wcfg = &cfg["webdav"];
    let base = normalize_webdav_base_url(wcfg["url"].as_str().unwrap_or(""))?;
    let creds = Creds {
        username: wcfg["username"].as_str().unwrap_or("").to_string(),
        password: password.to_string(),
    };
    let c = client();
    let mut pulled = 0usize;
    let mut pushed = 0usize;
    let mut errors: Vec<String> = Vec::new();

    // 确保远端目录结构
    if let Err(e) = async {
        ensure_collection(&c, &base, &creds).await?;
        ensure_collection(&c, &join_url(&base, NOTES_DIR), &creds).await?;
        ensure_collection(&c, &join_url(&base, MEMORY_DIR), &creds).await?;
        ensure_collection(&c, &join_url(&base, MEMORY_ENTRIES_DIR), &creds).await?;
        Ok::<(), String>(())
    }
    .await
    {
        let message = format_connection_error(&e);
        write_status(dir, &json!({ "lastSync": iso_now(), "direction": direction, "pulled": 0, "pushed": 0, "errors": [message.clone()] }));
        return Err(message);
    }

    // 1. notes/
    let (p, q) = sync_directory(&c, &join_url(&base, NOTES_DIR), &dir.join(NOTES_DIR), &creds, direction, ".md").await;
    pulled += p;
    pushed += q;
    // 2. memory/entries/
    let (p, q) = sync_directory(&c, &join_url(&base, MEMORY_ENTRIES_DIR), &dir.join(MEMORY_ENTRIES_DIR), &creds, direction, ".md").await;
    pulled += p;
    pushed += q;
    // 3. memory/index.json（按 id 并集）
    match sync_merged_json(&c, &join_url(&base, &format!("{MEMORY_DIR}/index.json")), &dir.join(MEMORY_DIR).join("index.json"), &creds, direction, "id").await {
        Ok((p, q)) => { pulled += p; pushed += q; }
        Err(e) => errors.push(format!("memory/index.json 同步失败：{e}")),
    }
    // 4. history.json（按 id 并集）
    match sync_merged_json(&c, &join_url(&base, "history.json"), &dir.join("history.json"), &creds, direction, "id").await {
        Ok((p, q)) => { pulled += p; pushed += q; }
        Err(e) => errors.push(format!("history.json 同步失败：{e}")),
    }
    // 5. config.json（白名单合并）
    match sync_config(&c, &join_url(&base, "config.json"), &dir.join("config.json"), &creds, direction).await {
        Ok((p, q)) => { pulled += p; pushed += q; }
        Err(e) => errors.push(format!("config.json 同步失败：{e}")),
    }

    let result = json!({ "pulled": pulled, "pushed": pushed, "errors": errors });
    write_status(dir, &json!({ "lastSync": iso_now(), "direction": direction, "pulled": pulled, "pushed": pushed, "errors": errors }));
    Ok(result)
}

async fn list_backups_inner(c: &reqwest::Client, base: &str, creds: &Creds) -> WebResult<Vec<Value>> {
    let remote_base = join_url(base, &format!("{BACKUPS_DIR}/"));
    let items = match propfind(c, &remote_base, creds).await {
        Ok(items) => items,
        Err(e) => {
            if e.contains("404") {
                let _ = ensure_collection(c, &remote_base, creds).await;
                return Ok(Vec::new());
            }
            return Err(e);
        }
    };
    let mut out: Vec<Value> = items
        .into_iter()
        .filter(|i| !i.is_collection && i.display_name.ends_with(".json.gz"))
        .map(|i| {
            let (device_name, created_at) = parse_backup_name(&i.display_name);
            json!({
                "name": i.display_name,
                "deviceName": device_name,
                "createdAt": created_at,
                "size": i.size,
                "lastModified": i.last_modified,
            })
        })
        .collect();
    // 按 createdAt/lastModified/name 倒序
    out.sort_by(|a, b| {
        let va = a["createdAt"].as_str().filter(|s| !s.is_empty()).or_else(|| a["lastModified"].as_str()).unwrap_or("");
        let vb = b["createdAt"].as_str().filter(|s| !s.is_empty()).or_else(|| b["lastModified"].as_str()).unwrap_or("");
        vb.cmp(va)
    });
    Ok(out)
}

pub async fn list_backups(cfg: &Value, password: &str) -> WebResult<Vec<Value>> {
    let wcfg = &cfg["webdav"];
    let base = normalize_webdav_base_url(wcfg["url"].as_str().unwrap_or(""))?;
    let creds = Creds { username: wcfg["username"].as_str().unwrap_or("").to_string(), password: password.to_string() };
    list_backups_inner(&client(), &base, &creds).await
}

/// 对齐 createBackup：gzip JSON 载荷 PUT 到 backups/，并按保留数 prune。
pub async fn create_backup(cfg: &Value, dir: &Path, password: &str, app_version: &str) -> WebResult<Value> {
    let wcfg = &cfg["webdav"];
    let base = normalize_webdav_base_url(wcfg["url"].as_str().unwrap_or(""))?;
    let creds = Creds { username: wcfg["username"].as_str().unwrap_or("").to_string(), password: password.to_string() };
    let retention = wcfg["backupRetention"].as_u64().filter(|n| *n >= 1).unwrap_or(DEFAULT_BACKUP_RETENTION);
    let c = client();
    let remote_backups = join_url(&base, &format!("{BACKUPS_DIR}/"));
    let device = hostname();
    let name = backup_name(&device);
    let remote_url = join_url(&remote_backups, &percent_encode(&name));

    ensure_collection(&c, &base, &creds).await?;
    ensure_collection(&c, &remote_backups, &creds).await?;
    let payload = create_backup_payload(cfg, dir, &device, app_version);
    let body = gzip(serde_json::to_string(&payload).unwrap_or_default().as_bytes());
    let bytes = body.len();
    dav_put(&c, &remote_url, &creds, body, "application/gzip").await?;

    // prune：保留最近 retention 个
    let mut backups = list_backups_inner(&c, &base, &creds).await.unwrap_or_default();
    if !backups.iter().any(|b| b["name"].as_str() == Some(name.as_str())) {
        backups.insert(0, json!({ "name": name, "createdAt": payload["manifest"]["createdAt"] }));
        backups.sort_by(|a, b| {
            let va = a["createdAt"].as_str().unwrap_or("");
            let vb = b["createdAt"].as_str().unwrap_or("");
            vb.cmp(va)
        });
    }
    let keep = retention.max(1) as usize;
    let mut pruned = 0;
    for item in backups.iter().skip(keep) {
        if let Some(n) = item["name"].as_str() {
            if dav_delete(&c, &join_url(&base, &format!("{BACKUPS_DIR}/{}", percent_encode(n))), &creds).await.is_ok() {
                pruned += 1;
            }
        }
    }

    let file_count = payload["files"].as_object().map(|o| o.len()).unwrap_or(0);
    let result = json!({ "name": name, "remoteUrl": remote_url, "bytes": bytes, "fileCount": file_count, "pruned": pruned });
    write_status(dir, &json!({ "lastBackup": iso_now(), "direction": "backup", "pulled": 0, "pushed": 1, "errors": [], "backup": result.clone() }));
    Ok(result)
}

fn restore_payload_to_local(payload: &Value, cfg: &Value, dir: &Path) -> WebResult<(usize, Value)> {
    let manifest = &payload["manifest"];
    if manifest["schemaVersion"].as_i64() != Some(1) || !payload["files"].is_object() {
        return Err("备份文件格式无效".to_string());
    }
    let mut restored = 0;
    let notes_dir = notes_dir_from_config(cfg, dir);
    for (rel, content) in payload["files"].as_object().unwrap() {
        let content_str = content.as_str().unwrap_or("");
        if let Some(sub) = rel.strip_prefix(&format!("{NOTES_DIR}/")) {
            write_local_file(&notes_dir.join(sub), content_str)?;
            restored += 1;
        } else if rel.starts_with(&format!("{MEMORY_ENTRIES_DIR}/")) {
            write_local_file(&dir.join(rel), content_str)?;
            restored += 1;
        } else if rel == &format!("{MEMORY_DIR}/index.json") || rel == "history.json" {
            write_local_file(&dir.join(rel), content_str)?;
            restored += 1;
        } else if rel == "config.json" {
            let current_path = dir.join("config.json");
            let mut current = fs::read_to_string(&current_path).ok().and_then(|s| serde_json::from_str::<Value>(&s).ok()).unwrap_or_else(|| json!({}));
            let backup_cfg: Value = serde_json::from_str(content_str).unwrap_or_else(|_| json!({}));
            for field in CONFIG_SYNC_FIELDS {
                if let Some(v) = get_by_path(&backup_cfg, field) {
                    set_by_path(&mut current, field, v.clone());
                }
            }
            write_local_file(&current_path, &serde_json::to_string_pretty(&current).unwrap_or_default())?;
            restored += 1;
        }
    }
    Ok((restored, manifest.clone()))
}

/// 对齐 restoreBackup：先写本地安全备份，再 GET+gunzip+恢复。
pub async fn restore_backup(cfg: &Value, dir: &Path, password: &str, name: &str) -> WebResult<Value> {
    static RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[^/\\]+\.json\.gz$").unwrap());
    if !RE.is_match(name) {
        return Err("备份文件名无效".to_string());
    }
    let wcfg = &cfg["webdav"];
    let base = normalize_webdav_base_url(wcfg["url"].as_str().unwrap_or(""))?;
    let creds = Creds { username: wcfg["username"].as_str().unwrap_or("").to_string(), password: password.to_string() };
    let remote_url = join_url(&base, &format!("{BACKUPS_DIR}/{}", percent_encode(name)));

    // 本地安全备份
    let safety = create_backup_payload(cfg, dir, &hostname(), "");
    let safety_dir = dir.join(BACKUPS_DIR);
    fs::create_dir_all(&safety_dir).map_err(|e| format!("创建安全备份目录失败：{e}"))?;
    let safety_name = format!("before-restore-{}.json.gz", compact_timestamp());
    let _ = fs::write(safety_dir.join(&safety_name), gzip(serde_json::to_string(&safety).unwrap_or_default().as_bytes()));

    let compressed = dav_get_buffer(&client(), &remote_url, &creds).await?;
    let payload: Value = serde_json::from_slice(&gunzip(&compressed)?).map_err(|e| format!("解析备份失败：{e}"))?;
    let (restored, manifest) = restore_payload_to_local(&payload, cfg, dir)?;
    write_status(dir, &json!({ "lastRestore": iso_now(), "direction": "restore", "pulled": restored, "pushed": 0, "errors": [], "restore": { "name": name, "safetyName": safety_name } }));
    Ok(json!({ "name": name, "safetyName": safety_name, "restoredFiles": restored, "manifest": manifest }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn private_hostname_detection_matches_js() {
        assert!(is_private_hostname("localhost"));
        assert!(is_private_hostname("127.0.0.1"));
        assert!(is_private_hostname("192.168.1.5"));
        assert!(is_private_hostname("10.0.0.1"));
        assert!(is_private_hostname("172.16.0.1"));
        assert!(is_private_hostname("169.254.1.1"));
        assert!(!is_private_hostname("dav.example.com"));
        assert!(!is_private_hostname("8.8.8.8"));
    }

    #[test]
    fn normalize_rejects_http_and_private() {
        assert!(normalize_webdav_base_url("http://dav.example.com/").is_err()); // 非 https
        assert!(normalize_webdav_base_url("https://localhost/dav/").is_err()); // 私网
        let ok = normalize_webdav_base_url("https://dav.example.com/remote.php/dav").unwrap();
        assert!(ok.ends_with('/')); // 补尾斜杠
    }

    #[test]
    fn merge_by_id_union_and_timestamp() {
        let local = vec![json!({"id": "a", "updatedAt": "2026-01-01"})];
        let remote = vec![
            json!({"id": "a", "updatedAt": "2026-02-01"}), // 更新
            json!({"id": "b", "updatedAt": "2026-01-01"}), // 新增
        ];
        let (out, pulled) = merge_json_arrays_by_id(&local, &remote, "id");
        assert_eq!(out.len(), 2);
        assert_eq!(pulled, 2);
        let a = out.iter().find(|v| v["id"] == "a").unwrap();
        assert_eq!(a["updatedAt"], "2026-02-01"); // 远端较新覆盖
    }

    #[test]
    fn parse_backup_name_extracts_device_and_time() {
        let (device, created) = parse_backup_name("weeklog-my-pc-20260619-143000.json.gz");
        assert_eq!(device, "my pc");
        assert_eq!(created, "2026-06-19T14:30:00.000Z");
    }

    #[test]
    fn gzip_roundtrip() {
        let data = b"hello webdav backup payload";
        let z = gzip(data);
        assert_eq!(gunzip(&z).unwrap(), data);
    }

    #[test]
    fn pick_config_whitelist_excludes_secrets() {
        let cfg = json!({ "weekStart": "monday", "ai": { "provider": "openai", "openai": { "model": "m", "apiKey": "SECRET" } }, "repos": [{"path": "/x"}] });
        let picked = pick_config_for_backup(&cfg);
        assert_eq!(picked["weekStart"], "monday");
        assert_eq!(picked["ai"]["openai"]["model"], "m");
        assert!(picked["ai"]["openai"].get("apiKey").is_none());
        assert!(picked.get("repos").is_none());
    }
}
