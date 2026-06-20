// WeekLog Tauri 2 后端入口。
//
// 本文件为 lib crate 入口，移动端/桌面端共用；真正的 main 在 src/main.rs 调用 run()。
// 业务逻辑拆分到子模块，对齐 Electron 的 src/main/*。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod aggregator;
mod backup;
mod chat;
mod config;
mod git;
mod history;
mod hooks;
mod llm;
mod logger;
mod memory;
mod notes;
mod pipeline;
mod prefs;
mod prompt;
mod render;
mod secrets;
mod tasks;
mod updates;
mod utils;
mod webdav;

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::Deserialize;
use serde_json::{json, Value};
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, State, Theme};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

use tasks::Tasks;

/// 默认全局快捷键（对齐 index.js SHORTCUT_DEFAULT）。
const SHORTCUT_DEFAULT: &str = "CommandOrControl+Shift+L";

/// 应用共享状态：缓存 git 可用性 + 当前全局快捷键。
struct AppState {
    git_ok: Mutex<Option<bool>>,
    shortcut: Mutex<String>,
    codex_hook: hooks::HookServer,
    zcode_hook: hooks::HookServer,
    /// 进行中的 chat 流式：msgId → 取消标志（chat:cancel 置位，stream 循环检查）。
    chat_streams: Mutex<HashMap<String, Arc<AtomicBool>>>,
    /// 自动更新状态（check/download/install 跨命令共享；Arc 便于异步命令克隆出 owned 句柄）。
    updater: Arc<Mutex<updates::UpdaterState>>,
}

impl Default for AppState {
    fn default() -> Self {
        AppState {
            git_ok: Mutex::new(None),
            shortcut: Mutex::new(String::new()),
            codex_hook: hooks::HookServer::new(hooks::HookKind::Codex),
            zcode_hook: hooks::HookServer::new(hooks::HookKind::Zcode),
            chat_streams: Mutex::new(HashMap::new()),
            updater: Arc::new(Mutex::new(updates::UpdaterState::default())),
        }
    }
}

// ── 配置类 ──

#[tauri::command]
fn config_get(app: AppHandle) -> Value {
    config::load_config(&app)
}

#[tauri::command]
fn config_save(app: AppHandle, state: State<'_, AppState>, cfg: Value) -> Result<Value, String> {
    let saved = config::save_config(&app, &cfg)?;
    // 对齐 ipc.js persist：启用时确保 token，随后按新配置启停 hook 服务
    if saved["codexHook"]["enabled"].as_bool().unwrap_or(false) {
        hooks::ensure_token(hooks::HookKind::Codex);
    }
    if saved["zcodeHook"]["enabled"].as_bool().unwrap_or(false) {
        hooks::ensure_token(hooks::HookKind::Zcode);
    }
    state.codex_hook.apply_config(&app);
    state.zcode_hook.apply_config(&app);
    Ok(saved)
}

#[tauri::command]
fn config_reset(app: AppHandle, state: State<'_, AppState>) -> Result<Value, String> {
    let saved = config::reset_config(&app)?;
    state.codex_hook.apply_config(&app);
    state.zcode_hook.apply_config(&app);
    Ok(saved)
}

#[tauri::command]
fn config_notes_dir(app: AppHandle) -> Result<String, String> {
    config::notes_dir(&app)
}

// ── 环境 / 密钥类 ──

#[tauri::command]
fn env_git_ok(state: State<'_, AppState>) -> bool {
    let mut guard = state.git_ok.lock().unwrap();
    if let Some(v) = *guard {
        return v;
    }
    let v = git::check_git();
    *guard = Some(v);
    v
}

#[tauri::command]
fn env_api_key_status(app: AppHandle) -> bool {
    secrets::api_key_status(&config::load_config(&app))
}

#[tauri::command]
fn secrets_available() -> bool {
    secrets::is_available()
}

#[tauri::command]
fn secrets_status(app: AppHandle, provider: String) -> Value {
    let cfg = config::load_config(&app);
    let fallback = cfg["ai"]["provider"].as_str().unwrap_or("anthropic");
    let prov = secrets::normalize_provider(&provider, fallback);
    json!({ "hasKey": secrets::has_key(&prov), "available": secrets::is_available() })
}

#[tauri::command]
fn secrets_set(app: AppHandle, provider: String, key: String) -> Result<(), String> {
    let cfg = config::load_config(&app);
    let fallback = cfg["ai"]["provider"].as_str().unwrap_or("anthropic");
    let prov = secrets::normalize_provider(&provider, fallback);
    secrets::set_key(&prov, &key)
}

#[tauri::command]
fn secrets_clear(app: AppHandle, provider: String) -> Result<(), String> {
    let cfg = config::load_config(&app);
    let fallback = cfg["ai"]["provider"].as_str().unwrap_or("anthropic");
    let prov = secrets::normalize_provider(&provider, fallback);
    secrets::clear_key(&prov)
}

// ── AI 连接测试 ──

