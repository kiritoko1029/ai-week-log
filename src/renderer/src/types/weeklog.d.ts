/**
 * window.weeklog 桥接 API 的类型定义。
 * 严格对应 src/preload/index.js 通过 contextBridge 暴露的能力，作为重构期契约文档。
 */

export interface Repo {
  id: string
  path: string
  name: string
  alias?: string
  branch: string
  enabled: boolean
  author?: string
}

/** 报告输出格式：紧凑文本（每天一行）/ 格式化文本（每项目一行）/ Markdown */
export type ReportFormat = 'compact' | 'text' | 'md'

/** 扫描得到的仓库候选项（未注册） */
export interface ScannedRepo {
  path: string
  name: string
  branch: string
}

export interface AiSubConfig {
  model: string
  baseUrl: string
  temperature: number
  maxTokens: number
}

export interface Config {
  schemaVersion: number
  weekStart: 'monday' | 'sunday'
  timezone: string
  dateBasis: 'author' | 'committer'
  repos: Repo[]
  filters: {
    author: string[]
    mergeCommits: 'exclude' | 'include' | 'only'
    excludeGrep: string[]
  }
  notes: {
    enabled: boolean
    miscProject: string
    dir?: string
  }
  codexHook: {
    enabled: boolean
    port: number
  }
  ui: {
    theme: 'auto' | 'light' | 'dark'
    quickNoteShortcut: string
  }
  ai: {
    provider: 'openai' | 'anthropic'
    concurrency: number
    retries: number
    timeoutSeconds: number
    anthropic: AiSubConfig
    openai: AiSubConfig
    chat: { maxTokens: number; topK: number; historyTurns: number; thinking: boolean }
  }
  output: {
    format: ReportFormat
    newline: 'CRLF' | 'LF'
    withCommits: boolean
    showNotes: boolean
  }
  webdav: {
    enabled: boolean
    url: string
    username: string
    autoSync: 'off' | 'pull' | 'push' | 'both'
    backupRetention?: number
  }
  memory: {
    enabled: boolean
    embeddingSource: 'local' | 'api'
    embeddingModel: string
    modelSource: 'auto' | 'huggingface' | 'modelscope'
    autoGenerate: boolean
    topK: number
  }
  proxy: {
    mode: 'off' | 'system' | 'custom'
    url: string
  }
}

export interface Note {
  date: string
  project: string | null
  content: string
  source: string
}

export interface CodexPendingNote {
  id: string
  source: 'codex'
  status: 'pending' | 'written' | 'deleted'
  cwd: string
  project: string
  summary: string
  branch?: string
  changedFiles: string[]
  title?: string
  createdAt: string
  writtenAt?: string
}

export interface CodexHookStatus {
  enabled: boolean
  hasToken: boolean
  running: boolean
  host: string
  port: number
  endpoint: string
  error: string
  hookInstalled: boolean
  hookCount: number
  hooksPath: string
  hookError: string
}

export interface CodexHookCopyConfigResult {
  enabled: boolean
  endpoint: string
  text: string
}

export interface CodexHookInstallStatus {
  hooksPath: string
  exists: boolean
  installed: boolean
  hookCount: number
  error: string
}

export interface CodexHookInstallResult {
  ok: boolean
  installed?: boolean
  removed?: number
  replaced?: number
  hooksPath?: string
  backupPath?: string
  endpoint?: string
  error?: string
  status?: CodexHookInstallStatus
}

export interface CollectStats {
  commitCount: number
  noteCount: number
  noteProjectCount: number
  noteMiscCount: number
  bucketCount: number
  notesOnlyCount: number
  days: number
  estTokens: number
  repoErrors: { repo: string; error: string }[]
}

export interface CollectResult {
  stats: CollectStats
  range: { from: string; to: string; timezone?: string }
}

export interface GenerateRangeOpts {
  mode?: 'daily'
  date?: string
  week?: 'current' | 'last' | string
  from?: string
  to?: string
}

export interface GenerateOptions {
  noNotes?: boolean
  format?: ReportFormat
  author?: string
  merge?: 'exclude' | 'include' | 'only'
  weekStart?: 'monday' | 'sunday'
  _reportType?: string
}

export interface GenerateProgress {
  done: number
  total: number
  project: string
}

export interface ReportMeta {
  commitCount?: number
  noteCount?: number
  bucketCount?: number
  durationMs?: number
  failedUnits?: string[]
}

