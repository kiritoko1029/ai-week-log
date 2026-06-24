//! Codex / ZCode hook 子系统（忠实移植 src/main/{codex,zcode}-*.js）。
//!
//! 三层：
//!  1. 待处理小记池（codex-notes-pending.json / zcode-notes-pending.json）：hook 只写候选，
//!     正式写入 notes/YYYY-MM-DD.md 必须由用户在前端确认。
//!  2. hook-config 安装器：Codex 用单一 ~/.codex/hooks.json；ZCode 用 ~/.zcode 插件包系统。
//!  3. 本地 HTTP 入口（tiny_http，仅绑 127.0.0.1 + Bearer token + 256K 上限）。
//!
//! 关键：注入到 Codex/ZCode 的 hook 脚本是 **Node 脚本**，由它们各自的运行时执行，
//! 与本后端语言无关，故此处只把脚本作为字符串模板原样生成（注入 endpoint + token）。

use std::collections::HashSet;
use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

use base64::Engine as _;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::{config, llm, notes, secrets, utils};

const MAX_BODY_BYTES: usize = 256 * 1024;
const MAX_SUMMARY_CHARS: usize = 4000;

/// hook 种类。两端在池/服务器/路由上对称，仅常量不同；hook-config 安装逻辑各异。
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum HookKind {
    Codex,
    Zcode,
}

impl HookKind {
    fn store_file(self) -> &'static str {
        match self {
            HookKind::Codex => "codex-notes-pending.json",
            HookKind::Zcode => "zcode-notes-pending.json",
        }
    }
    fn id_prefix(self) -> &'static str {
        match self {
            HookKind::Codex => "cpn_",
            HookKind::Zcode => "zpn_",
        }
    }
    fn source(self) -> &'static str {
        match self {
            HookKind::Codex => "codex",
            HookKind::Zcode => "zcode",
        }
    }
    /// 中文/界面里的展示名（"Codex" / "ZCode"），用于提示语与 system prompt。
    fn label(self) -> &'static str {
        match self {
            HookKind::Codex => "Codex",
            HookKind::Zcode => "ZCode",
        }
    }
    fn default_port(self) -> u16 {
        match self {
            HookKind::Codex => 17321,
            HookKind::Zcode => 17322,
        }
    }
    fn route(self) -> &'static str {
        match self {
            HookKind::Codex => "/api/codex/pending-notes",
            HookKind::Zcode => "/api/zcode/pending-notes",
        }
    }
    /// 既是 secrets 的 provider 名，也是 config 字段名（cfg.codexHook / cfg.zcodeHook）。
    fn provider(self) -> &'static str {
        match self {
            HookKind::Codex => "codexHook",
            HookKind::Zcode => "zcodeHook",
        }
    }
}

// ── summary 清洗（对齐 {codex,zcode}-summary.js）──

static RE_OAI: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"(?s)<oai-mem-citation>.*?</oai-mem-citation>").unwrap());
static RE_SYSREM: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"(?s)<system-reminder>.*?</system-reminder>").unwrap());
static RE_THINK: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"(?s)<think>.*?</think>").unwrap());
static RE_BEARER: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"(?i)^Bearer\s+(.+)$").unwrap());

fn strip_metadata(kind: HookKind, text: &str) -> String {
    let mut s = RE_OAI.replace_all(text, "").into_owned();
    if kind == HookKind::Zcode {
        // ZCode/Claude Code 风格的 citation / thinking 块清理
        s = RE_SYSREM.replace_all(&s, "").into_owned();
        s = RE_THINK.replace_all(&s, "").into_owned();
    }
    s.trim().to_string()
}

/// 清洗 + 截断到 MAX_SUMMARY_CHARS（对齐 trimSummary：超长则 slice(0,N-1)+'…'）。
fn sanitize_summary(kind: HookKind, text: &str) -> String {
    let s = strip_metadata(kind, text);
    if s.chars().count() <= MAX_SUMMARY_CHARS {
        s
    } else {
        let truncated: String = s.chars().take(MAX_SUMMARY_CHARS - 1).collect();
        format!("{}…", truncated.trim_end())
    }
}

// ── id / token 随机源 ──

fn to_base36(mut n: u128) -> String {
    if n == 0 {
        return "0".to_string();
    }
    const DIGITS: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut v = Vec::new();
    while n > 0 {
        v.push(DIGITS[(n % 36) as usize]);
        n /= 36;
    }
    v.reverse();
    String::from_utf8(v).unwrap()
}

/// 对齐 JS `prefix + Date.now().toString(36) + Math.random().toString(36).slice(2,8)`。
fn new_id(prefix: &str) -> String {
    let millis = chrono::Utc::now().timestamp_millis().max(0) as u128;
    let mut buf = [0u8; 8];
    let _ = getrandom::getrandom(&mut buf);
    let rand6: String = to_base36(u64::from_le_bytes(buf) as u128)
        .chars()
        .take(6)
        .collect();
    format!("{}{}{}", prefix, to_base36(millis), rand6)
}

/// 对齐 crypto.randomBytes(32).toString('hex')。
fn random_token() -> String {
    let mut buf = [0u8; 32];
    let _ = getrandom::getrandom(&mut buf);
    buf.iter().map(|b| format!("{:02x}", b)).collect()
}

// ── 基础目录 / 存储 IO ──

fn base_dir(app: &AppHandle) -> PathBuf {
    app.path().app_config_dir().unwrap_or_default()
}

fn store_path(app: &AppHandle, kind: HookKind) -> PathBuf {
    base_dir(app).join(kind.store_file())
}

fn normalize_stored_item(kind: HookKind, item: &Value) -> Value {
    if !item.is_object() {
        return item.clone();
    }
    let mut it = item.clone();
    let summary = sanitize_summary(kind, item["summary"].as_str().unwrap_or(""));
    it["summary"] = json!(summary);
    it
}

/// 读取并规范化整个池（{schemaVersion, items}）。对齐 readStore：重洗 summary 后，
/// 丢弃「pending 且 summary 为空」的条目。
fn read_store(app: &AppHandle, kind: HookKind) -> Value {
    let path = store_path(app, kind);
    if let Ok(text) = fs::read_to_string(&path) {
        if let Ok(data) = serde_json::from_str::<Value>(&text) {
            if let Some(items) = data.get("items").and_then(|v| v.as_array()) {
                let normalized: Vec<Value> = items
                    .iter()
                    .map(|it| normalize_stored_item(kind, it))
                    .filter(|it| {
                        if !it.is_object() {
                            return true;
                        }
                        let status = it["status"].as_str().unwrap_or("");
                        let has_summary = !it["summary"].as_str().unwrap_or("").is_empty();
                        status != "pending" || has_summary
                    })
                    .collect();
                let mut out = data.clone();
                out["items"] = Value::Array(normalized);
                return out;
            }
        }
    }
    json!({ "schemaVersion": 1, "items": [] })
}

fn write_store(app: &AppHandle, kind: HookKind, data: &Value) -> Result<(), String> {
    let dir = base_dir(app);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let text = serde_json::to_string_pretty(data).map_err(|e| e.to_string())?;
    fs::write(store_path(app, kind), text).map_err(|e| e.to_string())
}

// ── payload 规范化（对齐 normalizePayload）──

fn normalize_cwd(v: Option<&Value>) -> String {
    v.and_then(|x| x.as_str()).unwrap_or("").trim().to_string()
}

fn truncate(v: Option<&Value>, limit: usize) -> String {
    let s = v.and_then(|x| x.as_str()).unwrap_or("").trim();
    if s.chars().count() > limit {
        s.chars().take(limit).collect()
    } else {
        s.to_string()
    }
}

fn normalize_changed_files(v: Option<&Value>) -> Vec<String> {
    let arr = match v.and_then(|x| x.as_array()) {
        Some(a) => a,
        None => return vec![],
    };
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for item in arr {
        let value = item.as_str().map(|s| s.trim()).unwrap_or("");
        if value.is_empty() || seen.contains(value) {
            continue;
        }
        seen.insert(value.to_string());
        out.push(value.to_string());
        if out.len() >= 80 {
            break;
        }
    }
    out
}

fn normalize_iso(input: Option<&str>) -> String {
    if let Some(s) = input {
        if !s.is_empty() {
            if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(s) {
                return dt
                    .with_timezone(&chrono::Utc)
                    .format("%Y-%m-%dT%H:%M:%S%.3fZ")
                    .to_string();
            }
        }
    }
    utils::now_iso()
}