#[tauri::command]
async fn ai_test(app: AppHandle, cfg: Option<Value>, api_key: Option<String>) -> Value {
    let use_cfg = cfg.unwrap_or_else(|| config::load_config(&app));
    let provider = use_cfg["ai"]["provider"]
        .as_str()
        .unwrap_or("anthropic")
        .to_string();
    let key = match api_key {
        Some(k) if !k.is_empty() => k,
        _ => secrets::get_key(&provider),
    };
    if key.is_empty() {
        return json!({ "ok": false, "message": format!("未设置 {provider} 的 API Key，请先填写") });
    }
    llm::test_provider(&use_cfg, &key).await
}

// ── 仓库类 ──

fn basename(p: &str) -> String {
    Path::new(p)
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default()
}

/// 浅合并 patch 到 base（对齐 JS Object.assign）。
fn shallow_merge(base: &mut Value, patch: &Value) {
    if let (Some(b), Some(p)) = (base.as_object_mut(), patch.as_object()) {
        for (k, v) in p {
            b.insert(k.clone(), v.clone());
        }
    }
}

#[tauri::command]
fn repo_validate(p: String) -> Value {
    if p.is_empty() || !Path::new(&p).exists() {
        return json!({ "ok": false, "branch": "" });
    }
    json!({ "ok": git::is_git_repo(&p), "branch": git::current_branch(&p) })
}

#[derive(Deserialize)]
struct RepoAddArgs {
    path: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    branch: String,
    #[serde(default)]
    alias: String,
}

#[tauri::command]
fn repo_add(app: AppHandle, r: RepoAddArgs) -> Result<Value, String> {
    if !git::is_git_repo(&r.path) {
        return Ok(json!({ "error": "路径不是有效的 Git 仓库" }));
    }
    let mut cfg = config::load_config(&app);
    let name = if r.name.trim().is_empty() {
        basename(&r.path)
    } else {
        r.name.trim().to_string()
    };
    let branch = if !r.branch.is_empty() {
        r.branch.clone()
    } else {
        let b = git::current_branch(&r.path);
        if b.is_empty() {
            "main".to_string()
        } else {
            b
        }
    };
    let repo = json!({
        "id": utils::gen_id("r_"),
        "path": r.path,
        "name": name,
        "alias": r.alias.trim(),
        "branch": branch,
        "enabled": true,
    });
    if let Some(arr) = cfg["repos"].as_array_mut() {
        arr.push(repo.clone());
    }
    config::save_config(&app, &cfg)?;
    Ok(json!({ "repo": repo }))
}

#[tauri::command]
fn repo_update(app: AppHandle, id: String, patch: Value) -> Result<Value, String> {
    let mut cfg = config::load_config(&app);
    if let Some(arr) = cfg["repos"].as_array_mut() {
        for r in arr.iter_mut() {
            if r["id"].as_str() == Some(id.as_str()) {
                shallow_merge(r, &patch);
                break;
            }
        }
    }
    config::save_config(&app, &cfg)
}

#[tauri::command]
fn repo_remove(app: AppHandle, id: String) -> Result<Value, String> {
    let mut cfg = config::load_config(&app);
    if let Some(arr) = cfg["repos"].as_array_mut() {
        arr.retain(|r| r["id"].as_str() != Some(id.as_str()));
    }
    config::save_config(&app, &cfg)
}

#[tauri::command]
fn repo_scan(root_dir: String, max_depth: Option<usize>) -> Value {
    let is_dir = Path::new(&root_dir).is_dir();
    if root_dir.is_empty() || !is_dir {
        return json!({ "repos": [], "error": "无效的目录路径" });
    }
    let depth = max_depth.unwrap_or(3).clamp(1, 3);
    let repos = git::scan_git_repos(&root_dir, depth);
    json!({ "repos": repos, "error": Value::Null })
}

// ── 笔记类 ──

fn notes_misc_project(app: &AppHandle) -> String {
    config::load_config(app)["notes"]["miscProject"]
        .as_str()
        .unwrap_or("日常工作")
        .to_string()
}

#[derive(Deserialize)]
struct NotesListArgs {
    from: String,
    to: String,
}

#[tauri::command]
fn notes_list(app: AppHandle, q: NotesListArgs) -> Result<Vec<notes::Note>, String> {
    let dir = config::notes_dir(&app)?;
    let misc = notes_misc_project(&app);
    notes::load_notes(&dir, &q.from, &q.to, &misc)
}

#[tauri::command]
fn notes_get_text(app: AppHandle, date: String) -> Result<String, String> {
    let dir = config::notes_dir(&app)?;
    Ok(notes::get_note_text(&dir, &date))
}

#[derive(Deserialize)]
struct NotesSaveTextArgs {
    date: String,
    text: String,
}

#[tauri::command]
fn notes_save_text(app: AppHandle, q: NotesSaveTextArgs) -> Result<Value, String> {
    let dir = config::notes_dir(&app)?;
    notes::save_note_text(&dir, &q.date, &q.text)?;
    Ok(json!({ "ok": true }))
}