export interface Report {
  text?: string
  error?: string
  meta?: ReportMeta
  rangeStart?: string
  rangeEnd?: string
  failedUnits: string[]
}

export interface HistoryEntry {
  id: string
  createdAt: string
  type: '周报' | '日报'
  rangeStart: string
  rangeEnd: string
  text: string
  meta: ReportMeta
  /** 人工编辑过（用户在历史/预览里改过正文） */
  edited?: boolean
}

export interface SecretStatusResult {
  hasKey: boolean
  available: boolean
}

export interface WebdavPasswordStatusResult {
  hasPassword: boolean
  available: boolean
}

export interface WebdavTestResult {
  ok: boolean
  message: string
}

/** AI 连接测试结果 */
export interface AiTestResult {
  ok: boolean
  message: string
  model?: string
  latencyMs?: number
}

export interface WebdavSyncResult {
  pulled: number
  pushed: number
  errors: string[]
}

export interface WebdavBackupInfo {
  name: string
  deviceName: string
  createdAt: string
  size: number
  lastModified: string
}

export interface WebdavBackupResult {
  name: string
  remoteUrl?: string
  bytes?: number
  fileCount?: number
  pruned?: number
}

export interface WebdavRestoreResult {
  name: string
  safetyName: string
  restoredFiles: number
  manifest?: {
    schemaVersion: number
    createdAt: string
    deviceName: string
    appVersion?: string
    fileCount?: number
  }
}

export interface LocalBackupResult {
  name: string
  filePath: string
  bytes: number
  fileCount: number
}

export interface WebdavStatus {
  lastSync?: string
  lastBackup?: string
  lastRestore?: string
  direction?: string
  durationMs?: number
  pulled?: number
  pushed?: number
  errors?: string[]
}

export interface MemoryIndexItem {
  id: string
  date: string
  project: string
  keywords: string[]
  digest: string
  embeddingReady: boolean
  updatedAt: string
  createdAt: string
}

export interface MemorySearchHit {
  id: string
  date: string
  project: string
  digest: string
  keywords: string[]
  full: string
  score: number
}

export interface MemoryInferResult {
  project: string
  confidence: number
  reason?: string
  suggestedSummary?: string
  matches?: { project: string; date: string; digest: string; score: number }[]
  error?: string
}

export interface MemoryQueueStatus {
  pending: number
  total: number
  running: boolean
}

/** 记忆系统整体状态（模型 + 向量化进度聚合） */
export interface MemoryStatus {
  /** embedding 来源：local | api */
  source: 'local' | 'api'
  /** 模型名（如 Xenova/multilingual-e5-small） */
  model: string
  /** 模型下载源 */
  modelSource: 'auto' | 'huggingface' | 'modelscope'
  /** 本地模型文件是否已就绪（source=api 时恒为 false，无意义） */
  modelReady: boolean
  /** 模型占用空间（MB，就绪时 >0） */
  modelSizeMB: number
  /** 记忆总条数 */
  total: number
  /** 已向量化条数 */
  embedded: number
  /** 向量维度（0 表示尚无任何向量产出） */
  dim: number
}

/** 问答上下文引用来源 */
export interface ChatRef {
  kind: 'memory' | 'report' | 'note'
  label: string
  date?: string
  project?: string
  snippet: string
}

export interface ChatUsage {
  inputTokens: number
  outputTokens: number
  model: string
}

/** 一份对话内生成的报告（用于渲染报告卡片） */
export interface ChatReport {
  reportType: 'daily' | 'weekly'
  rangeStart: string
  rangeEnd: string
  historyId: string
  meta?: ReportMeta
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt: string
  /** 模型思考过程（Anthropic thinking / OpenAI reasoning summary），可折叠展示 */
  reasoning?: string
  refs?: ChatRef[]
  usage?: ChatUsage
  /** 非空表示该 assistant 消息是一份生成的报告 */
  report?: ChatReport
}

/** 完整会话（含 messages） */
export interface ChatSession {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  messages: ChatMessage[]
}

/** 会话列表项（轻量元数据） */
export interface ChatSessionMeta {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  messageCount: number
}