/// 词法归一化路径（解析 . / ..，统一分隔符），用于 matchProject 前缀匹配。
fn lexical_normalize(p: &str) -> String {
    let mut out = PathBuf::new();
    for comp in Path::new(p).components() {
        match comp {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out.to_string_lossy().to_string()
}

fn basename(p: &str) -> String {
    Path::new(p)
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default()
}

/// 按 repos[].path 对 cwd 做最长前缀匹配，返回 name/alias/basename（对齐 matchProject）。
fn match_project(cwd: &str, cfg: &Value) -> String {
    if cwd.is_empty() {
        return String::new();
    }
    let repos = cfg["repos"].as_array().cloned().unwrap_or_default();
    let normalized_target = lexical_normalize(cwd);
    let sep = std::path::MAIN_SEPARATOR.to_string();
    let mut best: Option<(String, String)> = None;
    for repo in &repos {
        let repo_path = repo["path"].as_str().unwrap_or("").trim();
        if repo_path.is_empty() {
            continue;
        }
        let normalized_repo = lexical_normalize(repo_path);
        let is_match = normalized_target == normalized_repo
            || normalized_target.starts_with(&(normalized_repo.clone() + &sep));
        if !is_match {
            continue;
        }
        let better = match &best {
            None => true,
            Some((p, _)) => normalized_repo.len() > p.len(),
        };
        if better {
            let name = repo["name"]
                .as_str()
                .filter(|s| !s.is_empty())
                .or_else(|| repo["alias"].as_str().filter(|s| !s.is_empty()))
                .map(|s| s.to_string())
                .unwrap_or_else(|| basename(&normalized_repo));
            best = Some((normalized_repo, name));
        }
    }
    match best {
        Some((_, name)) => name,
        None => basename(cwd),
    }
}

fn normalize_payload(kind: HookKind, payload: &Value, cfg: &Value) -> Result<Value, String> {
    let raw_summary = payload["summary"]
        .as_str()
        .filter(|s| !s.is_empty())
        .or_else(|| payload["content"].as_str().filter(|s| !s.is_empty()))
        .or_else(|| payload["text"].as_str().filter(|s| !s.is_empty()))
        .unwrap_or("");
    let summary = sanitize_summary(kind, raw_summary);
    if summary.is_empty() {
        return Err("summary 不能为空".to_string());
    }
    let cwd = normalize_cwd(payload.get("cwd"));
    let created_at = normalize_iso(
        payload["finishedAt"]
            .as_str()
            .or_else(|| payload["createdAt"].as_str()),
    );
    let project_in = truncate(payload.get("project"), 160);
    let project = if !project_in.is_empty() {
        project_in
    } else {
        match_project(&cwd, cfg)
    };
    Ok(json!({
        "id": new_id(kind.id_prefix()),
        "source": kind.source(),
        "status": "pending",
        "cwd": cwd,
        "project": project,
        "summary": summary,
        "branch": truncate(payload.get("branch"), 160),
        "changedFiles": normalize_changed_files(payload.get("changedFiles")),
        "title": truncate(payload.get("title"), 200),
        "createdAt": created_at,
    }))
}

// ── 池 CRUD ──

/// 列出 pending 小记，按 createdAt 降序（对齐 listPendingNotes，includeAll=false）。
pub fn list_pending(app: &AppHandle, kind: HookKind) -> Value {
    let store = read_store(app, kind);
    let mut items: Vec<Value> = store["items"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter(|it| it["status"].as_str() == Some("pending"))
                .cloned()
                .collect()
        })
        .unwrap_or_default();
    items.sort_by(|a, b| {
        b["createdAt"]
            .as_str()
            .unwrap_or("")
            .cmp(a["createdAt"].as_str().unwrap_or(""))
    });
    Value::Array(items)
}

fn add_pending(
    app: &AppHandle,
    kind: HookKind,
    payload: &Value,
    cfg: &Value,
) -> Result<Value, String> {
    let mut store = read_store(app, kind);
    let item = normalize_payload(kind, payload, cfg)?;
    if let Some(arr) = store["items"].as_array_mut() {
        arr.insert(0, item.clone());
    } else {
        store["items"] = json!([item.clone()]);
    }
    write_store(app, kind, &store)?;
    Ok(item)
}

fn update_status(
    app: &AppHandle,
    kind: HookKind,
    ids: &[String],
    status: &str,
    extra: &[(&str, Value)],
) -> usize {
    let wanted: HashSet<&str> = ids.iter().filter(|s| !s.is_empty()).map(|s| s.as_str()).collect();
    let mut store = read_store(app, kind);
    let mut count = 0;
    if let Some(arr) = store["items"].as_array_mut() {
        for item in arr.iter_mut() {
            let id = item["id"].as_str().unwrap_or("");
            if !wanted.contains(id) || item["status"].as_str() != Some("pending") {
                continue;
            }
            item["status"] = json!(status);
            for (k, v) in extra {
                item[*k] = v.clone();
            }
            count += 1;
        }
    }
    let _ = write_store(app, kind, &store);
    count
}

pub fn delete_pending(app: &AppHandle, kind: HookKind, ids: Vec<String>) -> Value {
    let deleted_at = utils::now_iso();
    let count = update_status(app, kind, &ids, "deleted", &[("deletedAt", json!(deleted_at))]);
    json!({ "deleted": count })
}

fn date_from_created_at(created_at: &str) -> String {
    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(created_at) {
        return utils::iso_date(dt.with_timezone(&chrono::Local).date_naive());
    }
    utils::iso_date(utils::today())
}

/// 单条小记的写入文本（对齐 contentForItem）。
fn content_for_item(kind: HookKind, item: &Value) -> String {
    let summary = item["summary"].as_str().unwrap_or("");
    let changed = item["changedFiles"].as_array().cloned().unwrap_or_default();
    let files_part = if !changed.is_empty() {
        let names: Vec<&str> = changed.iter().take(6).filter_map(|v| v.as_str()).collect();
        let branch = item["branch"].as_str().filter(|s| !s.is_empty()).unwrap_or("未知");
        let suffix = if changed.len() > 6 {
            format!(" 等 {} 个", changed.len())
        } else {
            String::new()
        };
        format!(
            "（{} 自动小记；分支：{}；改动文件：{}{}）",
            kind.label(),
            branch,
            names.join("、"),
            suffix
        )
    } else {
        String::new()
    };
    [summary, files_part.as_str()]
        .iter()
        .filter(|s| !s.is_empty())
        .copied()
        .collect::<Vec<_>>()
        .join("\n")
}

/// 把选中的 pending 小记写入正式 notes/YYYY-MM-DD.md（对齐 writePendingNotes）。
pub fn write_pending(
    app: &AppHandle,
    kind: HookKind,
    ids: Vec<String>,
    project: Option<String>,
    content: Option<String>,
) -> Value {
    let cfg = config::load_config(app);
    let misc_project = cfg["notes"]["miscProject"]
        .as_str()
        .unwrap_or("日常工作")
        .to_string();
    let notes_dir = match config::notes_dir(app) {
        Ok(d) => d,
        Err(e) => return json!({ "written": 0, "files": [], "error": e }),
    };
    let wanted: HashSet<String> = ids.into_iter().filter(|s| !s.is_empty()).collect();
    let mut store = read_store(app, kind);
    let now = utils::now_iso();
    let custom = content.map(|c| c.trim().to_string()).unwrap_or_default();

    let selected_ids: Vec<String> = store["items"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter(|it| {
                    it["status"].as_str() == Some("pending")
                        && wanted.contains(it["id"].as_str().unwrap_or(""))
                })
                .map(|it| it["id"].as_str().unwrap_or("").to_string())
                .collect()
        })
        .unwrap_or_default();
    if selected_ids.is_empty() {
        return json!({ "written": 0, "files": [] });
    }

    let mut files: Vec<String> = vec![];
    let mut written = 0usize;

    if !custom.is_empty() {
        // 合并成一条：用最早 createdAt 的条目的日期/项目
        let (first_created, first_project) = {
            let arr = store["items"].as_array().unwrap();
            let mut sel: Vec<&Value> = arr
                .iter()
                .filter(|it| selected_ids.iter().any(|id| Some(id.as_str()) == it["id"].as_str()))
                .collect();
            sel.sort_by(|a, b| {
                a["createdAt"]
                    .as_str()
                    .unwrap_or("")
                    .cmp(b["createdAt"].as_str().unwrap_or(""))
            });
            let first = sel.first().unwrap();
            (
                first["createdAt"].as_str().unwrap_or("").to_string(),
                first["project"].as_str().unwrap_or("").to_string(),
            )
        };
        let proj = project.clone().unwrap_or(first_project);
        let file = match notes::append_note(
            &notes_dir,
            &date_from_created_at(&first_created),
            &proj,
            &custom,
            &misc_project,
        ) {
            Ok(f) => f,
            Err(e) => return json!({ "written": 0, "files": [], "error": e }),
        };
        files.push(file.clone());
        if let Some(arr) = store["items"].as_array_mut() {
            for it in arr.iter_mut() {
                let id = it["id"].as_str().unwrap_or("").to_string();
                if selected_ids.contains(&id) {
                    it["status"] = json!("written");
                    it["writtenAt"] = json!(now);
                    it["noteFile"] = json!(file);
                    written += 1;
                }
            }
        }
        let _ = write_store(app, kind, &store);
        return json!({ "written": written, "files": files });
    }

    // 逐条写入：先收集计划（id, date, project, content），再依次 appendNote
    let plan: Vec<(String, String, String, String)> = {
        let arr = store["items"].as_array().unwrap();
        selected_ids
            .iter()
            .filter_map(|id| {
                arr.iter()
                    .find(|x| x["id"].as_str() == Some(id.as_str()))
                    .map(|it| {
                        let created = it["createdAt"].as_str().unwrap_or("").to_string();
                        let proj = project
                            .clone()
                            .unwrap_or_else(|| it["project"].as_str().unwrap_or("").to_string());
                        (id.clone(), created, proj, content_for_item(kind, it))
                    })
            })
            .collect()
    };
    let mut file_by_id: Vec<(String, String)> = vec![];
    for (id, created, proj, item_content) in &plan {
        match notes::append_note(
            &notes_dir,
            &date_from_created_at(created),
            proj,
            item_content,
            &misc_project,
        ) {
            Ok(f) => {
                files.push(f.clone());
                file_by_id.push((id.clone(), f));
            }
            Err(e) => return json!({ "written": written, "files": files, "error": e }),
        }
    }
    if let Some(arr) = store["items"].as_array_mut() {
        for it in arr.iter_mut() {
            let id = it["id"].as_str().unwrap_or("").to_string();
            if let Some((_, f)) = file_by_id.iter().find(|(i, _)| *i == id) {
                it["status"] = json!("written");
                it["writtenAt"] = json!(now);
                it["noteFile"] = json!(f);
                written += 1;
            }
        }
    }
    let _ = write_store(app, kind, &store);
    json!({ "written": written, "files": files })
}

