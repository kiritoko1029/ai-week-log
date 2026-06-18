/**
 * Tauri 2 版渲染层桥接（骨架阶段）。
 *
 * 与 Electron 版（window.weeklog / src/preload/index.js）等价的 API 表面，
 * 内部改用 @tauri-apps/api 的 invoke() / listen() 调用 Rust 后端。
 *
 * 骨架阶段仅实现：config.get、env.gitOk、quicknote.hide/onShow、shell.openExternal。
 * 其余方法走 todo() 返回空值（不抛错），让页面能渲染空状态、验证骨架完整性。
 * 后续阶段逐步用真实 command 替换。命名约定：ipcMain.handle('a:b') → Rust a_b。
 */
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { open } from '@tauri-apps/plugin-shell'
import type {
  AppLogEntry,
  BackgroundTask,
  ChatSession,
  ChatSessionMeta,
  CollectResult,
  Config,
  CodexHookCopyConfigResult,
  CodexHookInstallResult,
  CodexHookStatus,
  CodexPendingNote,
  HistoryEntry,
  LocalBackupResult,
  MemoryIndexItem,
  MemoryInferResult,
  MemoryQueueStatus,
  MemorySearchHit,
  MemoryStatus,
  Note,
  Report,
  SecretStatusResult,
  ScannedRepo,
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
  Repo,
} from '@/types/weeklog'

/**
 * 骨架阶段未实现方法的占位：打印警告并返回传入的空值（不抛错），
 * 这样页面能渲染空状态、验证骨架完整性，而非整页崩溃。
 */
function todo<T>(name: string, fallback: T): Promise<T> {
  console.warn(`[weeklog:tauri] 尚未实现: ${name}（骨架阶段，返回空值）`)
  return Promise.resolve(fallback)
}

