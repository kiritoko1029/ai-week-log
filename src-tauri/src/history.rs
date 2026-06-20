//! 历史报告存档：对齐 src/main/ipc.js 中的 history 读写逻辑。
//! 存于 app_config_dir/history.json，按 (type, rangeStart) 去重覆盖，保留最近 200 条。

use std::fs;
use std::path::PathBuf;

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::utils;

const FILE: &str = "history.json";

fn history_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join(FILE))
}

/// 读取全部历史（对齐 ipc.js readHistory）。
pub fn read_history(app: &AppHandle) -> Vec<Value> {
    if let Some(p) = history_path(app) {
        if let Ok(text) = fs::read_to_string(&p) {
            if let Ok(Value::Array(list)) = serde_json::from_str::<Value>(&text) {
                return list;
            }
        }
    }
    Vec::new()
}

fn write_history(app: &AppHandle, list: &[Value]) -> Result<(), String> {
    let p = history_path(app).ok_or_else(|| "无法定位配置目录".to_string())?;
    if let Some(dir) = p.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string_pretty(list).map_err(|e| e.to_string())?;
    fs::write(&p, text).map_err(|e| e.to_string())
}

/// 浅合并 patch 到 base（对齐 JS `{ ...base, ...patch }`）。
fn shallow_merge(base: &mut Value, patch: &Value) {
    if let (Some(b), Some(p)) = (base.as_object_mut(), patch.as_object()) {
        for (k, v) in p {
            b.insert(k.clone(), v.clone());
        }
    }
}

/// 保存一份报告到历史（对齐 ipc.js saveHistoryEntry）：
/// 按 (type, rangeStart) 去重覆盖、保留最近 200 条，返回保存后的条目（含 id）。
pub fn save_entry(app: &AppHandle, entry: Value) -> Result<Value, String> {
    let mut list = read_history(app);
    let etype = entry.get("type").and_then(|v| v.as_str()).unwrap_or("");
    let erange = entry.get("rangeStart").and_then(|v| v.as_str()).unwrap_or("");
    let exist_idx = list.iter().position(|h| {
        h.get("type").and_then(|v| v.as_str()) == Some(etype)
            && h.get("rangeStart").and_then(|v| v.as_str()) == Some(erange)
    });

    let saved;
    if let Some(idx) = exist_idx {
        // { ...list[idx], ...entry, createdAt: now, edited: false }
        let mut merged = list[idx].clone();
        shallow_merge(&mut merged, &entry);
        if let Some(obj) = merged.as_object_mut() {
            obj.insert("createdAt".to_string(), json!(utils::now_iso()));
            obj.insert("edited".to_string(), json!(false));
        }
        list[idx] = merged.clone();
        saved = merged;
    } else {
        // { id, createdAt, ...entry }
        let mut obj = entry.clone();
        if let Some(map) = obj.as_object_mut() {
            map.insert("id".to_string(), json!(utils::gen_id("r_")));
            map.insert("createdAt".to_string(), json!(utils::now_iso()));
        }
        saved = obj.clone();
        list.insert(0, obj);
    }
    list.truncate(200);
    write_history(app, &list)?;
    Ok(saved)
}

/// 更新某条历史正文（对齐 ipc.js history:update），标记为人工编辑。
pub fn update_entry(app: &AppHandle, id: &str, text: &str) -> bool {
    let mut list = read_history(app);
    let mut hit = false;
    for item in list.iter_mut() {
        if item.get("id").and_then(|v| v.as_str()) == Some(id) {
            if let Some(obj) = item.as_object_mut() {
                obj.insert("text".to_string(), json!(text));
                obj.insert("edited".to_string(), json!(true));
            }
            hit = true;
            break;
        }
    }
    if hit {
        let _ = write_history(app, &list);
    }
    hit
}