// ── AI 合并总结（对齐 summarizePendingNotes）──

fn summary_system(kind: HookKind) -> String {
    format!(
        "你是一名研发工作小记整理助手。\n请把多条 {} 候选小记合并成一条适合写入日报/周报素材的中文小记。\n要求：客观、简洁、书面化；保留真实完成事项和价值；不要编造未提供的信息。\n直接输出小记内容本身，不要标题、不要解释、不要项目名前缀。",
        kind.label()
    )
}

fn build_summary_prompt(kind: HookKind, items: &[Value]) -> String {
    let mut lines: Vec<String> = vec![format!("请整理以下 {} 待处理小记：", kind.label()), String::new()];
    for (i, item) in items.iter().enumerate() {
        lines.push(format!("{}. {}", i + 1, item["summary"].as_str().unwrap_or("")));
        let mut meta: Vec<String> = vec![];
        if let Some(p) = item["project"].as_str() {
            if !p.is_empty() {
                meta.push(format!("项目：{}", p));
            }
        }
        if let Some(b) = item["branch"].as_str() {
            if !b.is_empty() {
                meta.push(format!("分支：{}", b));
            }
        }
        let cf = item["changedFiles"].as_array().cloned().unwrap_or_default();
        if !cf.is_empty() {
            let names: Vec<&str> = cf.iter().take(8).filter_map(|v| v.as_str()).collect();
            meta.push(format!("文件：{}", names.join("、")));
        }
        if !meta.is_empty() {
            lines.push(format!("   {}", meta.join("；")));
        }
    }
    lines.push(String::new());
    lines.push("请输出一条可直接写入工作小记的中文内容。".to_string());
    lines.join("\n")
}

pub async fn summarize_pending(app: &AppHandle, kind: HookKind, ids: Vec<String>) -> Value {
    let cfg = config::load_config(app);
    let resolved = secrets::resolve_api_key(&cfg);
    if !resolved.has {
        return json!({ "error": "未配置 AI API Key" });
    }
    let provider = match llm::create_provider(&cfg, &resolved.key) {
        Ok(p) => p,
        Err(e) => return json!({ "error": e.message() }),
    };
    let wanted: HashSet<String> = ids.into_iter().filter(|s| !s.is_empty()).collect();
    let store = read_store(app, kind);
    let items: Vec<Value> = store["items"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter(|it| {
                    it["status"].as_str() == Some("pending")
                        && wanted.contains(it["id"].as_str().unwrap_or(""))
                })
                .cloned()
                .collect()
        })
        .unwrap_or_default();
    if items.is_empty() {
        return json!({ "text": "", "model": "" });
    }
    match provider
        .summarize(&summary_system(kind), &build_summary_prompt(kind, &items))
        .await
    {
        Ok(r) => json!({
            "text": r.text.trim(),
            "model": r.model,
            "inputTokens": r.input_tokens,
            "outputTokens": r.output_tokens,
        }),
        Err(e) => json!({ "error": e.message() }),
    }
}

// ── token / endpoint ──

/// 取已有 token，没有则生成并存入钥匙串（对齐 ensure{Codex,Zcode}HookToken）。
pub fn ensure_token(kind: HookKind) -> String {
    let mut token = secrets::get_key(kind.provider());
    if token.is_empty() {
        token = random_token();
        let _ = secrets::set_key(kind.provider(), &token);
    }
    token
}

fn endpoint_for(app: &AppHandle, kind: HookKind, server: &HookServer) -> String {
    let st = server.status();
    let cfg = config::load_config(app);
    let port = st["port"]
        .as_u64()
        .filter(|p| *p > 0)
        .or_else(|| cfg[kind.provider()]["port"].as_u64().filter(|p| *p > 0))
        .unwrap_or(kind.default_port() as u64);
    format!("http://127.0.0.1:{}{}", port, kind.route())
}

fn install_status_value(kind: HookKind) -> Value {
    match kind {
        HookKind::Codex => codex_config::install_status(&codex_config::default_hooks_path()),
        HookKind::Zcode => zcode_config::install_status(),
    }
}

// ── 前端聚合命令（status / copyConfig / install / uninstall）──

pub fn hook_status(app: &AppHandle, server: &HookServer, kind: HookKind) -> Value {
    let cfg = config::load_config(app);
    let enabled = cfg[kind.provider()]["enabled"].as_bool().unwrap_or(false);
    let st = server.status();
    let install = install_status_value(kind);
    let mut out = json!({
        "enabled": enabled,
        "hasToken": secrets::has_key(kind.provider()),
        "endpoint": endpoint_for(app, kind, server),
    });
    match kind {
        HookKind::Codex => {
            out["hookInstalled"] = install["installed"].clone();
            out["hookCount"] = install["hookCount"].clone();
            out["hooksPath"] = install["hooksPath"].clone();
            out["hookError"] = install["error"].clone();
        }
        HookKind::Zcode => {
            out["hookInstalled"] = install["installed"].clone();
            out["hookRegistered"] = install["registered"].clone();
            out["hookEnabled"] = install["enabled"].clone();
            out["hookCount"] = install["hookCount"].clone();
            out["pluginPath"] = install["pluginPath"].clone();
            out["marketplacePath"] = install["marketplacePath"].clone();
            out["configPath"] = install["configPath"].clone();
            out["hookError"] = install["error"].clone();
        }
    }
    // 末尾展开 server 状态（running/host/port/error），与 JS `...status` 一致
    out["running"] = st["running"].clone();
    out["host"] = st["host"].clone();
    out["port"] = st["port"].clone();
    out["error"] = st["error"].clone();
    out
}

pub fn copy_config(app: &AppHandle, server: &HookServer, kind: HookKind) -> Value {
    let token = ensure_token(kind);
    server.apply_config(app);
    let endpoint = endpoint_for(app, kind, server);
    let text = match kind {
        HookKind::Codex => codex_config::build_hook_snippet(&endpoint, &token),
        HookKind::Zcode => zcode_config::build_hook_snippet(&endpoint, &token),
    };
    let cfg = config::load_config(app);
    json!({
        "enabled": cfg[kind.provider()]["enabled"].as_bool().unwrap_or(false),
        "endpoint": endpoint,
        "text": text,
    })
}

pub fn install_hook(app: &AppHandle, server: &HookServer, kind: HookKind) -> Value {
    // 未启用则先启用并落盘（对齐 ipc：先 persist 再 applyConfig）
    let mut cfg = config::load_config(app);
    if !cfg[kind.provider()]["enabled"].as_bool().unwrap_or(false) {
        if !cfg[kind.provider()].is_object() {
            cfg[kind.provider()] = json!({});
        }
        cfg[kind.provider()]["enabled"] = json!(true);
        let _ = config::save_config(app, &cfg);
    }
    let token = ensure_token(kind);
    server.apply_config(app);
    let endpoint = endpoint_for(app, kind, server);
    let mut result = match kind {
        HookKind::Codex => {
            let hook = codex_config::build_pending_note_hook(&endpoint, &token);
            codex_config::install(&codex_config::default_hooks_path(), hook)
        }
        HookKind::Zcode => zcode_config::install(&endpoint, &token),
    };
    result["endpoint"] = json!(endpoint);
    result["status"] = install_status_value(kind);
    result
}