#[derive(Deserialize)]
struct NotesAddArgs {
    date: String,
    project: String,
    content: String,
}

#[tauri::command]
fn notes_add(app: AppHandle, n: NotesAddArgs) -> Result<Value, String> {
    let dir = config::notes_dir(&app)?;
    let misc = notes_misc_project(&app);
    let file = notes::append_note(&dir, &n.date, &n.project, &n.content, &misc)?;
    Ok(json!({ "file": file }))
}

#[tauri::command]
async fn notes_summarize(app: AppHandle, items: Vec<notes::Note>) -> Value {
    let cfg = config::load_config(&app);
    let resolved = secrets::resolve_api_key(&cfg);
    if !resolved.has {
        return json!({ "error": "未配置 AI API Key" });
    }
    let provider = match llm::create_provider(&cfg, &resolved.key) {
        Ok(p) => p,
        Err(e) => return json!({ "error": e.message() }),
    };
    notes::summarize_notes(&items, &provider).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReplaceSummarizedArgs {
    #[serde(default)]
    remove_items: Vec<notes::Note>,
    #[serde(default)]
    date: String,
    #[serde(default)]
    project: String,
    #[serde(default)]
    content: String,
}

#[tauri::command]
fn notes_replace_summarized(app: AppHandle, q: ReplaceSummarizedArgs) -> Result<Value, String> {
    let dir = config::notes_dir(&app)?;
    let misc = notes_misc_project(&app);
    let files = notes::replace_notes(&dir, &q.remove_items, &q.date, &q.project, &q.content, &misc)?;
    Ok(json!({ "files": files }))
}

// ── 报告格式互转 ──

#[derive(Deserialize)]
struct ConvertArgs {
    #[serde(default)]
    text: String,
    #[serde(default)]
    from: String,
    #[serde(default)]
    to: String,
    #[serde(default)]
    newline: Option<String>,
}

#[tauri::command]
fn report_convert(q: ConvertArgs) -> Value {
    let newline = q.newline.as_deref().unwrap_or("LF");
    let text = render::convert_format(&q.text, &q.from, &q.to, newline);
    json!({ "text": text })
}

// ── 偏好类 ──

#[tauri::command]
fn prefs_list(app: AppHandle) -> Vec<Value> {
    prefs::list_preferences(&app)
}

#[tauri::command]
fn prefs_add(app: AppHandle, rule: String) -> Result<Value, String> {
    let item = prefs::add_preference(&app, &rule)?;
    Ok(json!({ "item": item }))
}

#[tauri::command]
fn prefs_toggle(app: AppHandle, id: String, enabled: bool) -> Result<Value, String> {
    let item = prefs::toggle_preference(&app, &id, enabled);
    Ok(json!({ "item": item }))
}

#[tauri::command]
fn prefs_remove(app: AppHandle, id: String) -> Result<Value, String> {
    let deleted = prefs::remove_preference(&app, &id)?;
    Ok(json!({ "deleted": deleted }))
}

#[tauri::command]
async fn prefs_extract(app: AppHandle, old_text: String, new_text: String) -> Value {
    let cfg = config::load_config(&app);
    let resolved = secrets::resolve_api_key(&cfg);
    if !resolved.has {
        return json!({ "error": "未配置 AI API Key" });
    }
    if old_text.trim().is_empty() || new_text.trim().is_empty() {
        return json!({ "rule": "" });
    }
    let provider = match llm::create_provider(&cfg, &resolved.key) {
        Ok(p) => p,
        Err(e) => return json!({ "error": e.message() }),
    };
    match provider
        .summarize(prefs::EXTRACT_SYSTEM, &prefs::build_extract_prompt(&old_text, &new_text))
        .await
    {
        Ok(r) => {
            let rule = r.text.trim();
            // 「无」或空视为无可提炼规则
            if rule.is_empty() || rule == "无" {
                json!({ "rule": "" })
            } else {
                json!({ "rule": rule, "model": r.model, "inputTokens": r.input_tokens, "outputTokens": r.output_tokens })
            }
        }
        Err(e) => json!({ "error": e.message() }),
    }
}

// ── 采集（dry-run）──

#[tauri::command]
fn collect(
    app: AppHandle,
    range_opts: utils::RangeOpts,
    options: pipeline::CollectOptions,
) -> Result<pipeline::CollectResult, String> {
    let cfg = config::load_config(&app);
    let notes_dir = config::notes_dir(&app)?;
    pipeline::collect(&cfg, &range_opts, &notes_dir, &options)
}

// ── 生成报告 ──

#[tauri::command]
async fn generate(
    app: AppHandle,
    range_opts: utils::RangeOpts,
    options: pipeline::CollectOptions,
) -> pipeline::Report {
    let cfg = config::load_config(&app);
    let resolved = secrets::resolve_api_key(&cfg);
    if !resolved.has {
        let provider = cfg["ai"]["provider"].as_str().unwrap_or("anthropic");
        return pipeline::Report {
            error: Some(format!(
                "未设置 {} 的 API Key（请在「AI 与输出设置」中填写，或配置环境变量 {}）",
                provider, resolved.env_name
            )),
            ..Default::default()
        };
    }
    let notes_dir = match config::notes_dir(&app) {
        Ok(d) => d,
        Err(e) => {
            return pipeline::Report {
                error: Some(e),
                ..Default::default()
            }
        }
    };
    let report_type = options
        .report_type
        .clone()
        .unwrap_or_else(|| "报告".to_string());
    let task_id = app.state::<Tasks>().create(
        "generate",
        &format!("生成{report_type}"),
        "采集 commit + 加载笔记…",
        Some(tasks::Progress {
            done: 0.0,
            total: 0.0,
            label: "采集中".to_string(),
        }),
    );
    let report = pipeline::generate(
        app.clone(),
        cfg,
        resolved.key,
        range_opts,
        notes_dir,
        options,
        task_id.clone(),
    )
    .await;
    if let Some(err) = &report.error {
        app.state::<Tasks>().error(&task_id, err);
    } else if let Some(m) = &report.meta {
        app.state::<Tasks>().done(
            &task_id,
            json!({
                "commitCount": m["commitCount"],
                "noteCount": m["noteCount"],
                "bucketCount": m["bucketCount"],
                "durationMs": m["durationMs"],
            }),
        );
    } else {
        app.state::<Tasks>().done(&task_id, json!({}));
    }
    report
}

// ── 历史 ──

#[tauri::command]
fn history_list(app: AppHandle) -> Vec<Value> {
    history::read_history(&app)
}

#[tauri::command]
fn history_save(app: AppHandle, e: Value) -> Result<Value, String> {
    history::save_entry(&app, e)
}

#[tauri::command]
fn history_update(app: AppHandle, id: String, text: String) -> Value {
    json!({ "ok": history::update_entry(&app, &id, &text) })
}

// ── 对话框（文件夹选择）──

#[tauri::command]
async fn dialog_pick_folder(app: AppHandle) -> Option<String> {
    app.dialog()
        .file()
        .blocking_pick_folder()
        .and_then(|p| p.into_path().ok())
        .map(|pb| pb.to_string_lossy().to_string())
}

#[tauri::command]
async fn dialog_pick_repo(app: AppHandle) -> Option<String> {
    app.dialog()
        .file()
        .blocking_pick_folder()
        .and_then(|p| p.into_path().ok())
        .map(|pb| pb.to_string_lossy().to_string())
}

#[tauri::command]
async fn dialog_pick_backup_folder(app: AppHandle) -> Option<String> {
    let mut builder = app.dialog().file();
    if let Ok(downloads) = app.path().download_dir() {
        builder = builder.set_directory(downloads);
    }
    builder
        .blocking_pick_folder()
        .and_then(|p| p.into_path().ok())
        .map(|pb| pb.to_string_lossy().to_string())
}

// ── 日志 ──

#[tauri::command]
fn logs_list(app: AppHandle, limit: Option<usize>) -> Vec<Value> {
    logger::list_logs(&app, limit)
}

#[tauri::command]
fn logs_clear(app: AppHandle) -> Value {
    logger::clear_logs(&app)
}

#[tauri::command]
fn logs_path(app: AppHandle) -> String {
    logger::log_path(&app)
}

// ── 本地备份 ──

#[tauri::command]
fn local_backup_create(app: AppHandle, dir: Option<String>) -> Result<Value, String> {
    backup::create_cmd(&app, dir)
}

// ── WebDAV 同步 ──

#[tauri::command]
async fn webdav_test(url: String, username: String, password: String) -> Value {
    // password 为空回退系统钥匙串中的 webdav 密码（对齐 ipc.js webdav:test）
    let pw = if password.is_empty() {
        secrets::get_key("webdav")
    } else {
        password
    };
    webdav::test_connection(&url, &username, &pw).await
}

#[tauri::command]
async fn webdav_sync_now(app: AppHandle, direction: Option<String>) -> Result<Value, String> {
    let cfg = config::load_config(&app);
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    let password = secrets::get_key("webdav");
    let dir_mode = direction.unwrap_or_else(|| "both".to_string());
    webdav::sync_all(&cfg, &dir, &password, &dir_mode).await
}

#[tauri::command]
async fn webdav_backup_now(app: AppHandle) -> Result<Value, String> {
    let cfg = config::load_config(&app);
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    let password = secrets::get_key("webdav");
    let version = app.package_info().version.to_string();
    webdav::create_backup(&cfg, &dir, &password, &version).await
}

#[tauri::command]
async fn webdav_list_backups(app: AppHandle) -> Result<Vec<Value>, String> {
    let cfg = config::load_config(&app);
    let password = secrets::get_key("webdav");
    webdav::list_backups(&cfg, &password).await
}

#[tauri::command]
async fn webdav_restore_backup(app: AppHandle, name: String) -> Result<Value, String> {
    let cfg = config::load_config(&app);
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    let password = secrets::get_key("webdav");
    webdav::restore_backup(&cfg, &dir, &password, &name).await
}

#[tauri::command]
fn webdav_status(app: AppHandle) -> Value {
    match app.path().app_config_dir() {
        Ok(dir) => webdav::read_status(&dir),
        Err(_) => json!({}),
    }
}

#[tauri::command]
fn webdav_save_password(password: String) -> Result<Value, String> {
    secrets::set_key("webdav", &password)?;
    Ok(json!({ "ok": true }))
}

#[tauri::command]
fn webdav_password_status() -> Value {
    json!({ "hasPassword": secrets::has_key("webdav"), "available": secrets::is_available() })
}

#[tauri::command]
fn webdav_clear_password() -> Result<Value, String> {
    secrets::clear_key("webdav")?;
    Ok(json!({ "ok": true }))
}

// ── 后台任务 ──

#[tauri::command]
fn tasks_list(tasks: State<'_, Tasks>) -> Vec<tasks::Task> {
    tasks.list()
}

#[tauri::command]
fn tasks_has_running(tasks: State<'_, Tasks>) -> bool {
    tasks.has_running()
}

#[tauri::command]
fn tasks_remove(tasks: State<'_, Tasks>, id: String) -> Value {
    tasks.remove(&id);
    json!({ "ok": true })
}

#[tauri::command]
fn tasks_clear_finished(tasks: State<'_, Tasks>) -> Value {
    tasks.clear_finished();
    json!({ "ok": true })
}

// ── 主题 ──

#[tauri::command]
fn ui_set_theme(app: AppHandle, theme: String) -> bool {
    let t = match theme.as_str() {
        "dark" => Some(Theme::Dark),
        "light" => Some(Theme::Light),
        _ => None,
    };
    for (_, w) in app.webview_windows() {
        let _ = w.set_theme(t);
    }
    app.get_webview_window("main")
        .and_then(|w| w.theme().ok())
        .map(|th| th == Theme::Dark)
        .unwrap_or(false)
}

// ── 全局快捷键 ──

/// 注册快速记笔记全局快捷键（对齐 index.js applyShortcut）。失败回退默认键。
fn register_shortcut(app: &AppHandle, accel: &str) -> (bool, String) {
    let gs = app.global_shortcut();
    let _ = gs.unregister_all();
    let target = if accel.trim().is_empty() {
        SHORTCUT_DEFAULT.to_string()
    } else {
        accel.trim().to_string()
    };
    let handler_app = app.clone();
    let make_handler = move || {
        let a = handler_app.clone();
        move |_app: &AppHandle, _sc: &tauri_plugin_global_shortcut::Shortcut, event: tauri_plugin_global_shortcut::ShortcutEvent| {
            if event.state() == ShortcutState::Pressed {
                show_quicknote(&a);
            }
        }
    };
    if gs.on_shortcut(target.as_str(), make_handler()).is_ok() {
        *app.state::<AppState>().shortcut.lock().unwrap() = target.clone();
        (true, target)
    } else {
        // 注册失败（冲突/非法）：回退默认
        let _ = gs.on_shortcut(SHORTCUT_DEFAULT, make_handler());
        *app.state::<AppState>().shortcut.lock().unwrap() = SHORTCUT_DEFAULT.to_string();
        (false, SHORTCUT_DEFAULT.to_string())
    }
}

#[tauri::command]
fn shortcut_apply(app: AppHandle) -> Value {
    let cfg = config::load_config(&app);
    let accel = cfg["ui"]["quickNoteShortcut"]
        .as_str()
        .unwrap_or(SHORTCUT_DEFAULT)
        .to_string();
    let (ok, accel) = register_shortcut(&app, &accel);
    json!({ "ok": ok, "accel": accel })
}

#[tauri::command]
fn shortcut_suspend(app: AppHandle) -> bool {
    let _ = app.global_shortcut().unregister_all();
    true
}

#[tauri::command]
fn shortcut_resume(app: AppHandle) -> bool {
    let accel = app.state::<AppState>().shortcut.lock().unwrap().clone();
    register_shortcut(&app, &accel);
    true
}

// ── 快速记笔记窗口 ──

fn show_quicknote(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("quicknote") {
        let _ = win.center();
        let _ = win.show();
        let _ = win.set_always_on_top(true);
        let _ = win.set_focus();
        let _ = win.emit("quicknote:show", ());
    }
}

#[tauri::command]
fn quicknote_show(app: AppHandle) {
    show_quicknote(&app);
}

#[tauri::command]
fn quicknote_hide(app: AppHandle) {
    if let Some(win) = app.get_webview_window("quicknote") {
        let _ = win.hide();
    }
}

// ── 主窗口显隐（托盘）──

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

fn toggle_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let visible = w.is_visible().unwrap_or(false);
        let focused = w.is_focused().unwrap_or(false);
        if visible && focused {
            let _ = w.hide();
        } else {
            show_main(app);
        }
    }
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let show_item = MenuItemBuilder::with_id("show", "显示主窗口").build(app)?;
    let quicknote_item = MenuItemBuilder::with_id("quicknote", "快速记笔记").build(app)?;
    let quit_item = MenuItemBuilder::with_id("quit", "退出").build(app)?;
    let menu = MenuBuilder::new(app)
        .items(&[&show_item, &quicknote_item])
        .separator()
        .items(&[&quit_item])
        .build()?;

    let mut builder = TrayIconBuilder::new()
        .tooltip("WeekLog — Git 周报/日报生成工具")
        .menu(&menu)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => show_main(app),
            "quicknote" => show_quicknote(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                toggle_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }
    builder.build(app)?;
    Ok(())
}

