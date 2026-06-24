//! 写作偏好库：对齐 src/main/preferences.js。
//! 存储于 app_config_dir/preferences.json，结构 { items: [{ id, rule, enabled, createdAt }] }。

use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::Value;
use tauri::{AppHandle, Manager};

const FILE: &str = "preferences.json";

fn prefs_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join(FILE))
}

/// 读取全部偏好（对齐 preferences.js readPrefs）。
/// 返回 serde_json::Value 数组，字段名与 JS 一致（id/rule/enabled/createdAt）。
pub fn list_preferences(app: &AppHandle) -> Vec<Value> {
    read_prefs(app)
}

fn read_prefs(app: &AppHandle) -> Vec<Value> {
    if let Some(p) = prefs_path(app) {
        if let Ok(text) = fs::read_to_string(&p) {
            if let Ok(data) = serde_json::from_str::<Value>(&text) {
                if let Some(items) = data.get("items").and_then(|i| i.as_array()) {
                    return items.clone();
                }
            }
        }
    }
    Vec::new()
}

fn write_prefs(app: &AppHandle, items: &[Value]) -> Result<(), String> {
    let p = prefs_path(app).ok_or_else(|| "无法定位配置目录".to_string())?;
    if let Some(dir) = p.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let data = serde_json::json!({ "items": items });
    let text = serde_json::to_string_pretty(&data).map_err(|e| e.to_string())?;
    fs::write(&p, text).map_err(|e| e.to_string())
}

fn new_id() -> String {
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    // 近似 JS：'pf_' + Date.now().toString(36) + random
    format!("pf_{}{}", to_base36(ms as u64), random_str(4))
}

fn to_base36(n: u64) -> String {
    if n == 0 {
        return "0".to_string();
    }
    let digits = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut v = n;
    let mut s = Vec::new();
    while v > 0 {
        s.push(digits[(v % 36) as usize] as char);
        v /= 36;
    }
    s.into_iter().rev().collect()
}

fn random_str(len: usize) -> String {
    // 用时间戳低位做伪随机（够用：id 仅需唯一性）
    let seed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos() as u64)
        .unwrap_or(0);
    let digits = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut v = seed.wrapping_mul(2654435761);
    let mut s = String::new();
    for _ in 0..len {
        s.push(digits[(v % 36) as usize] as char);
        v = v.wrapping_mul(6364136223846793005).wrapping_add(1);
    }
    s
}

fn now_iso() -> String {
    // chrono RFC3339 本地时间（带时区偏移），对齐 JS new Date().toISOString()（UTC Z）。
    // JS 的 toISOString 是 UTC，这里对齐用 UTC。
    use chrono::Utc;
    Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

/// 新增一条偏好（对齐 preferences.js addPreference）。返回新增项 Value 或 None。
pub fn add_preference(app: &AppHandle, rule: &str) -> Result<Option<Value>, String> {
    let text = rule.trim();
    if text.is_empty() {
        return Ok(None);
    }
    let mut items = read_prefs(app);
    let item = serde_json::json!({
        "id": new_id(),
        "rule": text,
        "enabled": true,
        "createdAt": now_iso(),
    });
    // unshift：插到头部
    items.insert(0, item.clone());
    write_prefs(app, &items)?;
    Ok(Some(item))
}

/// 切换启用/禁用（对齐 preferences.js togglePreference）。
pub fn toggle_preference(app: &AppHandle, id: &str, enabled: bool) -> Option<Value> {
    let mut items = read_prefs(app);
    let mut found = None;
    for it in items.iter_mut() {
        if it.get("id").and_then(|v| v.as_str()) == Some(id) {
            if let Some(obj) = it.as_object_mut() {
                obj.insert("enabled".to_string(), Value::Bool(enabled));
            }
            found = Some(it.clone());
            break;
        }
    }
    if found.is_some() {
        let _ = write_prefs(app, &items);
    }
    found
}

/// 删除（对齐 preferences.js removePreference）。返回 { deleted }。
pub fn remove_preference(app: &AppHandle, id: &str) -> Result<i64, String> {
    let items = read_prefs(app);
    let before = items.len();
    let next: Vec<Value> = items
        .into_iter()
        .filter(|it| it.get("id").and_then(|v| v.as_str()) != Some(id))
        .collect();
    let deleted = (before - next.len()) as i64;
    write_prefs(app, &next)?;
    Ok(deleted)
}

/// 仅返回启用的规则文本，供注入报告生成系统提示词（对齐 preferences.js enabledRules）。
pub fn enabled_rules(app: &AppHandle) -> Vec<String> {
    read_prefs(app)
        .iter()
        .filter_map(|p| {
            let enabled = p.get("enabled").and_then(|v| v.as_bool()).unwrap_or(false);
            let rule = p.get("rule").and_then(|v| v.as_str()).unwrap_or("").trim();
            if enabled && !rule.is_empty() {
                Some(rule.to_string())
            } else {
                None
            }
        })
        .collect()
}

/// AI 抽取写作规则的系统提示词（对齐 preferences.js EXTRACT_SYSTEM）。
pub const EXTRACT_SYSTEM: &str = r#"你是一名写作偏好提炼助手。
用户对一份工作周报/日报做了人工修改。请对比"修改前"与"修改后"两段文本，提炼出一条通用、可复用的中文写作规则。
要求：
1. 聚焦"用户希望 AI 今后如何写作"，而非本次具体内容（例：用「灰度发布」代替「上线」；不要以「完成了」开头；语气更口语化）。
2. 若修改仅是增删具体工作内容（非风格/措辞调整），返回「无」。
3. 规则要简短（一句话）、可执行、通用化。
4. 只输出规则本身这一句话，不要解释、不要前缀、不要引号。若判定为无则只输出「无」。"#;

/// 构造抽取规则的 user prompt（对齐 preferences.js buildExtractPrompt）。
pub fn build_extract_prompt(old_text: &str, new_text: &str) -> String {
    format!(
        "请对比以下两段工作周报/日报文本，提炼一条通用写作偏好规则。\n\n【修改前】\n{}\n\n【修改后】\n{}",
        old_text.trim(),
        new_text.trim()
    )
}
