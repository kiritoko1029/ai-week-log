//! 本地备份：对齐 src/main/local-backup.js。
//! 把 notes / memory / history / config 打包成可移植 `.zip` 快照（**手写 ZIP 格式，零外部依赖**：
//! CRC32 + 本地文件头 + 中央目录 + 结束记录，stored 不压缩），写入系统下载目录或用户指定目录。
//! 与 WebDAV/云备份相互独立。

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use chrono::{DateTime, Datelike, Local, Timelike};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::config;

const NOTES_DIR: &str = "notes";
const MEMORY_DIR: &str = "memory";
const MEMORY_ENTRIES_DIR: &str = "memory/entries";

/// 备份保留的 config 字段路径（对齐 local-backup.js CONFIG_BACKUP_FIELDS）。
static CONFIG_BACKUP_FIELDS: &[&[&str]] = &[
    &["schemaVersion"],
    &["weekStart"],
    &["timezone"],
    &["dateBasis"],
    &["filters"],
    &["notes", "enabled"],
    &["notes", "miscProject"],
    &["mcp", "enabled"],
    &["mcp", "port"],
    &["noteSummary"],
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

/// 设备名清洗（对齐 safeFileNamePart）：保留 [a-zA-Z0-9._-]，去首尾 `-`，截断 48，空回退 device。
fn safe_file_name_part(input: &str) -> String {
    let trimmed = input.trim();
    let mut s: String = trimmed
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-' {
                c
            } else {
                ' ' // 标记为待折叠
            }
        })
        .collect();
    // 连续非法字符折叠为单个 '-'（对齐 /[^...]+/g → '-'）
    let mut folded = String::new();
    let mut prev_space = false;
    for c in s.drain(..) {
        if c == ' ' {
            if !prev_space {
                folded.push('-');
            }
            prev_space = true;
        } else {
            folded.push(c);
            prev_space = false;
        }
    }
    let trimmed_dash = folded.trim_matches('-');
    let clipped: String = trimmed_dash.chars().take(48).collect();
    if clipped.is_empty() {
        "device".to_string()
    } else {
        clipped
    }
}

/// 紧凑时间戳 `YYYYMMDD-HHMMSS`（本地时区，对齐 compactTimestamp）。
fn compact_timestamp(dt: &DateTime<Local>) -> String {
    format!(
        "{:04}{:02}{:02}-{:02}{:02}{:02}",
        dt.year(),
        dt.month(),
        dt.day(),
        dt.hour(),
        dt.minute(),
        dt.second()
    )
}

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

/// 抽取 config 的备份子集（对齐 pickConfigForBackup）。
fn pick_config_for_backup(cfg: &Value) -> Value {
    let mut out = json!({});
    for field in CONFIG_BACKUP_FIELDS {
        if let Some(v) = get_by_path(cfg, field) {
            set_by_path(&mut out, field, v.clone());
        }
    }
    out
}

/// notes 目录解析（对齐 getNotesDirFromConfig）：绝对→原样，相对→join(base)，缺省→base/notes。
fn notes_dir_from_config(cfg: &Value, base_dir: &Path) -> PathBuf {
    let d = cfg.get("notes").and_then(|n| n.get("dir")).and_then(|v| v.as_str());
    match d {
        Some(p) if !p.is_empty() && Path::new(p).is_absolute() => PathBuf::from(p),
        Some(p) if !p.is_empty() => base_dir.join(p),
        _ => base_dir.join(NOTES_DIR),
    }
}