// ── Codex / ZCode hook 待处理小记 ──

#[tauri::command]
fn codex_notes_list(app: AppHandle) -> Value {
    hooks::list_pending(&app, hooks::HookKind::Codex)
}

#[tauri::command]
fn codex_notes_delete(app: AppHandle, ids: Vec<String>) -> Value {
    hooks::delete_pending(&app, hooks::HookKind::Codex, ids)
}

#[tauri::command]
fn codex_notes_write(
    app: AppHandle,
    ids: Vec<String>,
    project: Option<String>,
    content: Option<String>,
) -> Value {
    hooks::write_pending(&app, hooks::HookKind::Codex, ids, project, content)
}

#[tauri::command]
async fn codex_notes_summarize(app: AppHandle, ids: Vec<String>) -> Value {
    hooks::summarize_pending(&app, hooks::HookKind::Codex, ids).await
}

#[tauri::command]
fn codex_hook_status(app: AppHandle, state: State<'_, AppState>) -> Value {
    hooks::hook_status(&app, &state.codex_hook, hooks::HookKind::Codex)
}

#[tauri::command]
fn codex_hook_copy_config(app: AppHandle, state: State<'_, AppState>) -> Value {
    hooks::copy_config(&app, &state.codex_hook, hooks::HookKind::Codex)
}