pub fn uninstall_hook(app: &AppHandle, kind: HookKind) -> Value {
    let _ = app; // uninstall 仅清理外部 hook 配置，不动 WeekLog 服务与 cfg.enabled
    let mut result = match kind {
        HookKind::Codex => codex_config::uninstall(&codex_config::default_hooks_path()),
        HookKind::Zcode => zcode_config::uninstall(),
    };
    result["status"] = install_status_value(kind);
    result
}

// ── 本地 HTTP 服务器（tiny_http；对齐 {codex,zcode}-hook-server.js）──

struct ServerInner {
    running: bool,
    port: u16,
    error: String,
    stop: Option<Arc<AtomicBool>>,
    handle: Option<JoinHandle<()>>,
}

pub struct HookServer {
    kind: HookKind,
    inner: Mutex<ServerInner>,
}

impl HookServer {
    pub fn new(kind: HookKind) -> Self {
        HookServer {
            kind,
            inner: Mutex::new(ServerInner {
                running: false,
                port: 0,
                error: String::new(),
                stop: None,
                handle: None,
            }),
        }
    }

    pub fn status(&self) -> Value {
        let g = self.inner.lock().unwrap();
        json!({ "running": g.running, "host": "127.0.0.1", "port": g.port, "error": g.error })
    }

    /// 按 cfg.{provider}.enabled/port 启停（对齐 applyConfig）。
    pub fn apply_config(&self, app: &AppHandle) -> Value {
        let cfg = config::load_config(app);
        let enabled = cfg[self.kind.provider()]["enabled"].as_bool().unwrap_or(false);
        if !enabled {
            self.close();
            return self.status();
        }
        let desired = valid_port(cfg[self.kind.provider()]["port"].as_i64(), self.kind.default_port());
        {
            let g = self.inner.lock().unwrap();
            if g.running && g.port == desired {
                return json!({ "running": g.running, "host": "127.0.0.1", "port": g.port, "error": g.error });
            }
        }
        self.close();
        self.start(app, desired);
        self.status()
    }

    fn start(&self, app: &AppHandle, port: u16) {
        let server = match tiny_http::Server::http(("127.0.0.1", port)) {
            Ok(s) => s,
            Err(e) => {
                let mut g = self.inner.lock().unwrap();
                g.running = false;
                g.port = 0;
                g.error = e.to_string();
                logger_error(app, self.kind, &format!("hook 本地服务启动失败: {}", e), port);
                return;
            }
        };
        let actual_port = server
            .server_addr()
            .to_ip()
            .map(|a| a.port())
            .unwrap_or(port);
        let stop = Arc::new(AtomicBool::new(false));
        let stop2 = stop.clone();
        let kind = self.kind;
        let app2 = app.clone();
        let handle = std::thread::spawn(move || loop {
            if stop2.load(Ordering::Relaxed) {
                break;
            }
            match server.recv_timeout(Duration::from_millis(200)) {
                Ok(Some(req)) => handle_request(req, kind, &app2),
                Ok(None) => continue,
                Err(_) => break,
            }
        });
        let mut g = self.inner.lock().unwrap();
        g.running = true;
        g.port = actual_port;
        g.error = String::new();
        g.stop = Some(stop);
        g.handle = Some(handle);
    }

    pub fn close(&self) {
        let (stop, handle) = {
            let mut g = self.inner.lock().unwrap();
            g.running = false;
            g.port = 0;
            g.error = String::new();
            (g.stop.take(), g.handle.take())
        };
        if let Some(s) = stop {
            s.store(true, Ordering::Relaxed);
        }
        if let Some(h) = handle {
            let _ = h.join();
        }
    }
}

fn valid_port(p: Option<i64>, default: u16) -> u16 {
    match p {
        Some(n) if (0..=65535).contains(&n) => n as u16,
        _ => default,
    }
}

fn logger_error(app: &AppHandle, kind: HookKind, msg: &str, port: u16) {
    crate::logger::write_log(
        app,
        "error",
        &format!("{}.hook", kind.source()),
        msg,
        json!({ "port": port }),
    );
}

fn extract_bearer(req: &tiny_http::Request) -> String {
    for h in req.headers() {
        if h.field.equiv("Authorization") {
            if let Some(caps) = RE_BEARER.captures(h.value.as_str()) {
                return caps.get(1).map(|m| m.as_str().trim().to_string()).unwrap_or_default();
            }
        }
    }
    String::new()
}

fn respond_json(req: tiny_http::Request, code: u16, body: &Value) {
    let text = body.to_string();
    let header = tiny_http::Header::from_bytes(
        &b"Content-Type"[..],
        &b"application/json; charset=utf-8"[..],
    )
    .unwrap();
    let resp = tiny_http::Response::from_string(text)
        .with_status_code(code)
        .with_header(header);
    let _ = req.respond(resp);
}

fn handle_request(mut req: tiny_http::Request, kind: HookKind, app: &AppHandle) {
    let cfg = config::load_config(app);
    if !cfg[kind.provider()]["enabled"].as_bool().unwrap_or(false) {
        respond_json(req, 403, &json!({ "error": format!("{} hook 未启用", kind.label()) }));
        return;
    }
    let is_post = req.method() == &tiny_http::Method::Post;
    if !is_post || req.url() != kind.route() {
        respond_json(req, 404, &json!({ "error": "not found" }));
        return;
    }
    let expected = secrets::get_key(kind.provider());
    if expected.is_empty() || extract_bearer(&req) != expected {
        respond_json(req, 401, &json!({ "error": "unauthorized" }));
        return;
    }
    let mut buf = Vec::new();
    let read_res = req
        .as_reader()
        .take((MAX_BODY_BYTES + 1) as u64)
        .read_to_end(&mut buf);
    if read_res.is_err() {
        respond_json(req, 422, &json!({ "error": "读取请求体失败" }));
        return;
    }
    if buf.len() > MAX_BODY_BYTES {
        respond_json(req, 422, &json!({ "error": "请求体过大" }));
        return;
    }
    let raw = String::from_utf8_lossy(&buf);
    let payload: Value = if raw.trim().is_empty() {
        json!({})
    } else {
        match serde_json::from_str(&raw) {
            Ok(v) => v,
            Err(_) => {
                respond_json(req, 400, &json!({ "error": "invalid JSON" }));
                return;
            }
        }
    };
    match add_pending(app, kind, &payload, &cfg) {
        Ok(item) => {
            crate::logger::write_log(
                app,
                "info",
                &format!("{}.hook", kind.source()),
                &format!("收到 {} 待处理小记", kind.label()),
                json!({ "id": item["id"], "project": item["project"], "cwd": item["cwd"] }),
            );
            let id = item["id"].clone();
            respond_json(req, 201, &json!({ "id": id, "item": item }));
        }
        Err(e) => respond_json(req, 422, &json!({ "error": e })),
    }
}

// ──────────────────────────────────────────────────────────────────────────
// Codex hook-config：单一 ~/.codex/hooks.json（对齐 codex-hook-config.js）
// ──────────────────────────────────────────────────────────────────────────
mod codex_config {
    use super::*;

    const WEEKLOG_HOOK_ID: &str = "weeklog-codex-pending-note";
    const WEEKLOG_STATUS_MESSAGE: &str = "Saving Codex pending note (weeklog-codex-pending-note)";

    fn home_dir() -> PathBuf {
        std::env::var_os("USERPROFILE")
            .or_else(|| std::env::var_os("HOME"))
            .map(PathBuf::from)
            .unwrap_or_default()
    }

