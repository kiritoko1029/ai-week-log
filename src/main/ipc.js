'use strict'
// @ts-check
/**
 * IPC 处理器：把主进程能力（配置/仓库/笔记/采集/生成/历史/对话框）暴露给渲染进程。
 */
const { ipcMain, dialog, shell } = require('electron')
const path = require('path')
const fs = require('fs')
const {
  loadConfig,
  saveConfig,
  defaultConfig,
  mergeConfig,
  resolveApiKey,
  apiKeyStatus,
} = require('./config')
const { checkGit, isGitRepo, currentBranch, scanGitRepos } = require('./git')
const { testProvider } = require('./llm')
const notes = require('./notes')
const secrets = require('./secrets')
const { collect, generate } = require('./pipeline')
const { isoDate } = require('./utils')
const webdav = require('./webdav')
const memory = require('./memory')
const chat = require('./chat')
const tasks = require('./tasks')

const HISTORY_FILE = 'history.json'
const SECRET_PROVIDERS = new Set(['openai', 'anthropic', 'webdav'])

function newId() {
  return 'r_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
}

function readHistory(dir) {
  const file = path.join(dir, HISTORY_FILE)
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8')) || []
  } catch (e) {
    console.error('[weeklog] history 读取失败：', e.message)
  }
  return []
}

function writeHistory(dir, list) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, HISTORY_FILE), JSON.stringify(list, null, 2), 'utf8')
}

/** 保存一份报告到历史：按 (type, rangeStart) 去重覆盖、保留最近 200 条，返回保存后的条目（含 id）。 */
function saveHistoryEntry(dir, entry) {
  const list = readHistory(dir)
  const existIdx = list.findIndex((h) => h.type === entry.type && h.rangeStart === entry.rangeStart)
  let saved
  if (existIdx >= 0) {
    saved = { ...list[existIdx], ...entry, createdAt: new Date().toISOString(), edited: false }
    list[existIdx] = saved
  } else {
    saved = { id: newId(), createdAt: new Date().toISOString(), ...entry }
    list.unshift(saved)
  }
  writeHistory(dir, list.slice(0, 200))
  return saved
}

function normalizeSecretProvider(provider, fallback) {
  const p = String(provider || fallback || '').trim()
  return SECRET_PROVIDERS.has(p) ? p : fallback
}

