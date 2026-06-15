'use strict'
// @ts-check
/**
 * 自动更新控制器：封装 electron-updater，向 IPC 暴露可序列化状态。
 */

let autoUpdater = null
try {
  autoUpdater = require('electron-updater').autoUpdater
} catch {}

function createUpdaterController({ app }) {
  let sender = null
  let wired = false
  let startupTimer = null
  const isPackaged = !!(app && app.isPackaged)
  const currentVersion = app && typeof app.getVersion === 'function' ? app.getVersion() : ''

  const state = {
    phase: isPackaged ? 'idle' : 'disabled',
    currentVersion,
    latestVersion: '',
    releaseName: '',
    releaseNotes: '',
    progress: null,
    error: isPackaged ? '' : '自动更新仅在安装包版本中可用',
    isPackaged,
    updatedAt: Date.now(),
  }

  function snapshot() {
    return {
      ...state,
      progress: state.progress ? { ...state.progress } : null,
      canCheck: state.isPackaged && state.phase !== 'checking' && state.phase !== 'downloading',
      canDownload: state.isPackaged && state.phase === 'available',
      canInstall: state.isPackaged && state.phase === 'downloaded',
    }
  }

  function emit() {
    if (!sender) return
    try { sender({ type: 'status', status: snapshot() }) } catch {}
  }

  function patch(next) {
    Object.assign(state, next, { updatedAt: Date.now() })
    emit()
    return snapshot()
  }

  function updateInfo(info) {
    return {
      latestVersion: (info && info.version) || state.latestVersion || '',
      releaseName: (info && info.releaseName) || '',
      releaseNotes: normalizeReleaseNotes(info && info.releaseNotes),
    }
  }

  function ensureAvailable() {
    if (!state.isPackaged || !autoUpdater) {
      return patch({ phase: 'disabled', error: '自动更新仅在安装包版本中可用' })
    }
    return null
  }

  function wire() {
    if (wired || !autoUpdater) return
    wired = true
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.on('checking-for-update', () => patch({ phase: 'checking', error: '', progress: null }))
    autoUpdater.on('update-available', (info) => patch({ phase: 'available', error: '', progress: null, ...updateInfo(info) }))
    autoUpdater.on('update-not-available', (info) => patch({ phase: 'not-available', error: '', progress: null, ...updateInfo(info) }))
    autoUpdater.on('download-progress', (p) => patch({
      phase: 'downloading',
      error: '',
      progress: {
        percent: Math.max(0, Math.min(100, Number(p.percent) || 0)),
        transferred: Number(p.transferred) || 0,
        total: Number(p.total) || 0,
        bytesPerSecond: Number(p.bytesPerSecond) || 0,
      },
    }))
    autoUpdater.on('update-downloaded', (info) => patch({ phase: 'downloaded', error: '', progress: { percent: 100 }, ...updateInfo(info) }))
    autoUpdater.on('error', (e) => patch({ phase: 'error', error: (e && e.message) || String(e || '检查更新失败') }))
  }

  return {
    setSender(fn) {
      sender = fn
    },
    status() {
      return snapshot()
    },
    async check() {
      const disabled = ensureAvailable()
      if (disabled) return disabled
      if (state.phase === 'checking' || state.phase === 'downloading') return snapshot()
      wire()
      patch({ phase: 'checking', error: '', progress: null })
      try {
        await autoUpdater.checkForUpdates()
      } catch (e) {
        return patch({ phase: 'error', error: (e && e.message) || String(e || '检查更新失败') })
      }
      return snapshot()
    },
    async download() {
      const disabled = ensureAvailable()
      if (disabled) return disabled
      if (state.phase !== 'available') throw new Error('当前没有可下载的更新')
      wire()
      patch({ phase: 'downloading', error: '', progress: { percent: 0 } })
      try {
        await autoUpdater.downloadUpdate()
      } catch (e) {
        return patch({ phase: 'error', error: (e && e.message) || String(e || '下载更新失败') })
      }
      return snapshot()
    },
    install() {
      const disabled = ensureAvailable()
      if (disabled) return disabled
      if (state.phase !== 'downloaded') throw new Error('更新尚未下载完成')
      autoUpdater.quitAndInstall(false, true)
      return snapshot()
    },
    scheduleStartupCheck(delayMs = 5000) {
      if (!state.isPackaged || !autoUpdater) {
        patch({ phase: 'disabled', error: '自动更新仅在安装包版本中可用' })
        return
      }
      if (startupTimer) clearTimeout(startupTimer)
      startupTimer = setTimeout(() => {
        this.check().catch(() => {})
      }, delayMs)
      if (startupTimer && typeof startupTimer.unref === 'function') startupTimer.unref()
    },
  }
}

function normalizeReleaseNotes(notes) {
  if (Array.isArray(notes)) {
    return notes.map((item) => item && (item.note || item.version || '')).filter(Boolean).join('\n')
  }
  return typeof notes === 'string' ? notes : ''
}

module.exports = { createUpdaterController }