#[tauri::command]
fn codex_hook_install(app: AppHandle, state: State<'_, AppState>) -> Value {
    hooks::install_hook(&app, &state.codex_hook, hooks::HookKind::Codex)
}

#[tauri::command]
fn codex_hook_uninstall(app: AppHandle) -> Value {
    hooks::uninstall_hook(&app, hooks::HookKind::Codex)
}

#[tauri::command]
fn zcode_notes_list(app: AppHandle) -> Value {
    hooks::list_pending(&app, hooks::HookKind::Zcode)
}

#[tauri::command]
fn zcode_notes_delete(app: AppHandle, ids: Vec<String>) -> Value {
    hooks::delete_pending(&app, hooks::HookKind::Zcode, ids)
}

#[tauri::command]
fn zcode_notes_write(
    app: AppHandle,
    ids: Vec<String>,
    project: Option<String>,
    content: Option<String>,
) -> Value {
    hooks::write_pending(&app, hooks::HookKind::Zcode, ids, project, content)
}

#[tauri::command]
async fn zcode_notes_summarize(app: AppHandle, ids: Vec<String>) -> Value {
    hooks::summarize_pending(&app, hooks::HookKind::Zcode, ids).await
}

#[tauri::command]
fn zcode_hook_status(app: AppHandle, state: State<'_, AppState>) -> Value {
    hooks::hook_status(&app, &state.zcode_hook, hooks::HookKind::Zcode)
}

