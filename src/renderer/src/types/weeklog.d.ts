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
  ui: {
    theme: 'auto' | 'light' | 'dark'
    quickNoteShortcut: string
  }
  ai: {
    provider: 'openai' | 'anthropic'
    maxInputTokens: number
    concurrency: number
    retries: number
    timeoutSeconds: number
    anthropic: AiSubConfig
    openai: AiSubConfig
  }
  output: {
    format: 'text' | 'md' | 'json'
    newline: 'CRLF' | 'LF'
    withCommits: boolean
    showNotes: boolean
  }
  webdav: {
    enabled: boolean
    url: string
    username: string
    autoSync: 'off' | 'pull' | 'push' | 'both'
  }
  memory: {
    enabled: boolean
    embeddingSource: 'local' | 'api'
    embeddingModel: string
    modelSource: 'auto' | 'huggingface' | 'modelscope'
    autoGenerate: boolean
    topK: number
  }
}

export interface Note {
  date: string
  project: string | null
  content: string
  source: string
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
  format?: 'text' | 'md' | 'json'
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

export interface WebdavStatus {
  lastSync?: string
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
  }
  webdav: {
    test: (url: string, username: string, password: string) => Promise<WebdavTestResult>
    syncNow: (direction: 'pull' | 'push' | 'both') => Promise<WebdavSyncResult>
    status: () => Promise<WebdavStatus>
    savePassword: (password: string) => Promise<{ ok: boolean }>
    passwordStatus: () => Promise<WebdavPasswordStatusResult>
    clearPassword: () => Promise<{ ok: boolean }>
  }
  memory: {
    list: () => Promise<MemoryIndexItem[]>
    search: (query: string, topK?: number) => Promise<MemorySearchHit[]>
    queueStatus: () => Promise<MemoryQueueStatus>
    rebuild: () => Promise<{ generated: number; failed: number; error?: string }>
    remove: (id: string) => Promise<{ ok: boolean }>
    inferProject: (noteText: string) => Promise<MemoryInferResult>
  }
  tasks: {
    list: () => Promise<BackgroundTask[]>
    hasRunning: () => Promise<boolean>
    remove: (id: string) => Promise<{ ok: boolean }>
    clearFinished: () => Promise<{ ok: boolean }>
    onUpdate: (cb: (payload: TaskUpdatePayload) => void) => () => void
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