/// 递归收集目录下文件（可选扩展名过滤），键为 `<rel_prefix>/<相对路径>`（正斜杠，对齐 readTreeFiles）。
fn read_tree_files(base_dir: &Path, rel_prefix: &str, ext: Option<&str>, out: &mut BTreeMap<String, Vec<u8>>) {
    if !base_dir.exists() {
        return;
    }
    fn walk(dir: &Path, base: &Path, prefix: &str, ext: Option<&str>, out: &mut BTreeMap<String, Vec<u8>>) {
        let entries = match fs::read_dir(dir) {
            Ok(e) => e,
            Err(_) => return,
        };
        for ent in entries.flatten() {
            let p = ent.path();
            if p.is_dir() {
                walk(&p, base, prefix, ext, out);
            } else {
                let name_ok = match ext {
                    Some(e) => p.file_name().and_then(|n| n.to_str()).map(|n| n.ends_with(e)).unwrap_or(false),
                    None => true,
                };
                if name_ok {
                    if let Ok(rel) = p.strip_prefix(base) {
                        let rel_str = rel.components()
                            .map(|c| c.as_os_str().to_string_lossy())
                            .collect::<Vec<_>>()
                            .join("/");
                        if let Ok(bytes) = fs::read(&p) {
                            out.insert(format!("{prefix}/{rel_str}"), bytes);
                        }
                    }
                }
            }
        }
    }
    walk(base_dir, base_dir, rel_prefix, ext, out);
}

/// 构建快照文件集（对齐 buildSnapshotFiles）。
fn build_snapshot_files(
    cfg: &Value,
    base_dir: &Path,
    device_name: &str,
    app_version: &str,
    now: &DateTime<Local>,
) -> BTreeMap<String, Vec<u8>> {
    let mut files: BTreeMap<String, Vec<u8>> = BTreeMap::new();

    let notes_dir = notes_dir_from_config(cfg, base_dir);
    read_tree_files(&notes_dir, NOTES_DIR, Some(".md"), &mut files);
    read_tree_files(&base_dir.join(MEMORY_ENTRIES_DIR), MEMORY_ENTRIES_DIR, Some(".md"), &mut files);

    for rel in [format!("{MEMORY_DIR}/index.json"), "history.json".to_string()] {
        let p = base_dir.join(&rel);
        if let Ok(bytes) = fs::read(&p) {
            files.insert(rel, bytes);
        }
    }

    let config_path = base_dir.join("config.json");
    if let Ok(text) = fs::read_to_string(&config_path) {
        if let Ok(parsed) = serde_json::from_str::<Value>(&text) {
            let picked = pick_config_for_backup(&parsed);
            if let Ok(s) = serde_json::to_string_pretty(&picked) {
                files.insert("config.json".to_string(), s.into_bytes());
            }
        }
    }

    let manifest = json!({
        "schemaVersion": 1,
        "createdAt": now.to_utc().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string(),
        "deviceName": device_name,
        "appVersion": app_version,
        "fileCount": files.len(),
        "format": "weeklog-local-backup-zip",
    });
    let manifest_str = serde_json::to_string_pretty(&manifest).unwrap_or_else(|_| "{}".to_string());
    files.insert("manifest.json".to_string(), manifest_str.into_bytes());
    files
}

// ── CRC32（对齐 makeCrc32Table / crc32）──

static CRC32_TABLE: LazyLock<[u32; 256]> = LazyLock::new(|| {
    let mut table = [0u32; 256];
    for (i, slot) in table.iter_mut().enumerate() {
        let mut c = i as u32;
        for _ in 0..8 {
            c = if c & 1 != 0 { 0xedb8_8320 ^ (c >> 1) } else { c >> 1 };
        }
        *slot = c;
    }
    table
});

fn crc32(buf: &[u8]) -> u32 {
    let mut c: u32 = 0xffff_ffff;
    for &b in buf {
        c = CRC32_TABLE[((c ^ b as u32) & 0xff) as usize] ^ (c >> 8);
    }
    c ^ 0xffff_ffff
}

/// DOS 日期/时间（对齐 dosDateTime）。
fn dos_date_time(dt: &DateTime<Local>) -> (u16, u16) {
    let year = dt.year().max(1980);
    let dos_time = ((dt.hour() << 11) | (dt.minute() << 5) | (dt.second() / 2)) as u16;
    let dos_date = (((year - 1980) << 9) as u32 | (dt.month() << 5) | dt.day()) as u16;
    (dos_time, dos_date)
}

