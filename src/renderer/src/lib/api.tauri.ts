/**
 * Tauri 2 版渲染层桥接。
 *
 * 与 Electron 版（window.weeklog / src/preload/index.js）等价的 API 表面，
 * 内部改用 @tauri-apps/api 的 invoke() / listen() 调用 Rust 后端。
 *
 * 已接通：config、env、secrets、repo、notes（含 summarize/replaceSummarized）、report、
 *   prefs（含 extract）、ai.test、collect、generate、history、dialog、logs、tasks、ui、
 *   shortcut、quicknote、shell、webdav.*、localBackup、codexNotes.*、zcodeNotes.*。
 * 已接通（续）：chat.*（SSE 流式问答 + 报告意图 + 会话存储，事件 chat:stream）、
 *   memory.*（索引/检索/队列/状态/重建/推断；API 嵌入 + 关键词预筛，本地 ONNX 嵌入待 ort 集成）、
 *   updates.*（手动 GitHub 更新器：查版本/下载/打开安装包，事件 updates:update）。
 * 全部 WeeklogAPI 方法均已接通真实 invoke/listen（无 todo 占位）。
 * 命名约定：ipcMain.handle('a:b') → Rust command a_b；JS 传 camelCase 参数，Tauri 自动转 snake_case。
 */
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { open } from '@tauri-apps/plugin-shell'
import type {
  AppLogEntry,
  BackgroundTask,
  ChatSession,
  ChatSessionMeta,
  ChatStreamPayload,
  CollectResult,
  Config,
  CodexHookCopyConfigResult,
  CodexHookInstallResult,
  CodexHookStatus,
  CodexPendingNote,
  GenerateProgress,
  HistoryEntry,
  LocalBackupResult,
  MemoryIndexItem,
  MemoryInferResult,
  MemoryQueueStatus,
  MemorySearchHit,
  MemoryStatus,
  Note,
  Report,
  Repo,
  SecretStatusResult,
  ScannedRepo,
  TaskUpdatePayload,
  UpdatePayload,
  UpdateStatus,
  WebdavBackupInfo,
  WebdavBackupResult,
  WebdavPasswordStatusResult,
  WebdavRestoreResult,
  WebdavStatus,
  WebdavSyncResult,
  WebdavTestResult,
  WeeklogAPI,
  WritingPreference,
  ZcodeHookCopyConfigResult,
  ZcodeHookInstallResult,
  ZcodeHookStatus,
  ZcodePendingNote,
  AiTestResult,
} from '@/types/weeklog'

/**
 * 订阅后端事件（对齐 Electron 的 onXxx 返回 unsubscribe 语义）。
 * 处理 listen() 异步注册期间被提前取消的竞态。
 */
function subscribe<T>(event: string, cb: (payload: T) => void): () => void {
  let unlisten: UnlistenFn | undefined
  let active = true
  void listen<T>(event, (e) => {
    if (active) cb(e.payload)
  }).then((fn) => {
    if (!active) fn()
    else unlisten = fn
  })
  return () => {
    active = false
    unlisten?.()
  }
}