    fn codex_home() -> PathBuf {
        std::env::var_os("CODEX_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home_dir().join(".codex"))
    }

    pub fn default_hooks_path() -> PathBuf {
        codex_home().join("hooks.json")
    }

    fn timestamp_for_file() -> String {
        utils::now_iso().replace(|c| c == ':' || c == '.', "-")
    }

    fn backup_file(file: &Path) -> String {
        if !file.exists() {
            return String::new();
        }
        let backup = format!("{}.weeklog-backup-{}", file.to_string_lossy(), timestamp_for_file());
        match fs::copy(file, &backup) {
            Ok(_) => backup,
            Err(_) => String::new(),
        }
    }

    struct ReadResult {
        config: Value,
        exists: bool,
        error: Option<String>,
    }

    fn read_hooks_file(file: &Path) -> ReadResult {
        if !file.exists() {
            return ReadResult {
                config: json!({ "hooks": {} }),
                exists: false,
                error: None,
            };
        }
        match fs::read_to_string(file).map_err(|e| e.to_string()).and_then(|t| {
            serde_json::from_str::<Value>(&t).map_err(|e| e.to_string())
        }) {
            Ok(parsed) => {
                let mut config = if parsed.is_object() { parsed } else { json!({}) };
                if !config.get("hooks").map(|h| h.is_object()).unwrap_or(false) {
                    config["hooks"] = json!({});
                }
                ReadResult {
                    config,
                    exists: true,
                    error: None,
                }
            }
            Err(e) => ReadResult {
                config: Value::Null,
                exists: true,
                error: Some(e),
            },
        }
    }

    fn write_hooks_file(file: &Path, config: &Value) -> Result<(), String> {
        if let Some(dir) = file.parent() {
            fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let text = format!("{}\n", serde_json::to_string_pretty(config).map_err(|e| e.to_string())?);
        fs::write(file, text).map_err(|e| e.to_string())
    }

    fn is_managed(hook: &Value) -> bool {
        if !hook.is_object() {
            return false;
        }
        if hook["weeklogHookId"].as_str() == Some(WEEKLOG_HOOK_ID) {
            return true;
        }
        hook["statusMessage"]
            .as_str()
            .map(|s| s.contains(WEEKLOG_HOOK_ID))
            .unwrap_or(false)
    }

    fn normalize_stop_groups(config: &mut Value) {
        if !config.get("hooks").map(|h| h.is_object()).unwrap_or(false) {
            config["hooks"] = json!({});
        }
        if !config["hooks"].get("Stop").map(|s| s.is_array()).unwrap_or(false) {
            config["hooks"]["Stop"] = json!([]);
        }
    }

    fn remove_managed_hooks(config: &mut Value) -> usize {
        normalize_stop_groups(config);
        let groups = config["hooks"]["Stop"].as_array().cloned().unwrap_or_default();
        let mut removed = 0;
        let mut next: Vec<Value> = vec![];
        for group in groups {
            if !group.is_object() {
                next.push(group);
                continue;
            }
            let hooks = group["hooks"].as_array().cloned().unwrap_or_default();
            let orig_len = hooks.len();
            let kept: Vec<Value> = hooks
                .into_iter()
                .filter(|h| {
                    let managed = is_managed(h);
                    if managed {
                        removed += 1;
                    }
                    !managed
                })
                .collect();
            if orig_len == 0 || !kept.is_empty() {
                let mut g = group.clone();
                g["hooks"] = Value::Array(kept);
                next.push(g);
            }
        }
        config["hooks"]["Stop"] = Value::Array(next);
        removed
    }

    fn build_commands(endpoint: &str, token: &str) -> (String, String) {
        let script = build_hook_script(endpoint, token);
        let encoded = base64::engine::general_purpose::STANDARD.encode(script.as_bytes());
        (
            format!("node -e 'eval(Buffer.from(\"{}\",\"base64\").toString())'", encoded),
            format!("node -e \"eval(Buffer.from('{}','base64').toString())\"", encoded),
        )
    }

    pub fn build_pending_note_hook(endpoint: &str, token: &str) -> Value {
        let (command, command_windows) = build_commands(endpoint, token);
        json!({
            "type": "command",
            "command": command,
            "commandWindows": command_windows,
            "timeout": 30,
            "statusMessage": WEEKLOG_STATUS_MESSAGE,
        })
    }

    pub fn build_hook_snippet(endpoint: &str, token: &str) -> String {
        let hook = build_pending_note_hook(endpoint, token);
        serde_json::to_string_pretty(&json!({ "hooks": { "Stop": [ { "hooks": [hook] } ] } }))
            .unwrap_or_default()
    }

    pub fn install(hooks_path: &Path, hook: Value) -> Value {
        let read = read_hooks_file(hooks_path);
        if let Some(err) = read.error {
            return json!({ "ok": false, "installed": false, "replaced": 0, "error": format!("Codex hooks 配置不是有效 JSON：{}", err) });
        }
        let mut config = read.config;
        let replaced = remove_managed_hooks(&mut config);
        normalize_stop_groups(&mut config);
        if let Some(arr) = config["hooks"]["Stop"].as_array_mut() {
            arr.push(json!({ "hooks": [hook] }));
        }
        let backup_path = if read.exists { backup_file(hooks_path) } else { String::new() };
        if let Err(e) = write_hooks_file(hooks_path, &config) {
            return json!({ "ok": false, "installed": false, "replaced": replaced, "error": e });
        }
        json!({
            "ok": true,
            "installed": true,
            "replaced": replaced,
            "hooksPath": hooks_path.to_string_lossy(),
            "backupPath": backup_path,
        })
    }

    pub fn uninstall(hooks_path: &Path) -> Value {
        let read = read_hooks_file(hooks_path);
        if let Some(err) = read.error {
            return json!({ "ok": false, "removed": 0, "error": format!("Codex hooks 配置不是有效 JSON：{}", err) });
        }
        if !read.exists {
            return json!({ "ok": true, "removed": 0, "hooksPath": hooks_path.to_string_lossy(), "backupPath": "" });
        }
        let mut config = read.config;
        let removed = remove_managed_hooks(&mut config);
        if removed == 0 {
            return json!({ "ok": true, "removed": 0, "hooksPath": hooks_path.to_string_lossy(), "backupPath": "" });
        }
        let backup_path = backup_file(hooks_path);
        if let Err(e) = write_hooks_file(hooks_path, &config) {
            return json!({ "ok": false, "removed": 0, "error": e });
        }
        json!({
            "ok": true,
            "removed": removed,
            "hooksPath": hooks_path.to_string_lossy(),
            "backupPath": backup_path,
        })
    }

    pub fn install_status(hooks_path: &Path) -> Value {
        let read = read_hooks_file(hooks_path);
        if let Some(err) = read.error {
            return json!({
                "hooksPath": hooks_path.to_string_lossy(),
                "exists": true,
                "installed": false,
                "hookCount": 0,
                "error": format!("Codex hooks 配置不是有效 JSON：{}", err),
            });
        }
        let groups = read.config["hooks"]["Stop"].as_array().cloned().unwrap_or_default();
        let mut hook_count = 0;
        for group in &groups {
            if let Some(hooks) = group["hooks"].as_array() {
                hook_count += hooks.iter().filter(|h| is_managed(h)).count();
            }
        }
        json!({
            "hooksPath": hooks_path.to_string_lossy(),
            "exists": read.exists,
            "installed": hook_count > 0,
            "hookCount": hook_count,
            "error": "",
        })
    }

    /// 注入 Codex 的 Node hook 脚本（base64 后写入 hooks.json 的 command）。
    fn build_hook_script(endpoint: &str, token: &str) -> String {
        let ep = serde_json::to_string(endpoint).unwrap_or_else(|_| "\"\"".to_string());
        let tk = serde_json::to_string(token).unwrap_or_else(|_| "\"\"".to_string());
        CODEX_SCRIPT_TEMPLATE
            .replace("__ENDPOINT_JSON__", &ep)
            .replace("__TOKEN_JSON__", &tk)
    }

    const CODEX_SCRIPT_TEMPLATE: &str = r#"
const fs = require('fs')
const http = require('http')
const cp = require('child_process')
const endpoint = __ENDPOINT_JSON__
const token = __TOKEN_JSON__
function run(cmd, args) {
  try {
    return cp.execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 1000 }).trim()
  } catch {
    return ''
  }
}
function parseInput() {
  try {
    if (process.stdin.isTTY) return {}
    const raw = fs.readFileSync(0, 'utf8')
    return raw.trim() ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}
const MAX_SUMMARY_CHARS = 4000
function stripCodexMetadata(text) {
  return String(text || '')
    .replace(/<oai-mem-citation>[\s\S]*?<\/oai-mem-citation>/g, '')
    .trim()
}
function trimSummary(text) {
  const s = stripCodexMetadata(text)
  if (s.length <= MAX_SUMMARY_CHARS) return s
  return s.slice(0, MAX_SUMMARY_CHARS - 1).trimEnd() + '…'
}
function textFromValue(value, depth = 0) {
  if (depth > 4 || value == null) return ''
  if (typeof value === 'string') return value.trim()
  if (Array.isArray(value)) {
    return value
      .map((item) => textFromValue(item, depth + 1))
      .filter(Boolean)
      .join('\n\n')
      .trim()
  }
  if (typeof value === 'object') {
    for (const key of ['text', 'content', 'value', 'message', 'summary', 'final_message', 'finalMessage', 'final_response', 'finalResponse']) {
      const picked = textFromValue(value[key], depth + 1)
      if (picked) return picked
    }
  }
  return ''
}
function firstText(...values) {
  for (const value of values) {
    const text = textFromValue(value)
    if (text) return trimSummary(text)
  }
  return ''
}
function readTranscriptSummary(transcriptPath, fsModule = fs) {
  const file = textFromValue(transcriptPath)
  if (!file) return ''
  try {
    if (!fsModule.existsSync(file)) return ''
    const stat = fsModule.statSync(file)
    if (!stat.isFile() || stat.size > 10 * 1024 * 1024) return ''
    const raw = fsModule.readFileSync(file, 'utf8')
    let lastAssistantText = ''
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue
      let item
      try {
        item = JSON.parse(line)
      } catch {
        continue
      }
      const payload = item && (item.payload || item)
      const role = payload && (payload.role || payload.author || (payload.message && payload.message.role))
      const type = payload && payload.type
      const isAssistant =
        role === 'assistant' ||
        type === 'assistant_message' ||
        type === 'assistant' ||
        (type === 'message' && role === 'assistant')
      if (!isAssistant) continue
      const text = firstText(payload.content, payload.message && payload.message.content, payload.text, payload.delta)
      if (text) lastAssistantText = text
    }
    return lastAssistantText
  } catch {
    return ''
  }
}
function deriveCodexSummary(event, opts = {}) {
  const e = event && typeof event === 'object' ? event : {}
  const direct = firstText(
    e.final_response,
    e.finalResponse,
    e.final_message,
    e.finalMessage,
    e.assistant_response,
    e.assistantResponse,
    e.assistant_message,
    e.assistantMessage,
    e.output_text,
    e.outputText,
    e.summary,
    e.result && e.result.final_response,
    e.result && e.result.finalResponse,
    e.result && e.result.final_message,
    e.result && e.result.finalMessage,
    e.result && e.result.summary,
    e.turn && e.turn.final_response,
    e.turn && e.turn.finalResponse,
    e.turn && e.turn.final_message,
    e.turn && e.turn.finalMessage,
    e.turn && e.turn.summary
  )
  if (direct) return direct
  const fromTranscript = readTranscriptSummary(
    firstText(e.transcript_path, e.transcriptPath, e.transcript_file, e.transcriptFile, e.transcript),
    opts.fs || fs
  )
  return fromTranscript
}
const event = parseInput()
const summary = deriveCodexSummary(event, { fs })
if (!summary) process.exit(0)
const changed = run('git', ['diff', '--name-only', 'HEAD'])
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean)
const statusFiles = run('git', ['status', '--short'])
  .split(/\r?\n/)
  .map((line) => line.slice(3).trim())
  .filter(Boolean)