/// 手写 ZIP（stored 不压缩，对齐 createZipBuffer）。files 已按名排序（BTreeMap）。
fn create_zip_buffer(files: &BTreeMap<String, Vec<u8>>, dt: &DateTime<Local>) -> Vec<u8> {
    let (dos_time, dos_date) = dos_date_time(dt);
    let mut local_blob: Vec<u8> = Vec::new();
    let mut central_blob: Vec<u8> = Vec::new();
    let mut offset: u32 = 0;

    for (name, data) in files {
        let file_name = name.as_bytes();
        let crc = crc32(data);
        let dlen = data.len() as u32;
        let nlen = file_name.len() as u16;

        // 本地文件头（30 字节）
        let mut local: Vec<u8> = Vec::with_capacity(30);
        local.extend_from_slice(&0x0403_4b50u32.to_le_bytes());
        local.extend_from_slice(&20u16.to_le_bytes()); // version
        local.extend_from_slice(&0u16.to_le_bytes()); // flags
        local.extend_from_slice(&0u16.to_le_bytes()); // method=stored
        local.extend_from_slice(&dos_time.to_le_bytes());
        local.extend_from_slice(&dos_date.to_le_bytes());
        local.extend_from_slice(&crc.to_le_bytes());
        local.extend_from_slice(&dlen.to_le_bytes()); // comp size
        local.extend_from_slice(&dlen.to_le_bytes()); // uncomp size
        local.extend_from_slice(&nlen.to_le_bytes());
        local.extend_from_slice(&0u16.to_le_bytes()); // extra len
        local_blob.extend_from_slice(&local);
        local_blob.extend_from_slice(file_name);
        local_blob.extend_from_slice(data);

        // 中央目录（46 字节）
        let mut central: Vec<u8> = Vec::with_capacity(46);
        central.extend_from_slice(&0x0201_4b50u32.to_le_bytes());
        central.extend_from_slice(&20u16.to_le_bytes()); // version made by
        central.extend_from_slice(&20u16.to_le_bytes()); // version needed
        central.extend_from_slice(&0u16.to_le_bytes()); // flags
        central.extend_from_slice(&0u16.to_le_bytes()); // method
        central.extend_from_slice(&dos_time.to_le_bytes());
        central.extend_from_slice(&dos_date.to_le_bytes());
        central.extend_from_slice(&crc.to_le_bytes());
        central.extend_from_slice(&dlen.to_le_bytes());
        central.extend_from_slice(&dlen.to_le_bytes());
        central.extend_from_slice(&nlen.to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes()); // extra len
        central.extend_from_slice(&0u16.to_le_bytes()); // comment len
        central.extend_from_slice(&0u16.to_le_bytes()); // disk num
        central.extend_from_slice(&0u16.to_le_bytes()); // internal attr
        central.extend_from_slice(&0u32.to_le_bytes()); // external attr
        central.extend_from_slice(&offset.to_le_bytes()); // local header offset
        central_blob.extend_from_slice(&central);
        central_blob.extend_from_slice(file_name);

        offset += 30 + nlen as u32 + dlen;
    }

    let central_size = central_blob.len() as u32;
    let central_offset = offset;
    let count = files.len() as u16;

    let mut end: Vec<u8> = Vec::with_capacity(22);
    end.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
    end.extend_from_slice(&0u16.to_le_bytes()); // disk num
    end.extend_from_slice(&0u16.to_le_bytes()); // disk start
    end.extend_from_slice(&count.to_le_bytes()); // entries on disk
    end.extend_from_slice(&count.to_le_bytes()); // entries total
    end.extend_from_slice(&central_size.to_le_bytes());
    end.extend_from_slice(&central_offset.to_le_bytes());
    end.extend_from_slice(&0u16.to_le_bytes()); // comment len

    let mut out = Vec::with_capacity(local_blob.len() + central_blob.len() + end.len());
    out.extend_from_slice(&local_blob);
    out.extend_from_slice(&central_blob);
    out.extend_from_slice(&end);
    out
}

/// 主机名（对齐 os.hostname() 的近似）：Windows COMPUTERNAME / Unix HOSTNAME，回退 device。
fn hostname() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "device".to_string())
}