#[tauri::command]
fn zcode_hook_copy_config(app: AppHandle, state: State<'_, AppState>) -> Value {
    hooks::copy_config(&app, &state.zcode_hook, hooks::HookKind::Zcode)
}

#[tauri::command]
fn zcode_hook_install(app: AppHandle, state: State<'_, AppState>) -> Value {
    hooks::install_hook(&app, &state.zcode_hook, hooks::HookKind::Zcode)
}

#[tauri::command]
fn zcode_hook_uninstall(app: AppHandle) -> Value {
    hooks::uninstall_hook(&app, hooks::HookKind::Zcode)
}

// ── AI 对话（chat）──

#[tauri::command]
fn chat_sessions(app: AppHandle) -> Value {
    chat::sessions(&app)
}

#[tauri::command]
fn chat_session_get(app: AppHandle, id: String) -> Value {
    chat::session_get(&app, &id)
}

#[tauri::command]
fn chat_session_create(app: AppHandle, title: Option<String>) -> Value {
    chat::session_create(&app, title)
}

#[tauri::command]
fn chat_session_rename(app: AppHandle, id: String, title: String) -> Value {
    chat::session_rename(&app, &id, &title)
}

#[tauri::command]
fn chat_session_delete(app: AppHandle, id: String) -> Value {
    chat::session_delete(&app, &id)
}

