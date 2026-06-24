//! 配置管理：对齐 src/main/config.js。
//! 存储在 Tauri app_config_dir 下的 config.json。
//! 关键：loadConfig 会深合并默认值（mergeConfig），缺失文件时落盘默认值——
//! 渲染层各页面直接访问 config.output.format 等字段，合并保证字段完整。

use std::fs;
use std::path::PathBuf;

use serde_json::{json, Map, Value};
use tauri::{AppHandle, Manager};

const CONFIG_FILE: &str = "config.json";

/// config.json 的默认内容，严格对齐 src/main/config.js defaultConfig()。
/// 任何字段缺失都会导致渲染层访问崩溃，必须保持完整。
pub fn default_config() -> Value {
    let tz = local_tz_name().unwrap_or_else(|| "Asia/Shanghai".to_string());
    json!({
        "schemaVersion": 2,
        "weekStart": "monday",
        "timezone": tz,
        "dateBasis": "author",
        "repos": [],
        "filters": { "author": [], "mergeCommits": "exclude", "excludeGrep": [] },
        "notes": { "enabled": true, "miscProject": "日常工作" },
        "codexHook": { "enabled": false, "port": 17321 },
        "zcodeHook": { "enabled": false, "port": 17322 },
        "ui": { "theme": "auto", "quickNoteShortcut": "CommandOrControl+Shift+L" },
        "ai": {
            "provider": "anthropic",
            "concurrency": 3,
            "retries": 3,
            "timeoutSeconds": 60,
            "anthropic": { "model": "claude-sonnet-4-6", "baseUrl": "", "temperature": 0.3, "maxTokens": 800 },
            "openai": { "model": "gpt-4o", "baseUrl": "", "temperature": 0.3, "maxTokens": 800 },
            "chat": { "maxTokens": 2048, "topK": 6, "historyTurns": 12, "thinking": true }
        },
        "output": {
            "format": "text",
            "newline": "CRLF",
            "withCommits": false,
            "showNotes": false
        },
        "webdav": {
            "enabled": false,
            "url": "",
            "username": "",
            "autoSync": "push",
            "backupRetention": 10
        },
        "memory": {
            "enabled": true,
            "embeddingSource": "local",
            "embeddingModel": "Xenova/multilingual-e5-small",
            "modelSource": "auto",
            "autoGenerate": true,
            "topK": 5
        },
        "proxy": { "mode": "system", "url": "" }
    })
}

/// 尽力返回本地 IANA 时区名（对齐 config.js 用 Intl 获取）。
fn local_tz_name() -> Option<String> {
    // chrono::Local 不直接暴露 IANA 名；优先 TZ 环境变量，否则按系统常见值回退。
    if let Ok(tz) = std::env::var("TZ") {
        if !tz.is_empty() {
            return Some(tz);
        }
    }
    // 读 /etc/timezone（Linux）或常见 Windows 回退；失败则 Asia/Shanghai（由调用方）。
    if let Ok(s) = fs::read_to_string("/etc/timezone") {
        let t = s.trim().to_string();
        if !t.is_empty() {
            return Some(t);
        }
    }
    None
}

fn config_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join(CONFIG_FILE))
}

/// 深合并用户配置到默认配置（对齐 config.js mergeConfig）：
/// 仅逐层对象合并，数组整体替换。
fn merge_config(base: &Value, user: &Value) -> Value {
    match (base, user) {
        (Value::Object(b), Value::Object(u)) => {
            let mut out: Map<String, Value> = b.clone();
            for (k, uv) in u {
                if let Some(bv) = b.get(k) {
                    // 两边都是对象 → 递归合并；否则整体替换
                    out.insert(k.clone(), if bv.is_object() && uv.is_object() {
                        merge_config(bv, uv)
                    } else {
                        uv.clone()
                    });
                } else {
                    out.insert(k.clone(), uv.clone());
                }
            }
            Value::Object(out)
        }
        // 数组或标量：user 整体替换
        (_, u) => u.clone(),
    }
}

/// 加载配置：缺失或损坏则回退默认并落盘（对齐 config.js loadConfig）。
pub fn load_config(app: &AppHandle) -> Value {
    if let Some(p) = config_path(app) {
        if let Ok(text) = fs::read_to_string(&p) {
            if let Ok(user) = serde_json::from_str::<Value>(&text) {
                return merge_config(&default_config(), &user);
            }
            // 损坏：回退默认（对齐 JS：console.error 后用默认）
            eprintln!("[weeklog] 配置解析失败，使用默认配置");
        }
    }
    let cfg = default_config();
    let _ = save_config(app, &cfg);
    cfg
}

/// 保存配置（对齐 config.js saveConfig：目录不存在则创建）。
pub fn save_config(app: &AppHandle, cfg: &Value) -> Result<Value, String> {
    let p = config_path(app).ok_or_else(|| "无法定位配置目录".to_string())?;
    if let Some(dir) = p.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    fs::write(&p, text).map_err(|e| e.to_string())?;
    Ok(cfg.clone())
}

/// 重置配置为默认值并落盘（对齐 ipc.js config:reset）。
pub fn reset_config(app: &AppHandle) -> Result<Value, String> {
    let cfg = default_config();
    save_config(app, &cfg)
}

/// 笔记目录：用户配置的 notesDir，否则回退 userData/notes
/// （对齐 ipc.js config:notesDir 的语义）。
pub fn notes_dir(app: &AppHandle) -> Result<String, String> {
    let cfg = load_config(app);
    // 渲染层 NotesPage / DashboardPage 期望 notesDir 返回可写目录字符串。
    // 这里与 Electron 一致：优先 config 自定义，否则 userData/notes。
    if let Some(custom) = cfg.get("notes").and_then(|n| n.get("dir")).and_then(|d| d.as_str()) {
        if !custom.is_empty() {
            return Ok(custom.to_string());
        }
    }
    let base = app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?;
    Ok(base.join("notes").to_string_lossy().to_string())
}
