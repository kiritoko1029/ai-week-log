//! 一键集成安装器：把 WeekLog 的 AI 小记能力（skill + MCP 注册）装进 codex / claude code / zcode，
//! 并清理旧 hook 子系统遗留的工件。
//!
//! 对每个 agent 依次：
//!  (a) 清理旧 weeklog hook（codex hooks.json 内的托管 hook；zcode 插件包 + marketplace + enabledPlugins）。
//!  (b) 写入内置 skill（SKILL.md + record-note.mjs + weeklog.json{endpoint,token,source,sessionsDirs}）。
//!  (c) 注册 WeekLog MCP 服务到各 agent 配置：
//!      - codex `~/.codex/config.toml` → `[mcp_servers.weeklog]`（type=streamable-http + headers/http_headers）。
//!      - claude `~/.claude.json` → `mcpServers.weeklog`（type=http + headers）。
//!      - zcode `~/.zcode/cli/config.json` → `mcp.servers.weeklog`（type=http + headers/http_headers）。
//!
//! 写入前对受影响配置做 `.weeklog-backup-<时间戳>` 备份。

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::{logger, mcp};
use tauri::AppHandle;

const SKILL_NAME: &str = "weeklog-ai-note";
const SKILL_MD: &str = include_str!("../resources/skill/SKILL.md");
const RECORD_NOTE: &str = include_str!("../resources/skill/record-note.mjs");

const AGENTS: [&str; 3] = ["codex", "claude", "zcode"];

// ── 路径辅助 ──

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

fn claude_home() -> PathBuf {
    home_dir().join(".claude")
}