/** chat:stream 推送的事件载荷 */
export type ChatStreamPayload = { sessionId: string; msgId: string } & (
  | { type: 'refs'; refs: ChatRef[] }
  | { type: 'thinking'; text: string }
  | { type: 'delta'; text: string }
  | { type: 'done'; message: ChatMessage; usage: ChatUsage }
  | { type: 'report_progress'; stage?: string; done?: number; total?: number; project?: string }
  | { type: 'report_done'; message: ChatMessage }
  | { type: 'aborted' }
  | { type: 'error'; message: string }
)

export type TaskKind = 'generate' | 'memory' | 'model_dl' | 'webdav' | 'custom'
export type TaskStatus = 'running' | 'done' | 'error' | 'cancelled'

export interface BackgroundTask {
  id: string
  kind: TaskKind
  title: string
  status: TaskStatus
  progress: { done: number; total: number; label: string } | null
  detail: string
  error: string | null
  result: unknown
  createdAt: number
  updatedAt: number
}

export interface TaskUpdatePayload {
  type: 'update' | 'remove' | 'clear'
  task?: BackgroundTask
  id?: string
}

export type UpdatePhase =
  | 'disabled'
  | 'idle'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  | 'error'

export interface UpdateProgress {
  percent: number
  transferred?: number
  total?: number
  bytesPerSecond?: number
}

export interface UpdateStatus {
  phase: UpdatePhase
  currentVersion: string
  latestVersion: string
  releaseName?: string
  releaseNotes?: string
  progress: UpdateProgress | null
  error: string
  isPackaged: boolean
  updatedAt: number
  canCheck: boolean
  canDownload: boolean
  canInstall: boolean
}

export interface UpdatePayload {
  type: 'status'
  status: UpdateStatus
}

export interface AppLogEntry {
  ts: string
  level: 'debug' | 'info' | 'warn' | 'error'
  scope: string
  message: string
  data?: Record<string, unknown>
}