const changedFiles = Array.from(new Set([...changed, ...statusFiles])).slice(0, 80)
const payload = JSON.stringify({
  source: 'codex',
  cwd: process.cwd(),
  summary,
  title: firstText(event.title, event.prompt),
  branch: run('git', ['branch', '--show-current']) || run('git', ['rev-parse', '--short', 'HEAD']),
  changedFiles,
  finishedAt: new Date().toISOString(),
})
const req = http.request(endpoint, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    Authorization: 'Bearer ' + token,
  },
}, (res) => res.resume())
req.on('error', () => {})
req.end(payload)
"#;
}

// ──────────────────────────────────────────────────────────────────────────
// ZCode hook-config：~/.zcode 插件包系统（对齐 zcode-hook-config.js）
// ──────────────────────────────────────────────────────────────────────────
mod zcode_config {
    use super::*;

    const WEEKLOG_HOOK_ID: &str = "weeklog-zcode-pending-note";
    const WEEKLOG_STATUS_MESSAGE: &str = "Saving ZCode pending note (weeklog-zcode-pending-note)";
    const MARKETPLACE_NAME: &str = "weeklog-hooks";
    const PLUGIN_NAME: &str = "weeklog-pending-note";
    const PLUGIN_VERSION: &str = "1.0.0";
    const PLUGIN_DESCRIPTION: &str =
        "ZCode 完成任务后把摘要写入 WeekLog 待处理小记池（由 WeekLog 自动安装）。";
    // 预计算 sha256("weeklog-pending-note@1.0.0")，避免引入哈希依赖
    const SEED_HASH: &str = "0d417c4c27c7ccfcf34aacce3e3b7a5a4ccc400ba1593c326bb0431fe834b2ea";

    fn home_dir() -> PathBuf {
        std::env::var_os("USERPROFILE")
            .or_else(|| std::env::var_os("HOME"))
            .map(PathBuf::from)
            .unwrap_or_default()
    }

    fn zcode_home() -> PathBuf {
        std::env::var_os("ZCODE_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home_dir().join(".zcode"))
    }

    fn plugin_cache_root() -> PathBuf {
        zcode_home()
            .join("cli")
            .join("plugins")
            .join("cache")
            .join(MARKETPLACE_NAME)
            .join(PLUGIN_NAME)
            .join(PLUGIN_VERSION)
    }

    fn marketplace_file() -> PathBuf {
        zcode_home()
            .join("cli")
            .join("plugins")
            .join("marketplaces")
            .join(MARKETPLACE_NAME)
            .join("marketplace.json")
    }

    fn zcode_config_file() -> PathBuf {
        zcode_home().join("cli").join("config.json")
    }

    fn timestamp_for_file() -> String {
        utils::now_iso().replace(|c| c == ':' || c == '.', "-")
    }

    fn copy_dir(src: &Path, dest: &Path) -> Result<(), String> {
        fs::create_dir_all(dest).map_err(|e| e.to_string())?;
        for entry in fs::read_dir(src).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let from = entry.path();
            let to = dest.join(entry.file_name());
            if from.is_dir() {
                copy_dir(&from, &to)?;
            } else {
                fs::copy(&from, &to).map_err(|e| e.to_string())?;
            }
        }
        Ok(())
    }

    fn backup_file(file: &Path) -> String {
        if !file.exists() {
            return String::new();
        }
        let backup = format!("{}.weeklog-backup-{}", file.to_string_lossy(), timestamp_for_file());
        let meta = match fs::metadata(file) {
            Ok(m) => m,
            Err(_) => return String::new(),
        };
        let r = if meta.is_dir() {
            copy_dir(file, Path::new(&backup))
        } else {
            fs::copy(file, &backup).map(|_| ()).map_err(|e| e.to_string())
        };
        match r {
            Ok(_) => backup,
            Err(_) => String::new(),
        }
    }

    fn empty_dir(dir: &Path) {
        if !dir.exists() {
            return;
        }
        if let Ok(entries) = fs::read_dir(dir) {
            for entry in entries.flatten() {
                let full = entry.path();
                if full.is_dir() {
                    empty_dir(&full);
                    let _ = fs::remove_dir(&full);
                } else {
                    let _ = fs::remove_file(&full);
                }
            }
        }
    }

    struct JsonRead {
        value: Value,
        exists: bool,
        error: Option<String>,
    }

    fn read_json(file: &Path) -> JsonRead {
        if !file.exists() {
            return JsonRead {
                value: Value::Null,
                exists: false,
                error: None,
            };
        }
        match fs::read_to_string(file).map_err(|e| e.to_string()).and_then(|t| {
            serde_json::from_str::<Value>(&t).map_err(|e| e.to_string())
        }) {
            Ok(v) => JsonRead {
                value: v,
                exists: true,
                error: None,
            },
            Err(e) => JsonRead {
                value: Value::Null,
                exists: true,
                error: Some(e),
            },
        }
    }

