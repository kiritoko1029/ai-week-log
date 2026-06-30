//! 统一「AI 小记待处理池」（取代旧的 codex/zcode 双池）。
//!
//! 设计：MCP 服务（mcp.rs）在收到 AI agent 经 skill 发来的对话并总结后，把候选小记
//! 写入单一池文件 `ai-notes-pending.json`；正式写入 `notes/YYYY-MM-DD.md` 仍由用户在前端确认。
//! item 带 `source`（codex/claude/zcode/…），前端按来源展示徽标。
//!
//! 本模块只保留池的 CRUD + 规范化 + AI 合并总结，不再包含任何 hook 注入/本地 HTTP 接收逻辑
//! （后者已由 mcp.rs 取代）。

use std::collections::HashSet;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::LazyLock;

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::{config, llm, notes, secrets, utils};

const STORE_FILE: &str = "ai-notes-pending.json";
const MAX_SUMMARY_CHARS: usize = 4000;

// ── summary 清洗 ──

static RE_OAI: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"(?s)<oai-mem-citation>.*?</oai-mem-citation>").unwrap());
static RE_SYSREM: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"(?s)<system-reminder>.*?</system-reminder>").unwrap());
static RE_THINK: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"(?s)<think>.*?</think>").unwrap());

fn strip_metadata(text: &str) -> String {
    let mut s = RE_OAI.replace_all(text, "").into_owned();
    s = RE_SYSREM.replace_all(&s, "").into_owned();
    s = RE_THINK.replace_all(&s, "").into_owned();
    s.trim().to_string()
}

/// 清洗 + 截断到 MAX_SUMMARY_CHARS（超长则 slice(0,N-1)+'…'）。
pub fn sanitize_summary(text: &str) -> String {
    let s = strip_metadata(text);
    if s.chars().count() <= MAX_SUMMARY_CHARS {
        s
    } else {
        let truncated: String = s.chars().take(MAX_SUMMARY_CHARS - 1).collect();
        format!("{}…", truncated.trim_end())
    }
}

/// 来源展示名（用于写入小记的来源标注与合并总结 prompt）。
fn source_label(source: &str) -> String {
    match source {
        "codex" => "Codex".to_string(),
        "zcode" => "ZCode".to_string(),
        "claude" => "Claude Code".to_string(),
        other if !other.is_empty() => other.to_string(),
        _ => "AI".to_string(),
    }
}

// ── 基础目录 / 存储 IO ──

fn base_dir(app: &AppHandle) -> PathBuf {
    app.path().app_config_dir().unwrap_or_default()
}

fn store_path(app: &AppHandle) -> PathBuf {
    base_dir(app).join(STORE_FILE)
}

fn normalize_stored_item(item: &Value) -> Value {
    if !item.is_object() {
        return item.clone();
    }
    let mut it = item.clone();
    it["summary"] = json!(sanitize_summary(item["summary"].as_str().unwrap_or("")));
    it
}