#[tauri::command]
fn chat_cancel(state: State<'_, AppState>, msg_id: String) -> Value {
    let map = state.chat_streams.lock().unwrap();
    if let Some(sig) = map.get(&msg_id) {
        sig.store(true, Ordering::Relaxed);
        json!({ "ok": true })
    } else {
        json!({ "ok": false })
    }
}

#[tauri::command]
fn chat_send(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    content: String,
    context: Option<String>,
) -> Value {
    if session_id.is_empty() || content.trim().is_empty() {
        return json!({ "error": "缺少会话或内容" });
    }
    let cfg = config::load_config(&app);
    let resolved = secrets::resolve_api_key(&cfg);
    if !resolved.has {
        let p = cfg["ai"]["provider"].as_str().unwrap_or("anthropic");
        return json!({ "error": format!("未设置 {} 的 API Key，请先在设置中填写", p) });
    }
    let msg_id = chat::new_msg_id();
    let signal = Arc::new(AtomicBool::new(false));
    state
        .chat_streams
        .lock()
        .unwrap()
        .insert(msg_id.clone(), signal.clone());
    let app2 = app.clone();
    let key = resolved.key;
    let mid = msg_id.clone();
    tauri::async_runtime::spawn(async move {
        chat::handle_send(&app2, cfg, key, signal, session_id, mid.clone(), content, context).await;
        app2.state::<AppState>().chat_streams.lock().unwrap().remove(&mid);
    });
    json!({ "msgId": msg_id })
}

#[tauri::command]
fn chat_generate(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    report_type: String,
    when: String,
) -> Value {
    if session_id.is_empty() || report_type.is_empty() {
        return json!({ "error": "缺少会话或报告类型" });
    }
    let cfg = config::load_config(&app);
    let resolved = secrets::resolve_api_key(&cfg);
    if !resolved.has {
        let p = cfg["ai"]["provider"].as_str().unwrap_or("anthropic");
        return json!({ "error": format!("未设置 {} 的 API Key，请先在设置中填写", p) });
    }
    let msg_id = chat::new_msg_id();
    let signal = Arc::new(AtomicBool::new(false));
    state
        .chat_streams
        .lock()
        .unwrap()
        .insert(msg_id.clone(), signal);
    let app2 = app.clone();
    let key = resolved.key;
    let mid = msg_id.clone();
    tauri::async_runtime::spawn(async move {
        chat::handle_generate(&app2, cfg, key, session_id, mid.clone(), report_type, when).await;
        app2.state::<AppState>().chat_streams.lock().unwrap().remove(&mid);
    });
    json!({ "msgId": msg_id })
}

// ── AI 记忆（memory）──

#[tauri::command]
fn memory_list(app: AppHandle) -> Value {
    memory::list_index(&app)
}

#[tauri::command]
async fn memory_search(app: AppHandle, query: String, top_k: Option<u64>) -> Value {
    let cfg = config::load_config(&app);
    memory::search(&app, &query, top_k.unwrap_or(0) as usize, &cfg).await
}

#[tauri::command]
fn memory_queue_status() -> Value {
    memory::queue_status()
}

#[tauri::command]
fn memory_status(app: AppHandle) -> Value {
    let cfg = config::load_config(&app);
    memory::get_status(&app, &cfg)
}

#[tauri::command]
async fn memory_rebuild(app: AppHandle) -> Value {
    let cfg = config::load_config(&app);
    let resolved = secrets::resolve_api_key(&cfg);
    if !resolved.has {
        return json!({ "error": "未配置 AI API Key" });
    }
    let total = history::read_history(&app).len();
    let task_id = app.state::<Tasks>().create(
        "memory",
        "重建 AI 记忆库",
        &format!("从 {} 份历史报告生成记忆…", total),
        Some(tasks::Progress {
            done: 0.0,
            total: total as f64,
            label: "处理中".to_string(),
        }),
    );
    let result = memory::rebuild(&app, cfg, resolved.key, task_id.clone()).await;
    app.state::<Tasks>().done(&task_id, result.clone());
    result
}

#[tauri::command]
fn memory_delete(app: AppHandle, id: String) -> Value {
    memory::delete_entry(&app, &id)
}

#[tauri::command]
async fn memory_infer_project(app: AppHandle, note_text: String) -> Value {
    let cfg = config::load_config(&app);
    let resolved = secrets::resolve_api_key(&cfg);
    if !resolved.has {
        return json!({ "error": "未配置 AI API Key" });
    }
    memory::infer_project(&app, &cfg, &resolved.key, &note_text).await
}

// ── 自动更新（updates）──

#[tauri::command]
fn updates_status(app: AppHandle, state: State<'_, AppState>) -> Value {
    updates::status(&app, &state.updater)
}

#[tauri::command]
async fn updates_check(app: AppHandle) -> Value {
    // 在 await 前取出 owned Arc（State 守卫为临时值，不跨 await 借用 message）
    let updater = app.state::<AppState>().updater.clone();
    updates::check(&app, &updater).await
}