export const api: WeeklogAPI = {
  config: {
    get: () => invoke<Config>('config_get'),
    save: (cfg) => todo('config.save', cfg),
    reset: () => todo('config.reset', {} as Config),
    notesDir: () => todo('config.notesDir', ''),
  },
  env: {
    gitOk: () => invoke<boolean>('env_git_ok'),
    apiKeyStatus: () => todo('env.apiKeyStatus', false),
  },
  secrets: {
    available: () => todo('secrets.available', false),
    status: () => todo('secrets.status', { hasKey: false, available: false } as unknown as SecretStatusResult),
    set: () => todo('secrets.set', undefined),
    clear: () => todo('secrets.clear', undefined),
  },
  ai: {
    test: () => todo('ai.test', { ok: false, message: '尚未实现' } as AiTestResult),
  },
  repo: {
    validate: () => todo('repo.validate', { ok: false, branch: '' }),
    add: () => todo('repo.add', { error: '尚未实现' }),
    update: (_id, patch) => todo('repo.update', ({ repos: [], ...patch } as unknown) as Config),
    remove: () => todo('repo.remove', {} as unknown as Config),
    scan: () => todo('repo.scan', { repos: [] as ScannedRepo[], error: '尚未实现' }),
  },
  notes: {
    add: () => todo('notes.add', { file: '' }),
    getText: () => todo('notes.getText', ''),
    saveText: () => todo('notes.saveText', { ok: false }),
    list: () => todo('notes.list', [] as Note[]),
    summarize: () => todo('notes.summarize', { error: '尚未实现' }),
    replaceSummarized: () => todo('notes.replaceSummarized', { files: [] as string[] }),
  },
  report: {
    convert: (q) => todo('report.convert', { text: q.text }),
  },
  codexNotes: {
    list: () => todo('codexNotes.list', [] as CodexPendingNote[]),
    delete: () => todo('codexNotes.delete', { deleted: 0 }),
    write: () => todo('codexNotes.write', { written: 0, files: [] as string[] }),
    summarize: () => todo('codexNotes.summarize', { error: '尚未实现' }),
    status: () => todo('codexNotes.status', ({ enabled: false, running: false, port: 17321 } as unknown) as CodexHookStatus),
    copyConfig: () => todo('codexNotes.copyConfig', ({ ok: false } as unknown) as CodexHookCopyConfigResult),
    installHook: () => todo('codexNotes.installHook', ({ ok: false } as unknown) as CodexHookInstallResult),
    uninstallHook: () => todo('codexNotes.uninstallHook', ({ ok: false } as unknown) as CodexHookInstallResult),
  },
  zcodeNotes: {
    list: () => todo('zcodeNotes.list', [] as ZcodePendingNote[]),
    delete: () => todo('zcodeNotes.delete', { deleted: 0 }),
    write: () => todo('zcodeNotes.write', { written: 0, files: [] as string[] }),
    summarize: () => todo('zcodeNotes.summarize', { error: '尚未实现' }),
    status: () => todo('zcodeNotes.status', ({ enabled: false, running: false, port: 17322 } as unknown) as ZcodeHookStatus),
    copyConfig: () => todo('zcodeNotes.copyConfig', ({ ok: false } as unknown) as ZcodeHookCopyConfigResult),
    installHook: () => todo('zcodeNotes.installHook', ({ ok: false } as unknown) as ZcodeHookInstallResult),
    uninstallHook: () => todo('zcodeNotes.uninstallHook', ({ ok: false } as unknown) as ZcodeHookInstallResult),
  },
  collect: () => todo('collect', ({ stats: { commitCount: 0, noteCount: 0, noteProjectCount: 0, noteMiscCount: 0, bucketCount: 0, notesOnlyCount: 0, days: 0, estTokens: 0, repoErrors: [] }, range: { from: '', to: '' } } as unknown) as CollectResult),
  generate: () => todo('generate', ({ text: '', failedUnits: [] } as unknown) as Report),
  onProgress: () => () => {},
  history: {
    list: () => todo('history.list', [] as HistoryEntry[]),
    save: (e) => todo('history.save', ({ id: '', createdAt: 0, ...e } as unknown) as HistoryEntry),
    update: () => todo('history.update', { ok: false }),
  },
  dialog: {
    pickFolder: () => todo('dialog.pickFolder', null),
    pickRepo: () => todo('dialog.pickRepo', null),
    pickBackupFolder: () => todo('dialog.pickBackupFolder', null),
  },
  webdav: {
    test: () => todo('webdav.test', ({ ok: false, message: '尚未实现' } as unknown) as WebdavTestResult),
    syncNow: () => todo('webdav.syncNow', ({ ok: false } as unknown) as WebdavSyncResult),
    backupNow: () => todo('webdav.backupNow', ({ ok: false } as unknown) as WebdavBackupResult),
    listBackups: () => todo('webdav.listBackups', [] as WebdavBackupInfo[]),
    restoreBackup: () => todo('webdav.restoreBackup', ({ ok: false } as unknown) as WebdavRestoreResult),
    status: () => todo('webdav.status', ({ configured: false } as unknown) as WebdavStatus),
    savePassword: () => todo('webdav.savePassword', { ok: false }),
    passwordStatus: () => todo('webdav.passwordStatus', ({ saved: false } as unknown) as WebdavPasswordStatusResult),
    clearPassword: () => todo('webdav.clearPassword', { ok: false }),
  },
  localBackup: {
    create: () => todo('localBackup.create', ({ ok: false, error: '尚未实现' } as unknown) as LocalBackupResult),
  },
  memory: {
    list: () => todo('memory.list', [] as MemoryIndexItem[]),
    search: () => todo('memory.search', [] as MemorySearchHit[]),
    queueStatus: () => todo('memory.queueStatus', ({ pending: 0, total: 0, running: false } as unknown) as MemoryQueueStatus),
    status: () => todo('memory.status', ({ ready: false, source: 'local', model: '', modelSource: 'auto' } as unknown) as MemoryStatus),
    rebuild: () => todo('memory.rebuild', { generated: 0, failed: 0, error: '尚未实现' }),
    remove: () => todo('memory.remove', { ok: false }),
    inferProject: () => todo('memory.inferProject', ({ project: '' } as unknown) as MemoryInferResult),
  },
  prefs: {
    list: () => todo('prefs.list', [] as WritingPreference[]),
    add: () => todo('prefs.add', { item: null }),
    toggle: () => todo('prefs.toggle', { item: null }),
    remove: () => todo('prefs.remove', { deleted: 0 }),
    extract: () => todo('prefs.extract', { rule: '', error: '尚未实现' }),
  },
  chat: {
    sessions: () => todo('chat.sessions', [] as ChatSessionMeta[]),
    getSession: () => todo('chat.getSession', null),
    createSession: () => todo('chat.createSession', ({ id: '', title: '', messages: [] } as unknown) as ChatSession),
    renameSession: () => todo('chat.renameSession', { ok: false }),
    deleteSession: () => todo('chat.deleteSession', { ok: false }),
    send: () => todo('chat.send', { error: '尚未实现' }),
    generate: () => todo('chat.generate', { error: '尚未实现' }),
    cancel: () => todo('chat.cancel', { ok: false }),
    onStream: () => () => {},
  },
  tasks: {
    list: () => todo('tasks.list', [] as BackgroundTask[]),
    hasRunning: () => todo('tasks.hasRunning', false),
    remove: () => todo('tasks.remove', { ok: false }),
    clearFinished: () => todo('tasks.clearFinished', { ok: false }),
    onUpdate: () => () => {},
  },
  logs: {
    list: () => todo('logs.list', [] as AppLogEntry[]),
    clear: () => todo('logs.clear', { ok: false }),
    path: () => todo('logs.path', ''),
  },
  updates: {
    status: () => todo('updates.status', ({ phase: 'idle', currentVersion: '', latestVersion: '', progress: null } as unknown) as UpdateStatus),
    check: () => todo('updates.check', ({ phase: 'idle', currentVersion: '', latestVersion: '', progress: null } as unknown) as UpdateStatus),
    download: () => todo('updates.download', ({ phase: 'idle', currentVersion: '', latestVersion: '', progress: null } as unknown) as UpdateStatus),
    install: () => todo('updates.install', ({ phase: 'idle', currentVersion: '', latestVersion: '', progress: null } as unknown) as UpdateStatus),
    onUpdate: () => () => {},
  },
  ui: {
    setTheme: () => todo('ui.setTheme', false),
  },
  shell: {
    openExternal: (url: string) => {
      // 仅 http/https；open 内部受 capability shell:allow-open 约束
      if (!/^https?:\/\//i.test(url)) return Promise.resolve()
      return open(url)
    },
  },
  shortcut: {
    apply: () => todo('shortcut.apply', { ok: false, accel: '' }),
    suspend: () => todo('shortcut.suspend', false),
    resume: () => todo('shortcut.resume', false),
  },
  quicknote: {
    hide: () => {
      // fire-and-forget（对应 Electron 的 send）；忽略错误，窗口未创建时静默
      void invoke('quicknote_hide').catch(() => {})
    },
    onShow: (cb: () => void) => {
      let unlisten: UnlistenFn | undefined
      let active = true
      void listen('quicknote:show', () => {
        if (active) cb()
      }).then((fn) => {
        if (!active) fn()
        else unlisten = fn
      })
      return () => {
        active = false
        unlisten?.()
      }
    },
  },
}
