//! 应用日志：对齐 src/main/logger.js。
//! append-only JSONL，存于 app_config_dir/logs/weeklog.log，敏感字段脱敏。

use std::fs;
use std::path::PathBuf;
use std::sync::LazyLock;

use regex::Regex;
use serde_json::{json, Map, Value};
use tauri::{AppHandle, Manager};

const LOG_DIR: &str = "logs";
const LOG_FILE: &str = "weeklog.log";
const MAX_LINE_COUNT: usize = 2000;

static SENSITIVE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)password|authorization|api[_-]?key|secret|token").unwrap());

fn log_file(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|d| d.join(LOG_DIR).join(LOG_FILE))
}

/// 日志文件路径字符串（对齐 logger.js logPath）。
pub fn log_path(app: &AppHandle) -> String {
    log_file(app)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default()
}

fn truncate_str(s: &str) -> String {
    if s.chars().count() > 1000 {
        let head: String = s.chars().take(1000).collect();
        format!("{head}...")
    } else {
        s.to_string()
    }
}

/// 递归脱敏（对齐 logger.js sanitize）。
fn sanitize(value: &Value) -> Value {
    match value {
        Value::String(s) => Value::String(truncate_str(s)),
        Value::Array(a) => Value::Array(a.iter().map(sanitize).collect()),
        Value::Object(o) => {
            let mut out = Map::new();
            for (key, item) in o {
                if SENSITIVE_RE.is_match(key) {
                    out.insert(key.clone(), json!("[redacted]"));
                } else {
                    out.insert(key.clone(), sanitize(item));
                }
            }
            Value::Object(out)
        }
        other => other.clone(),
    }
}

/// 写一条日志（对齐 logger.js createLogger().<level>）。
pub fn write_log(app: &AppHandle, level: &str, scope: &str, message: &str, data: Value) {
    let Some(file) = log_file(app) else { return };
    if let Some(dir) = file.parent() {
        if fs::create_dir_all(dir).is_err() {
            return;
        }
    }
    let entry = json!({
        "ts": crate::utils::now_iso(),
        "level": level,
        "scope": scope,
        "message": message,
        "data": sanitize(&data),
    });
    if let Ok(line) = serde_json::to_string(&entry) {
        use std::io::Write;
        if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(&file) {
            let _ = writeln!(f, "{line}");
        }
    }
}

/// 读取最近 limit 条日志（倒序，对齐 logger.js listLogs）。
pub fn list_logs(app: &AppHandle, limit: Option<usize>) -> Vec<Value> {
    let Some(file) = log_file(app) else {
        return Vec::new();
    };
    let Ok(raw) = fs::read_to_string(&file) else {
        return Vec::new();
    };
    let lines: Vec<&str> = raw.split('\n').filter(|l| !l.trim().is_empty()).collect();
    let n = limit.unwrap_or(500).clamp(1, MAX_LINE_COUNT);
    let start = lines.len().saturating_sub(n);
    let mut out: Vec<Value> = lines[start..]
        .iter()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .filter(|v| v.is_object())
        .collect();
    out.reverse();
    out
}

/// 清空日志（对齐 logger.js clearLogs）。
pub fn clear_logs(app: &AppHandle) -> Value {
    if let Some(file) = log_file(app) {
        if let Some(dir) = file.parent() {
            let _ = fs::create_dir_all(dir);
        }
        let _ = fs::write(&file, "");
    }
    json!({ "ok": true })
}