export interface WeeklogAPI {
  config: {
    get: () => Promise<Config>
    save: (cfg: Config) => Promise<Config>
    reset: () => Promise<Config>
    notesDir: () => Promise<string>
  }
  env: {
    gitOk: () => Promise<boolean>
    apiKeyStatus: () => Promise<boolean>
  }
  secrets: {
    available: () => Promise<boolean>
    status: (provider: 'openai' | 'anthropic') => Promise<SecretStatusResult>
    set: (provider: 'openai' | 'anthropic', key: string) => Promise<void>
    clear: (provider: 'openai' | 'anthropic') => Promise<void>
  }
  ai: {
    /** 连接测试：验证 endpoint / 鉴权 / 模型 / 网络；apiKey 留空则用已存储的 key */
    test: (cfg: Config, apiKey?: string) => Promise<AiTestResult>
  }
  repo: {
    validate: (p: string) => Promise<{ ok: boolean; branch: string }>
    add: (r: { path: string; name?: string; branch?: string; alias?: string }) => Promise<{ repo?: Repo; error?: string }>
    update: (id: string, patch: Partial<Repo>) => Promise<Config>
    remove: (id: string) => Promise<Config>
    scan: (rootDir: string, maxDepth?: number) => Promise<{ repos: ScannedRepo[]; error: string | null }>
  }
  notes: {
    add: (n: { date: string; project: string; content: string }) => Promise<{ file: string }>
    getText: (date: string) => Promise<string>
    saveText: (n: { date: string; text: string }) => Promise<{ ok: boolean }>
    list: (q: { from: string; to: string }) => Promise<Note[]>
    summarize: (items: Note[]) => Promise<{ text?: string; model?: string; error?: string; inputTokens?: number; outputTokens?: number }>
  }
  report: {
    /** 在 compact / text / md 三种格式间互转（不调 AI，纯字符串解析+重渲染）。失败回退原文本。 */
    convert: (q: { text: string; from: ReportFormat; to: ReportFormat; newline?: 'CRLF' | 'LF' }) => Promise<{ text: string }>
  }
  codexNotes: {
    list: () => Promise<CodexPendingNote[]>
    delete: (ids: string[]) => Promise<{ deleted: number }>
    write: (q: { ids: string[]; project?: string; content?: string }) => Promise<{ written: number; files: string[] }>
    summarize: (ids: string[]) => Promise<{ text?: string; model?: string; error?: string; inputTokens?: number; outputTokens?: number }>
    status: () => Promise<CodexHookStatus>
    copyConfig: () => Promise<CodexHookCopyConfigResult>
    installHook: () => Promise<CodexHookInstallResult>
    uninstallHook: () => Promise<CodexHookInstallResult>
  }
  collect: (q: { rangeOpts: GenerateRangeOpts; options: GenerateOptions }) => Promise<CollectResult>
  generate: (q: { rangeOpts: GenerateRangeOpts; options: GenerateOptions }) => Promise<Report>
  onProgress: (cb: (m: GenerateProgress) => void) => () => void
  history: {
    list: () => Promise<HistoryEntry[]>
    save: (e: Omit<HistoryEntry, 'id' | 'createdAt'>) => Promise<HistoryEntry>
    update: (id: string, text: string) => Promise<{ ok: boolean }>
  }
  dialog: {
    pickFolder: () => Promise<string | null>
    pickRepo: () => Promise<string | null>
    pickBackupFolder: () => Promise<string | null>
  }
  webdav: {
    test: (url: string, username: string, password: string) => Promise<WebdavTestResult>
    syncNow: (direction: 'pull' | 'push' | 'both') => Promise<WebdavSyncResult>
    backupNow: () => Promise<WebdavBackupResult>
    listBackups: () => Promise<WebdavBackupInfo[]>
    restoreBackup: (name: string) => Promise<WebdavRestoreResult>
    status: () => Promise<WebdavStatus>
    savePassword: (password: string) => Promise<{ ok: boolean }>
    passwordStatus: () => Promise<WebdavPasswordStatusResult>
    clearPassword: () => Promise<{ ok: boolean }>
  }
  localBackup: {
    create: (dir?: string) => Promise<LocalBackupResult>
  }
  memory: {
    list: () => Promise<MemoryIndexItem[]>
    search: (query: string, topK?: number) => Promise<MemorySearchHit[]>
    queueStatus: () => Promise<MemoryQueueStatus>
    status: () => Promise<MemoryStatus>
    rebuild: () => Promise<{ generated: number; failed: number; error?: string }>
    remove: (id: string) => Promise<{ ok: boolean }>
    inferProject: (noteText: string) => Promise<MemoryInferResult>
  }
  chat: {
    sessions: () => Promise<ChatSessionMeta[]>
    getSession: (id: string) => Promise<ChatSession | null>
    createSession: (title?: string) => Promise<ChatSession>
    renameSession: (id: string, title: string) => Promise<{ ok: boolean; title?: string }>
    deleteSession: (id: string) => Promise<{ ok: boolean }>
    /** 发起流式问答，立即返回 { msgId }，正文经 onStream 推送 */
    send: (sessionId: string, content: string) => Promise<{ msgId?: string; error?: string }>
    generate: (
      sessionId: string,
      reportType: 'daily' | 'weekly',
      when: string
    ) => Promise<{ msgId?: string; error?: string }>
    cancel: (msgId: string) => Promise<{ ok: boolean }>
    onStream: (cb: (payload: ChatStreamPayload) => void) => () => void
  }
  tasks: {
    list: () => Promise<BackgroundTask[]>
    hasRunning: () => Promise<boolean>
    remove: (id: string) => Promise<{ ok: boolean }>
    clearFinished: () => Promise<{ ok: boolean }>
    onUpdate: (cb: (payload: TaskUpdatePayload) => void) => () => void
  }
  logs: {
    list: (limit?: number) => Promise<AppLogEntry[]>
    clear: () => Promise<{ ok: boolean }>
    path: () => Promise<string>
  }
  updates: {
    status: () => Promise<UpdateStatus>
    check: () => Promise<UpdateStatus>
    download: () => Promise<UpdateStatus>
    install: () => Promise<UpdateStatus>
    onUpdate: (cb: (payload: UpdatePayload) => void) => () => void
  }
  ui: {
    setTheme: (theme: 'auto' | 'light' | 'dark') => Promise<boolean>
  }
  shell: {
    /** 在系统默认浏览器打开外链（仅 http/https） */
    openExternal: (url: string) => Promise<void>
  }
  shortcut: {
    apply: () => Promise<{ ok: boolean; accel: string }>
    suspend: () => Promise<boolean>
    resume: () => Promise<boolean>
  }
  quicknote: {
    hide: () => void
    onShow: (cb: () => void) => () => void
  }
}

declare global {
  interface Window {
    weeklog: WeeklogAPI
  }
  /** 应用版本号，由 vite 编译期从 package.json 注入 */
  const __APP_VERSION__: string
}

export {}