function registerIpc({ app, getMainWindow, updater }) {
  const userDataDir = app.getPath('userData')
  const getConfig = () => loadConfig(userDataDir)
  const persist = (cfg) => {
    saveConfig(userDataDir, mergeConfig(defaultConfig(), cfg))
    return getConfig()
  }
  const getNotesDir = () => {
    const cfg = getConfig()
    const d = cfg.notes && cfg.notes.dir
    if (d && path.isAbsolute(d)) return d
    if (d) return path.join(userDataDir, d)
    return path.join(userDataDir, 'notes')
  }

  // 后台任务推送：转发到渲染进程 'task:update' 通道
  tasks.setSender((payload) => {
    const win = getMainWindow()
    if (win && !win.isDestroyed()) {
      try { win.webContents.send('task:update', payload) } catch {}
    }
  })

  if (updater && typeof updater.setSender === 'function') {
    updater.setSender((payload) => {
      const win = getMainWindow()
      if (win && !win.isDestroyed()) {
        try { win.webContents.send('updates:update', payload) } catch {}
      }
    })
  }

  // 模型下载进度 → 推送到任务系统
  memory.setModelProgressCallback((info) => {
    // 把模型下载事件转为 task 事件
    if (info.phase === 'start') {
      // 不重复创建：若已有同 kind 的 running 任务，复用
      const existing = tasks.list().find((t) => t.kind === 'model_dl' && t.status === 'running')
      if (existing) {
        tasks.update(existing.id, { detail: `正在从 ${info.source} 下载 ${info.model}` })
      } else {
        tasks.create('model_dl', '下载 Embedding 模型', {
          detail: `正在从 ${info.source === 'modelscope' ? '魔搭社区' : 'HuggingFace'} 下载 ${info.model}`,
          progress: { done: 0, total: 100, label: '准备中' },
        })
      }
    } else if (info.phase === 'downloading') {
      const existing = tasks.list().find((t) => t.kind === 'model_dl' && t.status === 'running')
      if (existing) {
        tasks.update(existing.id, {
          progress: {
            done: info.progress || 0,
            total: 100,
            label: info.file ? `${info.file}（${info.progress || 0}%）` : `${info.progress || 0}%`,
          },
        })
      }
    } else if (info.phase === 'complete') {
      const existing = tasks.list().find((t) => t.kind === 'model_dl' && t.status === 'running')
      if (existing) tasks.done(existing.id, { model: info.model })
    } else if (info.phase === 'error') {
      const existing = tasks.list().find((t) => t.kind === 'model_dl' && t.status === 'running')
      if (existing) tasks.error(existing.id, info.error || '模型下载失败')
    }
  })

  // ── 配置 ──
  ipcMain.handle('config:get', () => getConfig())
  ipcMain.handle('config:save', (_e, cfg) => persist(cfg))
  ipcMain.handle('config:reset', () => persist(defaultConfig()))
  ipcMain.handle('config:notesDir', () => getNotesDir())

  // ── 环境 ──
  ipcMain.handle('env:gitOk', () => checkGit())
  ipcMain.handle('env:apiKeyStatus', () => apiKeyStatus(getConfig(), (p) => secrets.getKey(userDataDir, p)))

  // ── API Key（软件内填写，加密存储于系统钥匙串）──
  ipcMain.handle('secrets:available', () => secrets.isAvailable())
  ipcMain.handle('secrets:status', (_e, { provider } = {}) => ({
    hasKey: secrets.hasKey(userDataDir, normalizeSecretProvider(provider, getConfig().ai.provider)),
    available: secrets.isAvailable(),
  }))
  ipcMain.handle('secrets:set', (_e, { provider, key } = {}) =>
    secrets.setKey(userDataDir, normalizeSecretProvider(provider, getConfig().ai.provider), key)
  )
  ipcMain.handle('secrets:clear', (_e, { provider } = {}) => {
    secrets.clearKey(userDataDir, normalizeSecretProvider(provider, getConfig().ai.provider))
    return { ok: true }
  })

  // ── AI 连接测试 ──
  // 测试当前编辑中的配置（未保存也行），apiKey 从前端透传：优先用输入框的值，
  // 没填则回退到已存储的 key（便于测"已保存配置"是否仍有效）
  ipcMain.handle('ai:test', async (_e, { cfg, apiKey } = {}) => {
    const useCfg = cfg || getConfig()
    const provider = useCfg.ai.provider
    const key = apiKey || secrets.getKey(userDataDir, provider) || ''
    if (!key) {
      return { ok: false, message: `未设置 ${provider} 的 API Key，请先填写` }
    }
    return testProvider(useCfg, key)
  })

  // ── 仓库 ──
  ipcMain.handle('repo:validate', (_e, p) => {
    if (!p || !fs.existsSync(p)) return { ok: false, branch: '' }
    return { ok: isGitRepo(p), branch: currentBranch(p) }
  })
  ipcMain.handle('repo:add', (_e, { path: repoPath, name, branch, alias }) => {
    if (!isGitRepo(repoPath)) {
      return { error: '路径不是有效的 Git 仓库' }
    }
    const cfg = getConfig()
    const repo = {
      id: newId(),
      path: repoPath,
      name: (name && name.trim()) || path.basename(repoPath),
      alias: (alias && alias.trim()) || '',
      branch: branch || currentBranch(repoPath) || 'main',
      enabled: true,
    }
    cfg.repos.push(repo)
    return { repo: persist(cfg).repos.find((r) => r.id === repo.id) }
  })
  ipcMain.handle('repo:update', (_e, { id, patch }) => {
    const cfg = getConfig()
    const r = cfg.repos.find((x) => x.id === id)
    if (r) Object.assign(r, patch)
    return persist(cfg)
  })
  ipcMain.handle('repo:remove', (_e, id) => {
    const cfg = getConfig()
    cfg.repos = cfg.repos.filter((r) => r.id !== id)
    return persist(cfg)
  })
  // 扫描目录下的 Git 仓库（最大深度 3 层）
  ipcMain.handle('repo:scan', (_e, { rootDir, maxDepth } = {}) => {
    if (!rootDir || !fs.existsSync(rootDir) || !fs.statSync(rootDir).isDirectory()) {
      return { repos: [], error: '无效的目录路径' }
    }
    try {
      const depth = Math.max(1, Math.min(maxDepth ?? 3, 3))
      return { repos: scanGitRepos(rootDir, depth), error: null }
    } catch (e) {
      return { repos: [], error: (e && e.message) || String(e) }
    }
  })

  // ── 笔记 ──
  ipcMain.handle('notes:add', (_e, { date, project, content }) => {
    const cfg = getConfig()
    const file = notes.appendNote(getNotesDir(), date, project, content, cfg.notes.miscProject)
    return { file: path.relative(userDataDir, file) }
  })
  ipcMain.handle('notes:getText', (_e, date) => notes.getNoteText(getNotesDir(), date))
  ipcMain.handle('notes:saveText', (_e, { date, text }) => {
    notes.saveNoteText(getNotesDir(), date, text)
    return { ok: true }
  })
  ipcMain.handle('notes:list', (_e, { from, to }) => {
    const cfg = getConfig()
    return notes.loadNotes(getNotesDir(), from, to, cfg.notes.miscProject)
  })

  // ── 采集 / 生成 ──
  ipcMain.handle('collect', (_e, { rangeOpts, options }) =>
    collect({ cfg: getConfig(), rangeOpts: rangeOpts || {}, notesDir: getNotesDir(), options: options || {} })
  )

  // 生成报告：返回 { taskId } + 通过 task:update 推送进度，跨页面保持状态
  // 同时保留 generate:progress 事件（兼容现有 hook）
  ipcMain.handle('generate', async (event, { rangeOpts, options }) => {
    const cfg = getConfig()
    const { key, has, envName } = resolveApiKey(cfg, (p) => secrets.getKey(userDataDir, p))
    if (!has) {
      return { error: `未设置 ${cfg.ai.provider} 的 API Key（请在「AI 与输出设置」中填写，或配置环境变量 ${envName}）` }
    }
    const reportType = (options && options._reportType) || '报告'
    const taskId = tasks.create('generate', `生成${reportType}`, {
      detail: '采集 commit + 加载笔记…',
      progress: { done: 0, total: 0, label: '采集中' },
    })
    try {
      const report = await generate({
        cfg,
        apiKey: key,
        rangeOpts: rangeOpts || {},
        notesDir: getNotesDir(),
        options: { ...options, userDataDir },
        onProgress: (msg) => {
          // 1) 兼容旧事件
          try { event.sender.send('generate:progress', msg) } catch {}
          // 2) 更新任务系统
          tasks.update(taskId, {
            detail: `AI 融合生成中… ${msg.done}/${msg.total}（${msg.project}）`,
            progress: { done: msg.done, total: msg.total, label: msg.project || '' },
          })
        },
      })
      if (report.error) {
        tasks.error(taskId, report.error)
      } else {
        const m = report.meta || {}
        tasks.done(taskId, {
          commitCount: m.commitCount,
          noteCount: m.noteCount,
          bucketCount: m.bucketCount,
          durationMs: m.durationMs,
        })
      }
      return report
    } catch (e) {
      const message = (e && e.message) || '生成失败'
      tasks.error(taskId, message)
      return { error: message, failedUnits: [] }
    }
  })

  // ── 历史 ──
  ipcMain.handle('history:list', () => readHistory(userDataDir))
  ipcMain.handle('history:save', (_e, entry) => saveHistoryEntry(userDataDir, entry))
  ipcMain.handle('history:update', (_e, { id, text } = {}) => {
    if (!id || typeof text !== 'string') return { ok: false }
    const list = readHistory(userDataDir)
    const item = list.find((h) => h.id === id)
    if (!item) return { ok: false }
    item.text = text
    // 标记为人工编辑过，便于历史页区分
    item.edited = true
    writeHistory(userDataDir, list)
    return { ok: true }
  })

  // ── 对话框 ──
  ipcMain.handle('dialog:pickFolder', async () => {
    const win = getMainWindow()
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
    return r.canceled ? null : r.filePaths[0]
  })
  ipcMain.handle('dialog:pickRepo', async () => {
    const win = getMainWindow()
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
    return r.canceled ? null : r.filePaths[0]
  })
  // 在系统默认浏览器打开外链（仅放行 http/https，防 XSS）
  ipcMain.handle('shell:openExternal', (_e, url) => {
    if (typeof url !== 'string') return
    try {
      const u = new URL(url)
      if (u.protocol === 'http:' || u.protocol === 'https:') shell.openExternal(u.href)
    } catch {}
  })

  // ── WebDAV 同步 ──
  ipcMain.handle('webdav:test', async (_e, { url, username, password }) => {
    return webdav.testConnection({ url, username, password: password || secrets.getKey(userDataDir, 'webdav') })
  })
  ipcMain.handle('webdav:syncNow', async (_e, { direction } = {}) => {
    const cfg = getConfig()
    const password = secrets.getKey(userDataDir, 'webdav')
    const dir = direction || 'both'
    const dirLabel = dir === 'both' ? '双向' : dir === 'pull' ? '拉取' : '推送'
    const taskId = tasks.create('webdav', `WebDAV 同步（${dirLabel}）`, {
      detail: '正在同步…',
      progress: { done: 0, total: 0, label: dirLabel },
    })
    try {
      const result = await webdav.syncAll({ cfg, dir: userDataDir, password, direction: dir })
      tasks.done(taskId, { pulled: result.pulled, pushed: result.pushed })
      return result
    } catch (e) {
      tasks.error(taskId, e.message || '同步失败')
      throw e
    }
  })
  ipcMain.handle('webdav:status', () => webdav.readStatus(userDataDir))
  ipcMain.handle('webdav:savePassword', (_e, { password } = {}) => {
    secrets.setKey(userDataDir, 'webdav', password)
    return { ok: true }
  })
  ipcMain.handle('webdav:passwordStatus', () => ({
    hasPassword: secrets.hasKey(userDataDir, 'webdav'),
    available: secrets.isAvailable(),
  }))
  ipcMain.handle('webdav:clearPassword', () => {
    secrets.clearKey(userDataDir, 'webdav')
    return { ok: true }
  })

  // ── AI 记忆 ──
  ipcMain.handle('memory:list', () => memory.listIndex(userDataDir))
  ipcMain.handle('memory:search', (_e, { query, topK } = {}) => {
    const cfg = getConfig()
    return memory.search(userDataDir, query, { topK, cfg })
  })
  ipcMain.handle('memory:queueStatus', () => memory.queueStatus())
  ipcMain.handle('memory:rebuild', async () => {
    const cfg = getConfig()
    const { key, has } = resolveApiKey(cfg, (p) => secrets.getKey(userDataDir, p))
    if (!has) return { error: '未配置 AI API Key' }
    const history = readHistory(userDataDir)
    const taskId = tasks.create('memory', '重建 AI 记忆库', {
      detail: `从 ${history.length} 份历史报告生成记忆…`,
      progress: { done: 0, total: history.length, label: '处理中' },
    })
    try {
      const result = await memory.rebuild(userDataDir, {
        cfg, apiKey: key, history,
        onProgress: (p) => tasks.update(taskId, {
          progress: { done: p.done, total: p.total, label: `${p.done}/${p.total}` },
        }),
      })
      tasks.done(taskId, result)
      return result
    } catch (e) {
      tasks.error(taskId, e.message || '重建失败')
      return { error: e.message }
    }
  })
  ipcMain.handle('memory:delete', (_e, { id } = {}) => memory.deleteEntry(userDataDir, id))
  ipcMain.handle('memory:inferProject', async (_e, { noteText } = {}) => {
    const cfg = getConfig()
    const { key, has } = resolveApiKey(cfg, (p) => secrets.getKey(userDataDir, p))
    if (!has) return { error: '未配置 AI API Key' }
    return memory.inferProject(userDataDir, noteText, { cfg, apiKey: key })
  })

  // ── AI 对话问答 ──
  const activeStreams = new Map() // msgId → AbortController（支持中途取消）

  // 报告生成编排：走真实 generate 流水线 → 存档历史 → 入会话 → 经 chat:stream 推进度/结果
  const runChatReport = async ({ sessionId, reportType, rangeOpts, cfg, key, send }) => {
    const cnLabel = reportType === 'weekly' ? '周报' : '日报'
    send({ type: 'report_progress', stage: '采集中' })
    const options = {
      format: cfg.output.format,
      weekStart: cfg.weekStart,
      merge: cfg.filters.mergeCommits,
      _reportType: cnLabel,
      userDataDir,
    }
    const report = await generate({
      cfg,
      apiKey: key,
      rangeOpts: rangeOpts || {},
      notesDir: getNotesDir(),
      options,
      onProgress: (m) => send({ type: 'report_progress', done: m.done, total: m.total, project: m.project }),
    })
    if (!report || report.error) {
      send({ type: 'error', message: (report && report.error) || '生成失败' })
      return
    }
    const rangeStart = isoDate(report.rangeStart)
    const rangeEnd = isoDate(report.rangeEnd)
    const saved = saveHistoryEntry(userDataDir, {
      type: cnLabel,
      rangeStart,
      rangeEnd,
      text: report.text,
      meta: report.meta || {},
    })
    const msg = chat.appendMessage(userDataDir, sessionId, {
      role: 'assistant',
      content: report.text,
      report: { reportType, rangeStart, rangeEnd, historyId: saved.id, meta: report.meta || {} },
    })
    send({ type: 'report_done', message: msg })
  }

  ipcMain.handle('chat:sessions', () => chat.listSessions(userDataDir))
  ipcMain.handle('chat:session:get', (_e, { id } = {}) => chat.getSession(userDataDir, id))
  ipcMain.handle('chat:session:create', (_e, { title } = {}) => chat.createSession(userDataDir, title))
  ipcMain.handle('chat:session:rename', (_e, { id, title } = {}) => chat.renameSession(userDataDir, id, title))
  ipcMain.handle('chat:session:delete', (_e, { id } = {}) => chat.deleteSession(userDataDir, id))
  ipcMain.handle('chat:cancel', (_e, { msgId } = {}) => {
    const ctrl = activeStreams.get(msgId)
    if (ctrl) {
      ctrl.abort()
      return { ok: true }
    }
    return { ok: false }
  })
  ipcMain.handle('chat:send', (_e, { sessionId, content } = {}) => {
    if (!sessionId || !content || !content.trim()) return { error: '缺少会话或内容' }
    const cfg = getConfig()
    const { key, has } = resolveApiKey(cfg, (p) => secrets.getKey(userDataDir, p))
    if (!has) return { error: `未设置 ${cfg.ai.provider} 的 API Key，请先在设置中填写` }
    const msgId = 'msg_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
    const ctrl = new AbortController()
    activeStreams.set(msgId, ctrl)
    const send = (payload) => {
      const win = getMainWindow()
      if (win && !win.isDestroyed()) win.webContents.send('chat:stream', { sessionId, msgId, ...payload })
    }
    // 不 await：立即回执 msgId，后台异步处理（意图识别 → 报告生成 或 问答）
    ;(async () => {
      // 报告意图：规则预筛 → LLM 细判 → 命中则走真实生成流水线
      if (chat.looksLikeReportRequest(content)) {
        send({ type: 'report_progress', stage: '理解中' })
        const intent = await chat.detectReportIntent({ cfg, apiKey: key, text: content, now: new Date() })
        if (intent && intent.action === 'generate' && intent.reportType) {
          chat.appendMessage(userDataDir, sessionId, { role: 'user', content })
          await runChatReport({ sessionId, reportType: intent.reportType, rangeOpts: intent.rangeOpts, cfg, key, send })
          return
        }
      }
      // 普通问答（askStream 内部会落 user 消息）
      await chat.askStream({
        dir: userDataDir,
        cfg,
        apiKey: key,
        sessionId,
        content,
        history: readHistory(userDataDir),
        notesDir: getNotesDir(),
        searchMemory: (q, k) => memory.search(userDataDir, q, { topK: k, cfg }),
        onEvent: send,
        signal: ctrl.signal,
      })
    })()
      .catch((e) => send({ type: 'error', message: (e && e.message) || '生成失败' }))
      .finally(() => activeStreams.delete(msgId))
    return { msgId }
  })

  ipcMain.handle('chat:generate', (_e, { sessionId, reportType, when } = {}) => {
    if (!sessionId || !reportType) return { error: '缺少会话或报告类型' }
    const cfg = getConfig()
    const { key, has } = resolveApiKey(cfg, (p) => secrets.getKey(userDataDir, p))
    if (!has) return { error: `未设置 ${cfg.ai.provider} 的 API Key，请先在设置中填写` }
    const msgId = 'msg_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
    const ctrl = new AbortController()
    activeStreams.set(msgId, ctrl)
    const send = (payload) => {
      const win = getMainWindow()
      if (win && !win.isDestroyed()) win.webContents.send('chat:stream', { sessionId, msgId, ...payload })
    }
    const cnLabel = reportType === 'weekly' ? '周报' : '日报'
    const whenLabel =
      when === 'yesterday' ? '昨天' : when === 'last_week' ? '上周' : when === 'this_week' ? '本周' : '今天'
    chat.appendMessage(userDataDir, sessionId, { role: 'user', content: `生成${whenLabel}${cnLabel}` })
    runChatReport({ sessionId, reportType, rangeOpts: chat.whenToRangeOpts(reportType, when), cfg, key, send })
      .catch((e) => send({ type: 'error', message: (e && e.message) || '生成失败' }))
      .finally(() => activeStreams.delete(msgId))
    return { msgId }
  })

  // ── 后台任务管理 ──
  ipcMain.handle('tasks:list', () => tasks.list())
  ipcMain.handle('tasks:hasRunning', () => tasks.hasRunning())
  ipcMain.handle('tasks:remove', (_e, { id } = {}) => { tasks.remove(id); return { ok: true } })
  ipcMain.handle('tasks:clearFinished', () => { tasks.clearFinished(); return { ok: true } })

  // ── 应用更新 ──
  ipcMain.handle('updates:status', () => updater ? updater.status() : null)
  ipcMain.handle('updates:check', () => updater ? updater.check({ manual: true }) : null)
  ipcMain.handle('updates:download', () => updater ? updater.download() : null)
  ipcMain.handle('updates:install', () => updater ? updater.install() : null)
}

module.exports = { registerIpc }