/// 创建本地备份并写盘（对齐 createLocalBackup）。返回 { name, filePath, bytes, fileCount }。
fn create_local_backup(
    cfg: &Value,
    base_dir: &Path,
    downloads_dir: &Path,
    device_name: &str,
    app_version: &str,
    now: &DateTime<Local>,
) -> Result<Value, String> {
    fs::create_dir_all(downloads_dir).map_err(|e| format!("创建下载目录失败：{e}"))?;
    let name = format!(
        "weeklog-{}-{}.zip",
        safe_file_name_part(device_name),
        compact_timestamp(now)
    );
    let file_path = downloads_dir.join(&name);
    let files = build_snapshot_files(cfg, base_dir, device_name, app_version, now);
    let file_count = files.len();
    let zip = create_zip_buffer(&files, now);
    let bytes = zip.len();
    fs::write(&file_path, &zip).map_err(|e| format!("写入备份失败：{e}"))?;
    Ok(json!({
        "name": name,
        "filePath": file_path.to_string_lossy(),
        "bytes": bytes,
        "fileCount": file_count,
    }))
}

/// Tauri 命令包装（对齐 ipc.js localBackup:create）。dir 为用户指定目录，缺省用系统下载目录。
pub fn create_cmd(app: &AppHandle, dir: Option<String>) -> Result<Value, String> {
    let cfg = config::load_config(app);
    let base_dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("无法定位配置目录：{e}"))?;
    let downloads_dir = match dir {
        Some(d) if !d.trim().is_empty() => PathBuf::from(d),
        _ => app
            .path()
            .download_dir()
            .map_err(|e| format!("未找到系统下载目录：{e}"))?,
    };
    let app_version = app.package_info().version.to_string();
    let now = Local::now();
    create_local_backup(&cfg, &base_dir, &downloads_dir, &hostname(), &app_version, &now)
}

#[cfg(test)]
mod tests {
    //! CRC32 用标准测试向量；ZIP/快照结构对齐 local-backup.js 的 `_test` 导出行为。
    use super::*;

    #[test]
    fn crc32_known_vectors() {
        // 标准 CRC-32（IEEE）测试向量
        assert_eq!(crc32(b""), 0x0000_0000);
        assert_eq!(crc32(b"123456789"), 0xCBF4_3926);
        assert_eq!(crc32(b"The quick brown fox jumps over the lazy dog"), 0x414F_A339);
    }

    #[test]
    fn safe_file_name_part_sanitizes() {
        assert_eq!(safe_file_name_part("My PC 笔记本"), "My-PC");
        assert_eq!(safe_file_name_part("  ---  "), "device");
        assert_eq!(safe_file_name_part(""), "device");
        assert_eq!(safe_file_name_part("host.name_1-2"), "host.name_1-2");
    }

    #[test]
    fn pick_config_keeps_only_whitelisted() {
        let cfg = json!({
            "weekStart": "monday",
            "ai": { "provider": "anthropic", "anthropic": { "model": "m", "apiKey": "SECRET" } },
            "secretField": "should-not-appear",
        });
        let picked = pick_config_for_backup(&cfg);
        assert_eq!(picked["weekStart"], "monday");
        assert_eq!(picked["ai"]["provider"], "anthropic");
        assert_eq!(picked["ai"]["anthropic"]["model"], "m");
        // 未列入白名单的字段（含 apiKey）不应出现
        assert!(picked["ai"]["anthropic"].get("apiKey").is_none());
        assert!(picked.get("secretField").is_none());
    }

    #[test]
    fn zip_buffer_has_valid_signatures_and_eocd() {
        let mut files = BTreeMap::new();
        files.insert("a.txt".to_string(), b"hello".to_vec());
        files.insert("b.txt".to_string(), b"world!!".to_vec());
        let dt = Local::now();
        let zip = create_zip_buffer(&files, &dt);
        // 本地文件头签名
        assert_eq!(&zip[0..4], &0x0403_4b50u32.to_le_bytes());
        // 结束记录签名在末尾 22 字节处
        let eocd = &zip[zip.len() - 22..];
        assert_eq!(&eocd[0..4], &0x0605_4b50u32.to_le_bytes());
        // entries total = 2
        assert_eq!(u16::from_le_bytes([eocd[10], eocd[11]]), 2);
    }
}