#[tauri::command]
async fn updates_download(app: AppHandle) -> Value {
    let updater = app.state::<AppState>().updater.clone();
    updates::download(&app, &updater).await
}

#[tauri::command]
fn updates_install(app: AppHandle, state: State<'_, AppState>) -> Value {
    updates::install(&app, &state.updater)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(AppState::default())
        .manage(Tasks::new())
        .invoke_handler(tauri::generate_handler![
            // 配置
            config_get,
            config_save,
            config_reset,
            config_notes_dir,
            // 环境 / 密钥
            env_git_ok,
            env_api_key_status,
            secrets_available,
            secrets_status,
            secrets_set,
            secrets_clear,
            ai_test,
            // 仓库
            repo_validate,
            repo_add,
            repo_update,
            repo_remove,
            repo_scan,
            // 笔记
            notes_list,
            notes_get_text,
            notes_save_text,
            notes_add,
            notes_summarize,
            notes_replace_summarized,
            // 报告格式互转
            report_convert,
            // 偏好
            prefs_list,
            prefs_add,
            prefs_toggle,
            prefs_remove,
            prefs_extract,
            // 采集 / 生成
            collect,
            generate,
            // 历史
            history_list,
            history_save,
            history_update,
            // 对话框
            dialog_pick_folder,
            dialog_pick_repo,
            dialog_pick_backup_folder,
            // 日志
            logs_list,
            logs_clear,
            logs_path,
            // 本地备份
            local_backup_create,
            // WebDAV
            webdav_test,
            webdav_sync_now,
            webdav_backup_now,
            webdav_list_backups,
            webdav_restore_backup,
            webdav_status,
            webdav_save_password,
            webdav_password_status,
            webdav_clear_password,
            // Codex / ZCode hook
            codex_notes_list,
            codex_notes_delete,
            codex_notes_write,
            codex_notes_summarize,
            codex_hook_status,
            codex_hook_copy_config,
            codex_hook_install,
            codex_hook_uninstall,
            zcode_notes_list,
            zcode_notes_delete,
            zcode_notes_write,
            zcode_notes_summarize,
            zcode_hook_status,
            zcode_hook_copy_config,
            zcode_hook_install,
            zcode_hook_uninstall,
            // AI 对话
            chat_sessions,
            chat_session_get,
            chat_session_create,
            chat_session_rename,
            chat_session_delete,
            chat_send,
            chat_generate,
            chat_cancel,
            // AI 记忆
            memory_list,
            memory_search,
            memory_queue_status,
            memory_status,
            memory_rebuild,
            memory_delete,
            memory_infer_project,
            // 自动更新
            updates_status,
            updates_check,
            updates_download,
            updates_install,
            // 后台任务
            tasks_list,
            tasks_has_running,
            tasks_remove,
            tasks_clear_finished,
            // 主题 / 快捷键
            ui_set_theme,
            shortcut_apply,
            shortcut_suspend,
            shortcut_resume,
            // 快速记笔记
            quicknote_show,
            quicknote_hide,
        ])
        .on_window_event(|window, event| {
            // 关闭窗口=隐藏到托盘，而非退出（真正退出走托盘菜单 app.exit）
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .setup(|app| {
            let handle = app.handle().clone();
            // 注入任务系统的 AppHandle，使任务变更可推送到前端
            app.state::<Tasks>().set_app(handle.clone());

            // 应用启动主题
            let cfg = config::load_config(&handle);
            let theme = cfg["ui"]["theme"].as_str().unwrap_or("auto");
            let t = match theme {
                "dark" => Some(Theme::Dark),
                "light" => Some(Theme::Light),
                _ => None,
            };
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.set_theme(t);
            }

            // 托盘 + 全局快捷键
            if let Err(e) = build_tray(&handle) {
                eprintln!("[weeklog] 托盘创建失败：{e}");
            }
            let accel = cfg["ui"]["quickNoteShortcut"]
                .as_str()
                .unwrap_or(SHORTCUT_DEFAULT)
                .to_string();
            register_shortcut(&handle, &accel);

            logger::write_log(
                &handle,
                "info",
                "app.lifecycle",
                "应用启动",
                json!({ "platform": std::env::consts::OS }),
            );

            // 启动 Codex / ZCode hook 本地服务（按已保存配置 enabled/port 启停）
            {
                let st = handle.state::<AppState>();
                st.codex_hook.apply_config(&handle);
                st.zcode_hook.apply_config(&handle);
            }

            // 启动后静默检查更新（仅打包/release 版本；dev 下 updates::check 自身会回 disabled）
            #[cfg(not(debug_assertions))]
            {
                let h = handle.clone();
                let updater = h.state::<AppState>().updater.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = updates::check(&h, &updater).await;
                });
            }

            #[cfg(debug_assertions)]
            {
                if let Some(win) = app.get_webview_window("main") {
                    win.open_devtools();
                }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