export const api: WeeklogAPI = {
  config: {
    get: () => invoke<Config>('config_get'),
    save: (cfg) => invoke<Config>('config_save', { cfg }),
    reset: () => invoke<Config>('config_reset'),
    notesDir: () => invoke<string>('config_notes_dir'),
  },
  env: {
    gitOk: () => invoke<boolean>('env_git_ok'),
    apiKeyStatus: () => invoke<boolean>('env_api_key_status'),
  },
  secrets: {
    available: () => invoke<boolean>('secrets_available'),
    status: (provider) => invoke<SecretStatusResult>('secrets_status', { provider }),
    set: (provider, key) => invoke<void>('secrets_set', { provider, key }),
    clear: (provider) => invoke<void>('secrets_clear', { provider }),
  },
  ai: {
    test: (cfg, apiKey) => invoke<AiTestResult>('ai_test', { cfg, apiKey }),
  },
  repo: {
    validate: (p) => invoke<{ ok: boolean; branch: string }>('repo_validate', { p }),
    add: (r) => invoke<{ repo?: Repo; error?: string }>('repo_add', { r }),
    update: (id, patch) => invoke<Config>('repo_update', { id, patch }),
    remove: (id) => invoke<Config>('repo_remove', { id }),
    scan: (rootDir, maxDepth) =>
      invoke<{ repos: ScannedRepo[]; error: string | null }>('repo_scan', { rootDir, maxDepth }),
  },
  notes: {
    add: (n) => invoke<{ file: string }>('notes_add', { n }),
    getText: (date) => invoke<string>('notes_get_text', { date }),
    saveText: (n) => invoke<{ ok: boolean }>('notes_save_text', { q: n }),
    list: (q) => invoke<Note[]>('notes_list', { q }),
    summarize: (items) =>
      invoke<{ text?: string; model?: string; error?: string; inputTokens?: number; outputTokens?: number }>(
        'notes_summarize',
        { items },
      ),
    replaceSummarized: (q) => invoke<{ files: string[] }>('notes_replace_summarized', { q }),
  },
  report: {
    convert: (q) => invoke<{ text: string }>('report_convert', { q }),
  },
  codexNotes: {
    list: () => invoke<CodexPendingNote[]>('codex_notes_list'),
    delete: (ids) => invoke<{ deleted: number }>('codex_notes_delete', { ids }),
    write: (q) =>
      invoke<{ written: number; files: string[] }>('codex_notes_write', {
        ids: q.ids,
        project: q.project,
        content: q.content,
      }),
    summarize: (ids) =>
      invoke<{ text?: string; model?: string; error?: string; inputTokens?: number; outputTokens?: number }>(
        'codex_notes_summarize',
        { ids },
      ),
    status: () => invoke<CodexHookStatus>('codex_hook_status'),
    copyConfig: () => invoke<CodexHookCopyConfigResult>('codex_hook_copy_config'),
    installHook: () => invoke<CodexHookInstallResult>('codex_hook_install'),
    uninstallHook: () => invoke<CodexHookInstallResult>('codex_hook_uninstall'),
  },
  zcodeNotes: {
    list: () => invoke<ZcodePendingNote[]>('zcode_notes_list'),
    delete: (ids) => invoke<{ deleted: number }>('zcode_notes_delete', { ids }),
    write: (q) =>
      invoke<{ written: number; files: string[] }>('zcode_notes_write', {
        ids: q.ids,
        project: q.project,
        content: q.content,
      }),
    summarize: (ids) =>
      invoke<{ text?: string; model?: string; error?: string; inputTokens?: number; outputTokens?: number }>(
        'zcode_notes_summarize',
        { ids },
      ),
    status: () => invoke<ZcodeHookStatus>('zcode_hook_status'),
    copyConfig: () => invoke<ZcodeHookCopyConfigResult>('zcode_hook_copy_config'),
    installHook: () => invoke<ZcodeHookInstallResult>('zcode_hook_install'),
    uninstallHook: () => invoke<ZcodeHookInstallResult>('zcode_hook_uninstall'),
  },
  collect: (q) => invoke<CollectResult>('collect', { rangeOpts: q.rangeOpts, options: q.options }),
  generate: (q) => invoke<Report>('generate', { rangeOpts: q.rangeOpts, options: q.options }),
  onProgress: (cb) => subscribe<GenerateProgress>('generate:progress', cb),
  history: {
    list: () => invoke<HistoryEntry[]>('history_list'),
    save: (e) => invoke<HistoryEntry>('history_save', { e }),
    update: (id, text) => invoke<{ ok: boolean }>('history_update', { id, text }),
  },
  dialog: {
    pickFolder: () => invoke<string | null>('dialog_pick_folder'),
    pickRepo: () => invoke<string | null>('dialog_pick_repo'),
    pickBackupFolder: () => invoke<string | null>('dialog_pick_backup_folder'),
  },
  webdav: {
    test: (url, username, password) => invoke<WebdavTestResult>('webdav_test', { url, username, password }),
    syncNow: (direction) => invoke<WebdavSyncResult>('webdav_sync_now', { direction }),
    backupNow: () => invoke<WebdavBackupResult>('webdav_backup_now'),
    listBackups: () => invoke<WebdavBackupInfo[]>('webdav_list_backups'),
    restoreBackup: (name) => invoke<WebdavRestoreResult>('webdav_restore_backup', { name }),
    status: () => invoke<WebdavStatus>('webdav_status'),
    savePassword: (password) => invoke<{ ok: boolean }>('webdav_save_password', { password }),
    passwordStatus: () => invoke<WebdavPasswordStatusResult>('webdav_password_status'),
    clearPassword: () => invoke<{ ok: boolean }>('webdav_clear_password'),
  },
  localBackup: {
    create: (dir) => invoke<LocalBackupResult>('local_backup_create', { dir }),
  },
  memory: {
    list: () => invoke<MemoryIndexItem[]>('memory_list'),
    search: (query, topK) => invoke<MemorySearchHit[]>('memory_search', { query, topK }),
    queueStatus: () => invoke<MemoryQueueStatus>('memory_queue_status'),
    status: () => invoke<MemoryStatus>('memory_status'),
    rebuild: () => invoke<{ generated: number; failed: number; error?: string }>('memory_rebuild'),
    remove: (id) => invoke<{ ok: boolean }>('memory_delete', { id }),
    inferProject: (noteText) => invoke<MemoryInferResult>('memory_infer_project', { noteText }),
  },
  prefs: {
    list: () => invoke<WritingPreference[]>('prefs_list'),
    add: (rule) => invoke<{ item: WritingPreference | null }>('prefs_add', { rule }),
    toggle: (id, enabled) => invoke<{ item: WritingPreference | null }>('prefs_toggle', { id, enabled }),
    remove: (id) => invoke<{ deleted: number }>('prefs_remove', { id }),
    extract: (oldText, newText) =>
      invoke<{ rule?: string; error?: string; model?: string; inputTokens?: number; outputTokens?: number }>(
        'prefs_extract',
        { oldText, newText },
      ),
  },
  chat: {
    sessions: () => invoke<ChatSessionMeta[]>('chat_sessions'),
    getSession: (id) => invoke<ChatSession | null>('chat_session_get', { id }),
    createSession: (title) => invoke<ChatSession>('chat_session_create', { title }),
    renameSession: (id, title) => invoke<{ ok: boolean; title?: string }>('chat_session_rename', { id, title }),
    deleteSession: (id) => invoke<{ ok: boolean }>('chat_session_delete', { id }),
    send: (sessionId, content, context) =>
      invoke<{ msgId?: string; error?: string }>('chat_send', { sessionId, content, context }),
    generate: (sessionId, reportType, when) =>
      invoke<{ msgId?: string; error?: string }>('chat_generate', { sessionId, reportType, when }),
    cancel: (msgId) => invoke<{ ok: boolean }>('chat_cancel', { msgId }),
    onStream: (cb) => subscribe<ChatStreamPayload>('chat:stream', cb),
  },
  tasks: {
    list: () => invoke<BackgroundTask[]>('tasks_list'),
    hasRunning: () => invoke<boolean>('tasks_has_running'),
    remove: (id) => invoke<{ ok: boolean }>('tasks_remove', { id }),
    clearFinished: () => invoke<{ ok: boolean }>('tasks_clear_finished'),
    onUpdate: (cb) => subscribe<TaskUpdatePayload>('task:update', cb),
  },
  logs: {
    list: (limit) => invoke<AppLogEntry[]>('logs_list', { limit }),
    clear: () => invoke<{ ok: boolean }>('logs_clear'),
    path: () => invoke<string>('logs_path'),
  },
  updates: {
    status: () => invoke<UpdateStatus>('updates_status'),
    check: () => invoke<UpdateStatus>('updates_check'),
    download: () => invoke<UpdateStatus>('updates_download'),
    install: () => invoke<UpdateStatus>('updates_install'),
    onUpdate: (cb) => subscribe<UpdatePayload>('updates:update', cb),
  },
  ui: {
    setTheme: (theme) => invoke<boolean>('ui_set_theme', { theme }),
  },
  shell: {
    openExternal: (url: string) => {
      // 仅 http/https；open 内部受 capability shell:allow-open 约束
      if (!/^https?:\/\//i.test(url)) return Promise.resolve()
      return open(url)
    },
  },
  shortcut: {
    apply: () => invoke<{ ok: boolean; accel: string }>('shortcut_apply'),
    suspend: () => invoke<boolean>('shortcut_suspend'),
    resume: () => invoke<boolean>('shortcut_resume'),
  },
  quicknote: {
    hide: () => {
      // fire-and-forget（对应 Electron 的 send）；忽略错误，窗口未创建时静默
      void invoke('quicknote_hide').catch(() => {})
    },
    onShow: (cb: () => void) => subscribe<unknown>('quicknote:show', () => cb()),
  },
}