/// 读取并规范化整个池（{schemaVersion, items}）：重洗 summary，丢弃「pending 且 summary 为空」的条目。
pub fn read_store(app: &AppHandle) -> Value {
    let path = store_path(app);
    if let Ok(text) = fs::read_to_string(&path) {
        if let Ok(data) = serde_json::from_str::<Value>(&text) {
            if let Some(items) = data.get("items").and_then(|v| v.as_array()) {
                let normalized: Vec<Value> = items
                    .iter()
                    .map(normalize_stored_item)
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

fn write_store(app: &AppHandle, data: &Value) -> Result<(), String> {
    let dir = base_dir(app);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let text = serde_json::to_string_pretty(data).map_err(|e| e.to_string())?;
    fs::write(store_path(app), text).map_err(|e| e.to_string())
}

// ── payload 规范化 ──

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

/// 词法归一化路径（解析 . / ..，统一分隔符），用于 match_project 前缀匹配。
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

/// 按 repos[].path 对 cwd 做最长前缀匹配，返回 name/alias/basename。
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

fn normalize_payload(payload: &Value, cfg: &Value) -> Result<Value, String> {
    let raw_summary = payload["summary"]
        .as_str()
        .filter(|s| !s.is_empty())
        .or_else(|| payload["content"].as_str().filter(|s| !s.is_empty()))
        .or_else(|| payload["text"].as_str().filter(|s| !s.is_empty()))
        .unwrap_or("");
    let summary = sanitize_summary(raw_summary);
    if summary.is_empty() {
        return Err("summary 不能为空".to_string());
    }
    let source = {
        let s = payload["source"].as_str().unwrap_or("").trim();
        if s.is_empty() { "ai".to_string() } else { s.to_string() }
    };
    let cwd = payload["cwd"].as_str().unwrap_or("").trim().to_string();
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
        "id": utils::gen_id("apn_"),
        "source": source,
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

/// 列出 pending 小记，按 createdAt 降序；source_filter 为空则全部，否则仅该来源。
pub fn list_pending(app: &AppHandle, source_filter: Option<&str>) -> Value {
    let store = read_store(app);
    let mut items: Vec<Value> = store["items"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter(|it| it["status"].as_str() == Some("pending"))
                .filter(|it| match source_filter {
                    Some(src) if !src.is_empty() => it["source"].as_str() == Some(src),
                    _ => true,
                })
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

/// 写入一条候选小记到池，返回规范化后的 item（供 mcp.rs 调用）。
pub fn add_pending(app: &AppHandle, payload: &Value, cfg: &Value) -> Result<Value, String> {
    let mut store = read_store(app);
    let item = normalize_payload(payload, cfg)?;
    if let Some(arr) = store["items"].as_array_mut() {
        arr.insert(0, item.clone());
    } else {
        store["items"] = json!([item.clone()]);
    }
    write_store(app, &store)?;
    Ok(item)
}

fn update_status(
    app: &AppHandle,
    ids: &[String],
    status: &str,
    extra: &[(&str, Value)],
) -> usize {
    let wanted: HashSet<&str> = ids.iter().filter(|s| !s.is_empty()).map(|s| s.as_str()).collect();
    let mut store = read_store(app);
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
    let _ = write_store(app, &store);
    count
}

pub fn delete_pending(app: &AppHandle, ids: Vec<String>) -> Value {
    let deleted_at = utils::now_iso();
    let count = update_status(app, &ids, "deleted", &[("deletedAt", json!(deleted_at))]);
    json!({ "deleted": count })
}

fn date_from_created_at(created_at: &str) -> String {
    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(created_at) {
        return utils::iso_date(dt.with_timezone(&chrono::Local).date_naive());
    }
    utils::iso_date(utils::today())
}

/// 单条小记的写入文本：summary + 可选的来源/分支/改动文件标注。
fn content_for_item(item: &Value) -> String {
    let summary = item["summary"].as_str().unwrap_or("");
    let source = item["source"].as_str().unwrap_or("ai");
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
            source_label(source),
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

/// 把选中的 pending 小记写入正式 notes/YYYY-MM-DD.md。
pub fn write_pending(
    app: &AppHandle,
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
    let mut store = read_store(app);
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
        let _ = write_store(app, &store);
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
                        (id.clone(), created, proj, content_for_item(it))
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
    let _ = write_store(app, &store);
    json!({ "written": written, "files": files })
}

// ── AI 合并总结（多选 → 一条）──

fn summary_system() -> String {
    "你是一名研发工作小记整理助手。\n请把多条 AI 候选小记合并成一条适合写入日报/周报素材的中文小记。\n要求：客观、简洁、书面化；保留真实完成事项和价值；不要编造未提供的信息。\n直接输出小记内容本身，不要标题、不要解释、不要项目名前缀。".to_string()
}

fn build_summary_prompt(items: &[Value]) -> String {
    let mut lines: Vec<String> = vec!["请整理以下 AI 待处理小记：".to_string(), String::new()];
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

/// AI 合并选中的若干 pending 小记为一条（用主 AI 模型）。
pub async fn summarize_pending(app: &AppHandle, ids: Vec<String>) -> Value {
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
    let store = read_store(app);
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
        .summarize(&summary_system(), &build_summary_prompt(&items))
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_strips_all_meta_blocks() {
        let input = "前<oai-mem-citation>x</oai-mem-citation>中<system-reminder>s</system-reminder>后<think>t</think>";
        assert_eq!(sanitize_summary(input), "前中后");
    }

    #[test]
    fn sanitize_truncates_over_limit() {
        let input = "a".repeat(5000);
        let out = sanitize_summary(&input);
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
        let got = match_project(&lexical_normalize("/a/b"), &cfg);
        assert_eq!(got, "RepoB");
    }

    #[test]
    fn match_project_falls_back_to_basename() {
        let cfg = json!({ "repos": [] });
        let got = match_project(&lexical_normalize("/x/y/myproj"), &cfg);
        assert_eq!(got, "myproj");
    }

    #[test]
    fn source_label_maps_known_sources() {
        assert_eq!(source_label("codex"), "Codex");
        assert_eq!(source_label("zcode"), "ZCode");
        assert_eq!(source_label("claude"), "Claude Code");
        assert_eq!(source_label("custom"), "custom");
    }

    #[test]
    fn normalize_payload_builds_pending_item_from_submit_conversation() {
        // 模拟 mcp::submit_conversation 总结后传入 add_pending 的 payload。
        let cfg = json!({ "repos": [{ "path": "/Users/me/proj", "name": "MyProj" }] });
        let payload = json!({
            "source": "codex",
            "summary": "完成了登录态丢失的修复<think>内部</think>",
            "cwd": "/Users/me/proj/sub",
            "branch": "main",
            "changedFiles": ["a.rs", "a.rs", "b.rs"],
            "title": "修复登录"
        });
        let item = normalize_payload(&payload, &cfg).unwrap();
        assert_eq!(item["source"], json!("codex"));
        assert_eq!(item["status"], json!("pending"));
        assert_eq!(item["project"], json!("MyProj"));
        assert_eq!(item["summary"], json!("完成了登录态丢失的修复"));
        assert_eq!(item["branch"], json!("main"));
        assert_eq!(item["changedFiles"], json!(["a.rs", "b.rs"]));
        assert!(item["id"].as_str().unwrap().starts_with("apn_"));
    }

    #[test]
    fn normalize_payload_defaults_source_and_rejects_empty_summary() {
        let cfg = json!({ "repos": [] });
        // 对话无实质内容（summary 为空）时报错，不入池。
        assert!(normalize_payload(&json!({ "summary": "   " }), &cfg).is_err());
        // source 缺省为 ai；content 字段作为 summary 回退来源。
        let item = normalize_payload(&json!({ "content": "一条小记" }), &cfg).unwrap();
        assert_eq!(item["source"], json!("ai"));
        assert_eq!(item["summary"], json!("一条小记"));
    }
}
