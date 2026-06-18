// WeekLog Tauri 2 后端入口（骨架阶段）。
//
// 骨架目标：
// 1. 启动两个窗口：main（index.html）与 quicknote（quicknote.html）。
// 2. 实现 config_get / env_git_ok 两个 command，验证渲染层桥接链路。
// 3. 预留 quicknote 全局唤起事件通道。
//
// 本文件为 lib crate 入口，移动端/桌面端共用；真正的 main 在 src/main.rs 调用 run()。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::process::Command;
use std::sync::Mutex;

use serde_json::{json, Value};
use tauri::{Emitter, Manager, State};

/// config.json 的默认内容。
/// 字段语义严格对齐 src/main/config.js 的 defaultConfig()——渲染层各页面会直接
/// 访问 config.output.format / config.memory.enabled 等字段，缺失会导致崩溃，
/// 故此处必须保留全部字段（即便骨架阶段用不到）。
fn default_config() -> Value {
    // 时区：骨架阶段从 TZ 环境变量取；获取失败回退 Asia/Shanghai。
    let tz = chrono_tz_name().unwrap_or_else(|| "Asia/Shanghai".to_string());
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

/// 尽力返回系统本地 IANA 时区名。
/// 不引入额外依赖：从 TZ 环境变量取，失败则回退。
fn chrono_tz_name() -> Option<String> {
    std::env::var("TZ").ok().filter(|s| !s.is_empty())
}

/// 读取 userData 下的 config.json；不存在时返回默认值（不落盘，与 Electron 行为一致）。
fn load_config(app: &tauri::AppHandle) -> Value {
    let path = app
        .path()
        .app_config_dir()
        .ok()
        .map(|d| d.join("config.json"));

    if let Some(p) = path {
        if let Ok(text) = std::fs::read_to_string(&p) {
            if let Ok(v) = serde_json::from_str::<Value>(&text) {
                return v;
            }
        }
    }
    default_config()
}

/// 返回系统 git 是否可用（对齐 src/main/git.js checkGit：git --version 退出码 0）。
fn check_git() -> bool {
    Command::new("git")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// 应用共享状态：缓存 git 可用性，避免每次 command 都 spawn 子进程。
#[derive(Default)]
struct AppState {
    git_ok: Mutex<Option<bool>>,
}

// ── 暴露给渲染层的 command ────────────────────────────────────────────
// 命名约定：把 Electron 的 ipcMain.handle('a:b') 转为 a_b（冒号非法于 Rust 标识符）。
// 渲染层 invoke('config_get') 即可调用。

/// 对应 config:get —— 返回完整配置 JSON。
#[tauri::command]
fn config_get(app: tauri::AppHandle) -> Value {
    load_config(&app)
}

/// 对应 env:gitOk —— 返回系统 git 是否可用（带缓存）。
#[tauri::command]
fn env_git_ok(state: State<'_, AppState>) -> bool {
    let mut guard = state.git_ok.lock().unwrap();
    if let Some(v) = *guard {
        return v;
    }
    let v = check_git();
    *guard = Some(v);
    v
}

/// 唤起快速记笔记窗口（对应 quicknote:show 事件）。
/// 骨架阶段：显示并置顶 quicknote 窗口，并向其发出 show 事件供前端 onShow 监听。
#[tauri::command]
fn quicknote_show(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("quicknote") {
        win.show().map_err(|e| e.to_string())?;
        win.set_always_on_top(true).ok();
        win.set_focus().ok();
        let _ = win.emit("quicknote:show", ());
    }
    Ok(())
}

/// 隐藏快速记笔记窗口（对应 quicknote:hide send）。
#[tauri::command]
fn quicknote_hide(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("quicknote") {
        win.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            config_get,
            env_git_ok,
            quicknote_show,
            quicknote_hide,
        ])
        .setup(|_app| {
            #[cfg(debug_assertions)]
            {
                if let Some(win) = _app.get_webview_window("main") {
                    win.open_devtools();
                }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