fn zcode_home() -> PathBuf {
    std::env::var_os("ZCODE_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home_dir().join(".zcode"))
}

/// agent 主目录（用于判断该 agent 是否在本机存在）。
fn agent_home(agent: &str) -> PathBuf {
    match agent {
        "codex" => codex_home(),
        "claude" => claude_home(),
        "zcode" => zcode_home(),
        _ => PathBuf::new(),
    }
}

fn agent_skill_dir(agent: &str) -> PathBuf {
    match agent {
        "codex" => codex_home().join("skills").join(SKILL_NAME),
        "claude" => claude_home().join("skills").join(SKILL_NAME),
        "zcode" => zcode_home().join("skills").join(SKILL_NAME),
        _ => PathBuf::new(),
    }
}

fn agent_config_path(agent: &str) -> PathBuf {
    match agent {
        "codex" => codex_home().join("config.toml"),
        "claude" => home_dir().join(".claude.json"),
        "zcode" => zcode_home().join("cli").join("config.json"),
        _ => PathBuf::new(),
    }
}

/// 该 agent 的会话 transcript 搜索目录（写入 weeklog.json 供脚本探测）。
fn agent_sessions_dirs(agent: &str) -> Vec<String> {
    let to_s = |p: PathBuf| p.to_string_lossy().to_string();
    match agent {
        "codex" => vec![to_s(codex_home().join("sessions"))],
        "claude" => vec![to_s(claude_home().join("projects"))],
        "zcode" => vec![
            to_s(zcode_home().join("projects")),
            to_s(zcode_home().join("cli").join("rollout")),
            to_s(zcode_home().join("v2")),
        ],
        _ => vec![],
    }
}

// ── 备份 / JSON IO ──

fn timestamp() -> String {
    crate::utils::now_iso().replace([':', '.'], "-")
}

fn backup_file(file: &Path) -> Option<String> {
    if !file.exists() {
        return None;
    }
    let backup = format!("{}.weeklog-backup-{}", file.to_string_lossy(), timestamp());
    fs::copy(file, &backup).ok().map(|_| backup)
}

fn read_json_obj(file: &Path) -> Result<Value, String> {
    if !file.exists() {
        return Ok(json!({}));
    }
    let text = fs::read_to_string(file).map_err(|e| e.to_string())?;
    if text.trim().is_empty() {
        return Ok(json!({}));
    }
    serde_json::from_str(&text).map_err(|e| format!("{} 不是有效 JSON：{}", file.to_string_lossy(), e))
}

fn write_json(file: &Path, value: &Value) -> Result<(), String> {
    if let Some(dir) = file.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let text = format!("{}\n", serde_json::to_string_pretty(value).map_err(|e| e.to_string())?);
    fs::write(file, text).map_err(|e| e.to_string())
}

// ── skill 安装 ──

fn write_skill(agent: &str, endpoint: &str, token: &str) -> Result<String, String> {
    let dir = agent_skill_dir(agent);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    fs::write(dir.join("SKILL.md"), SKILL_MD).map_err(|e| e.to_string())?;
    fs::write(dir.join("record-note.mjs"), RECORD_NOTE).map_err(|e| e.to_string())?;
    let weeklog_json = json!({
        "endpoint": endpoint,
        "token": token,
        "source": agent,
        "sessionsDirs": agent_sessions_dirs(agent),
    });
    write_json(&dir.join("weeklog.json"), &weeklog_json)?;
    Ok(dir.to_string_lossy().to_string())
}

fn skill_installed(agent: &str) -> bool {
    let dir = agent_skill_dir(agent);
    dir.join("record-note.mjs").exists() && dir.join("SKILL.md").exists()
}

fn remove_skill(agent: &str) -> bool {
    let dir = agent_skill_dir(agent);
    if dir.exists() {
        let _ = fs::remove_dir_all(&dir);
        return true;
    }
    false
}

// ── MCP 注册：codex（TOML）──

fn register_codex_mcp(endpoint: &str, token: &str) -> Result<Option<String>, String> {
    use toml_edit::{value, DocumentMut, Item, Table};
    let file = agent_config_path("codex");
    let text = fs::read_to_string(&file).unwrap_or_default();
    let mut doc = text
        .parse::<DocumentMut>()
        .map_err(|e| format!("{} 解析失败：{}", file.to_string_lossy(), e))?;
    let backup = backup_file(&file);

    let servers = doc
        .as_table_mut()
        .entry("mcp_servers")
        .or_insert(Item::Table(Table::new()));
    let servers_tbl = servers
        .as_table_mut()
        .ok_or_else(|| "mcp_servers 不是表".to_string())?;

    let auth = format!("Bearer {token}");
    let mut weeklog = Table::new();
    weeklog.insert("type", value("streamable-http"));
    weeklog.insert("url", value(endpoint));
    let mut headers = Table::new();
    headers.insert("Authorization", value(auth.clone()));
    weeklog.insert("headers", Item::Table(headers));
    let mut http_headers = Table::new();
    http_headers.insert("Authorization", value(auth));
    weeklog.insert("http_headers", Item::Table(http_headers));
    servers_tbl.insert("weeklog", Item::Table(weeklog));

    fs::write(&file, doc.to_string()).map_err(|e| e.to_string())?;
    Ok(backup)
}

fn unregister_codex_mcp() -> Result<(bool, Option<String>), String> {
    use toml_edit::DocumentMut;
    let file = agent_config_path("codex");
    if !file.exists() {
        return Ok((false, None));
    }
    let text = fs::read_to_string(&file).map_err(|e| e.to_string())?;
    let mut doc = text
        .parse::<DocumentMut>()
        .map_err(|e| format!("{} 解析失败：{}", file.to_string_lossy(), e))?;
    let had = doc
        .get("mcp_servers")
        .and_then(|s| s.as_table())
        .map(|t| t.contains_key("weeklog"))
        .unwrap_or(false);
    if !had {
        return Ok((false, None));
    }
    let backup = backup_file(&file);
    if let Some(t) = doc.get_mut("mcp_servers").and_then(|s| s.as_table_mut()) {
        t.remove("weeklog");
    }
    fs::write(&file, doc.to_string()).map_err(|e| e.to_string())?;
    Ok((true, backup))
}

fn codex_mcp_registered() -> bool {
    let file = agent_config_path("codex");
    let text = match fs::read_to_string(&file) {
        Ok(t) => t,
        Err(_) => return false,
    };
    text.parse::<toml_edit::DocumentMut>()
        .map(|doc| {
            doc.get("mcp_servers")
                .and_then(|s| s.as_table())
                .map(|t| t.contains_key("weeklog"))
                .unwrap_or(false)
        })
        .unwrap_or(false)
}

// ── MCP 注册：claude（~/.claude.json，顶层 mcpServers）──

fn register_claude_mcp(endpoint: &str, token: &str) -> Result<Option<String>, String> {
    let file = agent_config_path("claude");
    let mut root = read_json_obj(&file)?;
    let backup = backup_file(&file);
    if !root["mcpServers"].is_object() {
        root["mcpServers"] = json!({});
    }
    root["mcpServers"]["weeklog"] = json!({
        "type": "http",
        "url": endpoint,
        "headers": {
            "Authorization": format!("Bearer {token}"),
            "Accept": "application/json, text/event-stream"
        }
    });
    write_json(&file, &root)?;
    Ok(backup)
}

fn unregister_claude_mcp() -> Result<(bool, Option<String>), String> {
    let file = agent_config_path("claude");
    if !file.exists() {
        return Ok((false, None));
    }
    let mut root = read_json_obj(&file)?;
    let had = root["mcpServers"]["weeklog"].is_object();
    if !had {
        return Ok((false, None));
    }
    let backup = backup_file(&file);
    if let Some(map) = root["mcpServers"].as_object_mut() {
        map.remove("weeklog");
    }
    write_json(&file, &root)?;
    Ok((true, backup))
}

fn claude_mcp_registered() -> bool {
    read_json_obj(&agent_config_path("claude"))
        .map(|root| root["mcpServers"]["weeklog"].is_object())
        .unwrap_or(false)
}

// ── MCP 注册：zcode（~/.zcode/cli/config.json，mcp.servers）──

fn register_zcode_mcp(endpoint: &str, token: &str) -> Result<Option<String>, String> {
    let file = agent_config_path("zcode");
    let mut root = read_json_obj(&file)?;
    let backup = backup_file(&file);
    if !root["mcp"].is_object() {
        root["mcp"] = json!({});
    }
    if !root["mcp"]["servers"].is_object() {
        root["mcp"]["servers"] = json!({});
    }
    let auth = format!("Bearer {token}");
    root["mcp"]["servers"]["weeklog"] = json!({
        "type": "http",
        "url": endpoint,
        "headers": { "Authorization": auth },
        "http_headers": { "Authorization": auth },
    });
    write_json(&file, &root)?;
    Ok(backup)
}

fn unregister_zcode_mcp() -> Result<(bool, Option<String>), String> {
    let file = agent_config_path("zcode");
    if !file.exists() {
        return Ok((false, None));
    }
    let mut root = read_json_obj(&file)?;
    let had = root["mcp"]["servers"]["weeklog"].is_object();
    if !had {
        return Ok((false, None));
    }
    let backup = backup_file(&file);
    if let Some(map) = root["mcp"]["servers"].as_object_mut() {
        map.remove("weeklog");
    }
    write_json(&file, &root)?;
    Ok((true, backup))
}

fn zcode_mcp_registered() -> bool {
    read_json_obj(&agent_config_path("zcode"))
        .map(|root| root["mcp"]["servers"]["weeklog"].is_object())
        .unwrap_or(false)
}

fn register_mcp(agent: &str, endpoint: &str, token: &str) -> Result<Option<String>, String> {
    match agent {
        "codex" => register_codex_mcp(endpoint, token),
        "claude" => register_claude_mcp(endpoint, token),
        "zcode" => register_zcode_mcp(endpoint, token),
        _ => Err(format!("未知 agent：{agent}")),
    }
}

fn unregister_mcp(agent: &str) -> Result<(bool, Option<String>), String> {
    match agent {
        "codex" => unregister_codex_mcp(),
        "claude" => unregister_claude_mcp(),
        "zcode" => unregister_zcode_mcp(),
        _ => Ok((false, None)),
    }
}

fn mcp_registered(agent: &str) -> bool {
    match agent {
        "codex" => codex_mcp_registered(),
        "claude" => claude_mcp_registered(),
        "zcode" => zcode_mcp_registered(),
        _ => false,
    }
}

// ── 旧 hook 清理 ──

const CODEX_LEGACY_HOOK_ID: &str = "weeklog-codex-pending-note";

fn legacy_codex_cleanup() -> Value {
    let file = codex_home().join("hooks.json");
    if !file.exists() {
        return json!({ "removed": 0 });
    }
    let parsed: Value = match fs::read_to_string(&file)
        .map_err(|e| e.to_string())
        .and_then(|t| serde_json::from_str::<Value>(&t).map_err(|e| e.to_string()))
    {
        Ok(v) => v,
        Err(e) => return json!({ "removed": 0, "error": e }),
    };
    let mut config = if parsed.is_object() { parsed } else { json!({}) };
    let groups = config["hooks"]["Stop"].as_array().cloned().unwrap_or_default();
    let mut removed = 0usize;
    let mut next: Vec<Value> = vec![];
    for group in groups {
        let hooks = group["hooks"].as_array().cloned().unwrap_or_default();
        let orig = hooks.len();
        let kept: Vec<Value> = hooks
            .into_iter()
            .filter(|h| {
                let managed = h["weeklogHookId"].as_str() == Some(CODEX_LEGACY_HOOK_ID)
                    || h["statusMessage"]
                        .as_str()
                        .map(|s| s.contains(CODEX_LEGACY_HOOK_ID))
                        .unwrap_or(false);
                if managed {
                    removed += 1;
                }
                !managed
            })
            .collect();
        if orig == 0 || !kept.is_empty() {
            let mut g = group.clone();
            g["hooks"] = Value::Array(kept);
            next.push(g);
        }
    }
    if removed == 0 {
        return json!({ "removed": 0 });
    }
    let backup = backup_file(&file);
    if let Some(hooks) = config["hooks"].as_object_mut() {
        hooks.insert("Stop".to_string(), Value::Array(next));
    }
    if let Err(e) = write_json(&file, &config) {
        return json!({ "removed": 0, "error": e });
    }
    json!({ "removed": removed, "backup": backup })
}

fn legacy_zcode_cleanup() -> Value {
    let mut removed = 0usize;
    let cache = zcode_home()
        .join("cli")
        .join("plugins")
        .join("cache")
        .join("weeklog-hooks");
    let marketplace = zcode_home()
        .join("cli")
        .join("plugins")
        .join("marketplaces")
        .join("weeklog-hooks");
    for dir in [&cache, &marketplace] {
        if dir.exists() && fs::remove_dir_all(dir).is_ok() {
            removed += 1;
        }
    }
    // config.json：移除 enabledPlugins 里所有 weeklog-pending-note@* 键
    let file = agent_config_path("zcode");
    if let Ok(mut root) = read_json_obj(&file) {
        if let Some(map) = root["plugins"]["enabledPlugins"].as_object_mut() {
            let keys: Vec<String> = map
                .keys()
                .filter(|k| k.starts_with("weeklog-pending-note@"))
                .cloned()
                .collect();
            if !keys.is_empty() {
                let _ = backup_file(&file);
                for k in keys {
                    map.remove(&k);
                    removed += 1;
                }
                let _ = write_json(&file, &root);
            }
        }
    }
    json!({ "removed": removed })
}

fn legacy_cleanup(agent: &str) -> Value {
    match agent {
        "codex" => legacy_codex_cleanup(),
        "zcode" => legacy_zcode_cleanup(),
        _ => json!({ "removed": 0 }),
    }
}

// ── 对外：status / install / uninstall ──

fn normalize_agents(agents: Vec<String>) -> Vec<String> {
    if agents.is_empty() {
        return AGENTS.iter().map(|s| s.to_string()).collect();
    }
    agents
        .into_iter()
        .map(|a| a.trim().to_lowercase())
        .filter(|a| AGENTS.contains(&a.as_str()))
        .collect()
}

pub fn status(app: &AppHandle, server: &mcp::McpServer) -> Value {
    let mut agents = serde_json::Map::new();
    for agent in AGENTS {
        agents.insert(
            agent.to_string(),
            json!({
                "present": agent_home(agent).exists(),
                "skillInstalled": skill_installed(agent),
                "mcpRegistered": mcp_registered(agent),
                "skillPath": agent_skill_dir(agent).to_string_lossy(),
                "configPath": agent_config_path(agent).to_string_lossy(),
            }),
        );
    }
    json!({
        "mcp": server.status_value(app),
        "agents": Value::Object(agents),
    })
}

pub fn install(app: &AppHandle, server: &mcp::McpServer, agents: Vec<String>) -> Value {
    // 确保 MCP 服务在跑，拿到正确 endpoint + token
    server.apply_config(app);
    let token = mcp::ensure_token();
    let mcp_status = server.status_value(app);
    let endpoint = mcp_status["endpoint"].as_str().unwrap_or("").to_string();
    if endpoint.is_empty() || token.is_empty() {
        return json!({ "ok": false, "error": "MCP 服务未就绪（无 endpoint 或 token）", "mcp": mcp_status });
    }

    let mut results = serde_json::Map::new();
    let mut ok_all = true;
    for agent in normalize_agents(agents) {
        let cleanup = legacy_cleanup(&agent);
        let skill = write_skill(&agent, &endpoint, &token);
        let reg = register_mcp(&agent, &endpoint, &token);
        let agent_ok = skill.is_ok() && reg.is_ok();
        if !agent_ok {
            ok_all = false;
        }
        let entry = json!({
            "ok": agent_ok,
            "legacyCleanup": cleanup,
            "skillPath": skill.as_ref().ok().cloned(),
            "skillError": skill.as_ref().err().cloned(),
            "mcpBackup": reg.as_ref().ok().and_then(|b| b.clone()),
            "mcpError": reg.as_ref().err().cloned(),
        });
        results.insert(agent, entry);
    }
    logger::write_log(
        app,
        "info",
        "integration",
        "一键安装 AI 小记集成",
        json!({ "endpoint": endpoint, "results": results }),
    );
    json!({ "ok": ok_all, "endpoint": endpoint, "mcp": server.status_value(app), "results": Value::Object(results) })
}

pub fn uninstall(app: &AppHandle, agents: Vec<String>) -> Value {
    let mut results = serde_json::Map::new();
    let mut ok_all = true;
    for agent in normalize_agents(agents) {
        let cleanup = legacy_cleanup(&agent);
        let skill_removed = remove_skill(&agent);
        let reg = unregister_mcp(&agent);
        let agent_ok = reg.is_ok();
        if !agent_ok {
            ok_all = false;
        }
        let entry = json!({
            "ok": agent_ok,
            "legacyCleanup": cleanup,
            "skillRemoved": skill_removed,
            "mcpRemoved": reg.as_ref().ok().map(|(removed, _)| *removed).unwrap_or(false),
            "mcpBackup": reg.as_ref().ok().and_then(|(_, b)| b.clone()),
            "mcpError": reg.as_ref().err().cloned(),
        });
        results.insert(agent, entry);
    }
    logger::write_log(
        app,
        "info",
        "integration",
        "卸载 AI 小记集成",
        json!({ "results": results }),
    );
    json!({ "ok": ok_all, "results": Value::Object(results) })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_agents_defaults_to_all() {
        assert_eq!(normalize_agents(vec![]), vec!["codex", "claude", "zcode"]);
    }

    #[test]
    fn normalize_agents_filters_unknown() {
        let got = normalize_agents(vec!["codex".into(), "bogus".into(), "ZCODE".into()]);
        assert_eq!(got, vec!["codex", "zcode"]);
    }

    #[test]
    fn skill_resources_are_bundled() {
        assert!(SKILL_MD.contains("weeklog-ai-note"));
        assert!(RECORD_NOTE.contains("submit_conversation"));
    }
}