    fn write_json(file: &Path, value: &Value) -> Result<(), String> {
        if let Some(dir) = file.parent() {
            fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let text = format!("{}\n", serde_json::to_string_pretty(value).map_err(|e| e.to_string())?);
        fs::write(file, text).map_err(|e| e.to_string())
    }

    fn build_plugin_json() -> Value {
        json!({
            "name": PLUGIN_NAME,
            "version": PLUGIN_VERSION,
            "description": PLUGIN_DESCRIPTION,
            "author": { "name": "WeekLog" },
            "license": "MIT",
        })
    }

    fn build_seed_json() -> Value {
        json!({
            "hash": SEED_HASH,
            "marketplace": MARKETPLACE_NAME,
            "plugin": PLUGIN_NAME,
            "pluginVersion": PLUGIN_VERSION,
            "source": "filesystem",
            "version": 1,
        })
    }

    fn build_hooks_json() -> Value {
        json!({
            "hooks": {
                "Stop": [
                    {
                        "hooks": [
                            {
                                "type": "command",
                                "command": "node \"${CLAUDE_PLUGIN_ROOT}/hooks/post-stop.js\"",
                                "timeout": 30,
                                "statusMessage": WEEKLOG_STATUS_MESSAGE,
                            }
                        ]
                    }
                ]
            }
        })
    }

    fn build_package_json() -> Value {
        json!({
            "name": format!("@weeklog/{}", PLUGIN_NAME),
            "version": PLUGIN_VERSION,
            "private": true,
            "license": "MIT",
            "description": PLUGIN_DESCRIPTION,
        })
    }

    pub fn build_hook_snippet(endpoint: &str, token: &str) -> String {
        let plugin_json = serde_json::to_string_pretty(&build_plugin_json()).unwrap_or_default();
        let hooks_json = serde_json::to_string_pretty(&build_hooks_json()).unwrap_or_default();
        [
            "# WeekLog ZCode Hook 安装说明".to_string(),
            String::new(),
            "1) 在 ZCode 用户目录创建插件包：".to_string(),
            format!(
                "   ~/.zcode/cli/plugins/cache/{}/{}/{}/",
                MARKETPLACE_NAME, PLUGIN_NAME, PLUGIN_VERSION
            ),
            "   ├─ .zcode-plugin/plugin.json".to_string(),
            "   ├─ hooks/hooks.json".to_string(),
            "   └─ hooks/post-stop.js".to_string(),
            String::new(),
            "2) plugin.json：".to_string(),
            plugin_json,
            String::new(),
            "3) hooks/hooks.json（Stop 事件触发 post-stop.js）：".to_string(),
            hooks_json,
            String::new(),
            "4) post-stop.js 内的 endpoint 与 token（由 WeekLog 一键安装自动写入）：".to_string(),
            format!("   endpoint = {}", endpoint),
            format!("   token    = {}", token),
            String::new(),
            "5) 注册到 marketplace.json 并在 config.json 启用：".to_string(),
            format!("   enabledPlugins: {{ \"{}@{}\": true }}", PLUGIN_NAME, MARKETPLACE_NAME),
        ]
        .join("\n")
    }

    fn is_managed_plugin(hook: &Value) -> bool {
        if !hook.is_object() {
            return false;
        }
        if hook["weeklogHookId"].as_str() == Some(WEEKLOG_HOOK_ID) {
            return true;
        }
        hook["statusMessage"]
            .as_str()
            .map(|s| s.contains(WEEKLOG_HOOK_ID))
            .unwrap_or(false)
    }

    fn write_plugin_package(root: &Path, endpoint: &str, token: &str) -> Result<(), String> {
        fs::create_dir_all(root.join(".zcode-plugin")).map_err(|e| e.to_string())?;
        fs::create_dir_all(root.join("hooks")).map_err(|e| e.to_string())?;
        write_json(&root.join(".zcode-plugin").join("plugin.json"), &build_plugin_json())?;
        write_json(&root.join(".zcode-plugin-seed.json"), &build_seed_json())?;
        write_json(&root.join("package.json"), &build_package_json())?;
        write_json(&root.join("hooks").join("hooks.json"), &build_hooks_json())?;
        fs::write(
            root.join("hooks").join("post-stop.js"),
            build_post_stop_script(endpoint, token),
        )
        .map_err(|e| e.to_string())
    }

    struct OpResult {
        backup_path: String,
        removed: usize,
    }

    fn upsert_marketplace() -> Result<OpResult, String> {
        let file = marketplace_file();
        let read = read_json(&file);
        if let Some(e) = read.error {
            return Err(format!("ZCode marketplace.json 不是有效 JSON：{}", e));
        }
        let mut data = if read.value.is_object() {
            read.value.clone()
        } else {
            json!({ "name": MARKETPLACE_NAME, "plugins": [], "version": 1 })
        };
        if !data["plugins"].is_array() {
            data["plugins"] = json!([]);
        }
        if let Some(arr) = data["plugins"].as_array_mut() {
            arr.retain(|p| p["name"].as_str() != Some(PLUGIN_NAME));
            arr.push(json!({
                "cachePath": plugin_cache_root().to_string_lossy(),
                "name": PLUGIN_NAME,
                "source": "filesystem",
                "version": PLUGIN_VERSION,
            }));
        }
        let backup_path = if read.exists { backup_file(&file) } else { String::new() };
        write_json(&file, &data)?;
        Ok(OpResult { backup_path, removed: 0 })
    }

    fn remove_from_marketplace() -> Result<OpResult, String> {
        let file = marketplace_file();
        let read = read_json(&file);
        if let Some(e) = read.error {
            return Err(format!("ZCode marketplace.json 不是有效 JSON：{}", e));
        }
        if !read.exists || !read.value["plugins"].is_array() {
            return Ok(OpResult { backup_path: String::new(), removed: 0 });
        }
        let mut data = read.value.clone();
        let before = data["plugins"].as_array().map(|a| a.len()).unwrap_or(0);
        if let Some(arr) = data["plugins"].as_array_mut() {
            arr.retain(|p| p["name"].as_str() != Some(PLUGIN_NAME));
        }
        let after = data["plugins"].as_array().map(|a| a.len()).unwrap_or(0);
        let removed = before - after;
        if removed == 0 {
            return Ok(OpResult { backup_path: String::new(), removed: 0 });
        }
        let backup_path = backup_file(&file);
        write_json(&file, &data)?;
        Ok(OpResult { backup_path, removed })
    }

    fn upsert_enabled_flag() -> Result<OpResult, String> {
        let file = zcode_config_file();
        let read = read_json(&file);
        if let Some(e) = read.error {
            return Err(format!("ZCode config.json 不是有效 JSON：{}", e));
        }
        let mut data = if read.value.is_object() { read.value.clone() } else { json!({}) };
        if !data["plugins"].is_object() {
            data["plugins"] = json!({});
        }
        if !data["plugins"]["enabledPlugins"].is_object() {
            data["plugins"]["enabledPlugins"] = json!({});
        }
        let key = format!("{}@{}", PLUGIN_NAME, MARKETPLACE_NAME);
        if let Some(map) = data["plugins"]["enabledPlugins"].as_object_mut() {
            map.insert(key, json!(true));
        }
        let backup_path = if read.exists { backup_file(&file) } else { String::new() };
        write_json(&file, &data)?;
        Ok(OpResult { backup_path, removed: 0 })
    }

    fn remove_from_enabled_flag() -> Result<OpResult, String> {
        let file = zcode_config_file();
        let read = read_json(&file);
        if let Some(e) = read.error {
            return Err(format!("ZCode config.json 不是有效 JSON：{}", e));
        }
        if !read.exists || !read.value["plugins"]["enabledPlugins"].is_object() {
            return Ok(OpResult { backup_path: String::new(), removed: 0 });
        }
        let key = format!("{}@{}", PLUGIN_NAME, MARKETPLACE_NAME);
        let mut data = read.value.clone();
        let had = data["plugins"]["enabledPlugins"].get(&key).is_some();
        if !had {
            return Ok(OpResult { backup_path: String::new(), removed: 0 });
        }
        if let Some(map) = data["plugins"]["enabledPlugins"].as_object_mut() {
            map.remove(&key);
        }
        let backup_path = backup_file(&file);
        write_json(&file, &data)?;
        Ok(OpResult { backup_path, removed: 1 })
    }

    pub fn install(endpoint: &str, token: &str) -> Value {
        if endpoint.is_empty() || token.is_empty() {
            return json!({ "ok": false, "installed": false, "error": "缺少 endpoint 或 token" });
        }
        let plugin_root = plugin_cache_root();
        let plugin_backup = backup_file(&plugin_root);
        if plugin_root.exists() {
            empty_dir(&plugin_root);
        }
        if let Err(e) = write_plugin_package(&plugin_root, endpoint, token) {
            return json!({ "ok": false, "installed": false, "error": format!("写入插件包失败：{}", e) });
        }
        let market = match upsert_marketplace() {
            Ok(r) => r,
            Err(e) => return json!({ "ok": false, "installed": false, "error": e }),
        };
        let flag = match upsert_enabled_flag() {
            Ok(r) => r,
            Err(e) => return json!({ "ok": false, "installed": false, "error": e }),
        };
        let backups: Vec<String> = [plugin_backup, market.backup_path, flag.backup_path]
            .into_iter()
            .filter(|s| !s.is_empty())
            .collect();
        json!({
            "ok": true,
            "installed": true,
            "pluginPath": plugin_root.to_string_lossy(),
            "marketplacePath": marketplace_file().to_string_lossy(),
            "configPath": zcode_config_file().to_string_lossy(),
            "backups": backups,
        })
    }

    pub fn uninstall() -> Value {
        let plugin_root = plugin_cache_root();
        let mut backups: Vec<String> = vec![];
        let mut removed_files = 0;
        if plugin_root.exists() {
            empty_dir(&plugin_root);
            if fs::remove_dir_all(&plugin_root).is_ok() {
                removed_files += 1;
            }
        }
        let market = match remove_from_marketplace() {
            Ok(r) => r,
            Err(e) => return json!({ "ok": false, "removed": removed_files, "error": e }),
        };
        if !market.backup_path.is_empty() {
            backups.push(market.backup_path);
        }
        let flag = match remove_from_enabled_flag() {
            Ok(r) => r,
            Err(e) => return json!({ "ok": false, "removed": removed_files, "error": e }),
        };
        if !flag.backup_path.is_empty() {
            backups.push(flag.backup_path);
        }
        json!({
            "ok": true,
            "removed": removed_files + market.removed + flag.removed,
            "pluginPath": plugin_root.to_string_lossy(),
            "marketplacePath": marketplace_file().to_string_lossy(),
            "configPath": zcode_config_file().to_string_lossy(),
            "backups": backups,
        })
    }

    pub fn install_status() -> Value {
        let plugin_root = plugin_cache_root();
        let hooks_json_path = plugin_root.join("hooks").join("hooks.json");
        let mut installed = false;
        let mut hook_count = 0;
        let mut hook_error = String::new();
        if hooks_json_path.exists() {
            let read = read_json(&hooks_json_path);
            if let Some(e) = read.error {
                hook_error = format!("ZCode 插件 hooks.json 不是有效 JSON：{}", e);
            } else {
                let groups = read.value["hooks"]["Stop"].as_array().cloned().unwrap_or_default();
                for group in &groups {
                    if let Some(hooks) = group["hooks"].as_array() {
                        hook_count += hooks.iter().filter(|h| is_managed_plugin(h)).count();
                    }
                }
                installed = hook_count > 0;
            }
        }
        let market_read = read_json(&marketplace_file());
        let registered = market_read.error.is_none()
            && market_read.value["plugins"]
                .as_array()
                .map(|a| a.iter().any(|p| p["name"].as_str() == Some(PLUGIN_NAME)))
                .unwrap_or(false);
        let cfg_read = read_json(&zcode_config_file());
        let key = format!("{}@{}", PLUGIN_NAME, MARKETPLACE_NAME);
        let enabled = cfg_read.error.is_none()
            && cfg_read.value["plugins"]["enabledPlugins"]
                .get(key.as_str())
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
        json!({
            "pluginPath": plugin_root.to_string_lossy(),
            "marketplacePath": marketplace_file().to_string_lossy(),
            "configPath": zcode_config_file().to_string_lossy(),
            "exists": plugin_root.exists(),
            "installed": installed,
            "registered": registered,
            "enabled": enabled,
            "hookCount": hook_count,
            "error": hook_error,
        })
    }

    /// 注入 ZCode 的 Node post-stop.js 脚本（明文写入插件包）。
    fn build_post_stop_script(endpoint: &str, token: &str) -> String {
        let ep = serde_json::to_string(endpoint).unwrap_or_else(|_| "\"\"".to_string());
        let tk = serde_json::to_string(token).unwrap_or_else(|_| "\"\"".to_string());
        ZCODE_SCRIPT_TEMPLATE
            .replace("__ENDPOINT_JSON__", &ep)
            .replace("__TOKEN_JSON__", &tk)
    }

    const ZCODE_SCRIPT_TEMPLATE: &str = r#"'use strict'
const fs = require('fs')
const http = require('http')
const cp = require('child_process')
const endpoint = __ENDPOINT_JSON__
const token = __TOKEN_JSON__
const MAX_SUMMARY_CHARS = 4000
function stripZcodeMetadata(text) {
  return String(text || '')
    .replace(/<oai-mem-citation>[\s\S]*?<\/oai-mem-citation>/g, '')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .trim()
}
function trimSummary(text) {
  const s = stripZcodeMetadata(text)
  if (s.length <= MAX_SUMMARY_CHARS) return s
  return s.slice(0, MAX_SUMMARY_CHARS - 1).trimEnd() + '…'
}
function textFromValue(value, depth = 0) {
  if (depth > 4 || value == null) return ''
  if (typeof value === 'string') return value.trim()
  if (Array.isArray(value)) {
    return value
      .map((item) => textFromValue(item, depth + 1))
      .filter(Boolean)
      .join('\n\n')
      .trim()
  }
  if (typeof value === 'object') {
    for (const key of ['text', 'content', 'value', 'message', 'summary', 'final_message', 'finalMessage', 'final_response', 'finalResponse']) {
      const picked = textFromValue(value[key], depth + 1)
      if (picked) return picked
    }
  }
  return ''
}
function firstText(...values) {
  for (const value of values) {
    const text = textFromValue(value)
    if (text) return trimSummary(text)
  }
  return ''
}
function readTranscriptSummary(transcriptPath, fsModule = fs) {
  const file = textFromValue(transcriptPath)
  if (!file) return ''
  try {
    if (!fsModule.existsSync(file)) return ''
    const stat = fsModule.statSync(file)
    if (!stat.isFile() || stat.size > 10 * 1024 * 1024) return ''
    const raw = fsModule.readFileSync(file, 'utf8')
    let lastAssistantText = ''
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue
      let item
      try {
        item = JSON.parse(line)
      } catch {
        continue
      }
      const payload = item && (item.payload || item)
      const role = payload && (payload.role || payload.author || (payload.message && payload.message.role))
      const type = payload && payload.type
      const isAssistant =
        role === 'assistant' ||
        type === 'assistant_message' ||
        type === 'assistant' ||
        (type === 'message' && role === 'assistant')
      if (!isAssistant) continue
      const text = firstText(payload.content, payload.message && payload.message.content, payload.text, payload.delta)
      if (text) lastAssistantText = text
    }
    return lastAssistantText
  } catch {
    return ''
  }
}
function deriveZcodeSummary(event, opts = {}) {
  const e = event && typeof event === 'object' ? event : {}
  const direct = firstText(
    e.final_response,
    e.finalResponse,
    e.final_message,
    e.finalMessage,
    e.assistant_response,
    e.assistantResponse,
    e.output_text,
    e.outputText,
    e.summary,
    e.result && e.result.summary,
    e.result && e.result.text,
    e.result && e.result.output_text,
  )
  if (direct) return direct
  const fromTranscript = readTranscriptSummary(
    firstText(e.transcript_path, e.transcriptPath, e.transcript_file, e.transcriptFile, e.transcript),
    opts.fs || fs
  )
  return fromTranscript
}
function run(cmd, args) {
  try {
    return cp.execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 1000 }).trim()
  } catch {
    return ''
  }
}
function parseInput() {
  try {
    if (process.stdin.isTTY) return {}
    const raw = fs.readFileSync(0, 'utf8')
    return raw.trim() ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}
const event = parseInput()
const summary = deriveZcodeSummary(event, { fs })
if (!summary) process.exit(0)
const changed = run('git', ['diff', '--name-only', 'HEAD'])
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean)
const statusFiles = run('git', ['status', '--short'])
  .split(/\r?\n/)
  .map((line) => line.slice(3).trim())
  .filter(Boolean)
