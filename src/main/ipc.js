'use strict'
// @ts-check
/**
 * IPC 处理器：把主进程能力（配置/仓库/笔记/采集/生成/历史/对话框）暴露给渲染进程。
 */
const { ipcMain, dialog } = require('electron')
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
const { checkGit, isGitRepo, currentBranch } = require('./git')
const notes = require('./notes')
const secrets = require('./secrets')
const { collect, generate } = require('./pipeline')

const HISTORY_FILE = 'history.json'

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

function registerIpc({ app, getMainWindow }) {
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
  ipcMain.handle('secrets:get', (_e, { provider } = {}) => ({
    key: secrets.getKey(userDataDir, provider || getConfig().ai.provider),
    available: secrets.isAvailable(),
  }))
  ipcMain.handle('secrets:set', (_e, { provider, key } = {}) =>
    secrets.setKey(userDataDir, provider || getConfig().ai.provider, key)
  )
  ipcMain.handle('secrets:clear', (_e, { provider } = {}) => {
    secrets.clearKey(userDataDir, provider || getConfig().ai.provider)
    return { ok: true }
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

  ipcMain.handle('generate', async (event, { rangeOpts, options }) => {
    const cfg = getConfig()
    const { key, has, envName } = resolveApiKey(cfg, (p) => secrets.getKey(userDataDir, p))
    if (!has) {
      return { error: `未设置 ${cfg.ai.provider} 的 API Key（请在「AI 与输出设置」中填写，或配置环境变量 ${envName}）` }
    }
    const report = await generate({
      cfg,
      apiKey: key,
      rangeOpts: rangeOpts || {},
      notesDir: getNotesDir(),
      options: options || {},
      onProgress: (msg) => {
        try {
          event.sender.send('generate:progress', msg)
        } catch {}
      },
    })
    return report
  })

  // ── 历史 ──
  ipcMain.handle('history:list', () => readHistory(userDataDir))
  ipcMain.handle('history:save', (_e, entry) => {
    const list = readHistory(userDataDir)
    list.unshift({ id: newId(), createdAt: new Date().toISOString(), ...entry })
    writeHistory(userDataDir, list.slice(0, 200))
    return list[0]
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
}

module.exports = { registerIpc }