const changedFiles = Array.from(new Set([...changed, ...statusFiles])).slice(0, 80)
const payload = JSON.stringify({
  source: 'zcode',
  cwd: process.cwd(),
  summary,
  title: firstText(event.title, event.prompt),
  branch: run('git', ['branch', '--show-current']) || run('git', ['rev-parse', '--short', 'HEAD']),
  changedFiles,
  finishedAt: new Date().toISOString(),
})
const req = http.request(endpoint, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    Authorization: 'Bearer ' + token,
  },
}, (res) => res.resume())
req.on('error', () => {})
req.end(payload)
"#;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_codex_strips_citation_only() {
        let input = "前<oai-mem-citation>x</oai-mem-citation>后<think>t</think>";
        // codex 只清 oai-mem-citation，保留 <think>
        assert_eq!(sanitize_summary(HookKind::Codex, input), "前后<think>t</think>");
    }

    #[test]
    fn sanitize_zcode_strips_all_blocks() {
        let input = "前<oai-mem-citation>x</oai-mem-citation>中<system-reminder>s</system-reminder>后<think>t</think>";
        assert_eq!(sanitize_summary(HookKind::Zcode, input), "前中后");
    }

    #[test]
    fn sanitize_truncates_over_limit() {
        let input = "a".repeat(5000);
        let out = sanitize_summary(HookKind::Codex, &input);
        assert_eq!(out.chars().count(), MAX_SUMMARY_CHARS);
        assert!(out.ends_with('…'));
    }

    #[test]
    fn match_project_longest_prefix_wins() {
        let cfg = json!({
            "repos": [
                { "path": "/a", "name": "RepoA" },
                { "path": "/a/b", "alias": "RepoB" },
            ]
        });
        // 最长前缀 /a/b 命中，取 alias
        let got = match_project(&format!("{}{}", lexical_normalize("/a/b"), ""), &cfg);
        assert_eq!(got, "RepoB");
    }

    #[test]
    fn match_project_falls_back_to_basename() {
        let cfg = json!({ "repos": [] });
        let got = match_project(&lexical_normalize("/x/y/myproj"), &cfg);
        assert_eq!(got, "myproj");
    }

    #[test]
    fn id_prefix_matches_kind() {
        assert!(new_id(HookKind::Codex.id_prefix()).starts_with("cpn_"));
        assert!(new_id(HookKind::Zcode.id_prefix()).starts_with("zpn_"));
    }

    #[test]
    fn token_is_64_hex_chars() {
        let t = random_token();
        assert_eq!(t.len(), 64);
        assert!(t.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn codex_snippet_has_stop_hook() {
        let s = codex_config::build_hook_snippet("http://127.0.0.1:17321/api/codex/pending-notes", "tok");
        assert!(s.contains("\"Stop\""));
        assert!(s.contains("weeklog-codex-pending-note"));
    }

    #[test]
    fn zcode_snippet_mentions_plugin() {
        let s = zcode_config::build_hook_snippet("http://127.0.0.1:17322/api/zcode/pending-notes", "tok");
        assert!(s.contains("weeklog-pending-note"));
        assert!(s.contains("weeklog-hooks"));
    }
}
