'use strict'
// @ts-check
/**
 * Electron 主进程入口：窗口、托盘、全局快捷键、快速记笔记弹窗、主题与生命周期。
 */
const { app, BrowserWindow, Tray, Menu, nativeImage, nativeTheme, globalShortcut, ipcMain, Notification } = require('electron')
const path = require('path')
const { registerIpc } = require('./ipc')
const { trayIconBuffer } = require('./icon')
const { loadConfig } = require('./config')

const SHORTCUT_DEFAULT = 'CommandOrControl+Shift+L'
const PRELOAD = path.join(__dirname, '..', 'preload', 'index.js')
const RENDERER_DIR = path.join(__dirname, '..', 'renderer')
// 开发模式直连 Vite dev server（HMR）；生产模式加载打包产物 dist/
const DEV_SERVER_URL = process.env.WEEKLOG_DEV ? 'http://localhost:5173' : ''

let mainWindow = null
let quickNoteWin = null
let tray = null
let isQuitting = false
let trayHintShown = false
let currentShortcut = SHORTCUT_DEFAULT

/** 当前主题是否解析为深色（依据 nativeTheme） */
function isDark() { return nativeTheme.shouldUseDarkColors }
function windowBg() { return isDark() ? '#0b1020' : '#eef2fb' }

// ── 主窗口 ──
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 980,
    minHeight: 640,
    backgroundColor: windowBg(),
    autoHideMenuBar: true,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  // 生产用 loadFile（正确处理 Windows 路径）；开发直连 Vite dev server
  if (DEV_SERVER_URL) {
    mainWindow.loadURL(DEV_SERVER_URL + '/index.html')
  } else {
    mainWindow.loadFile(path.join(RENDERER_DIR, 'dist', 'index.html'))
  }

  // 开发时打开 DevTools；并捕获渲染层错误到主进程 stdout，便于排查
  if (process.env.WEEKLOG_DEV === '1') {
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  }
  mainWindow.webContents.on('console-message', (_e, _level, message, _line, _sourceId) => {
    console.log('[renderer console]', message)
  })
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.log('[did-fail-load]', code, desc, url)
  })

  // 关闭窗口时最小化到托盘，而非退出（真正退出走托盘菜单）
  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault()
      mainWindow.hide()
      if (!trayHintShown) {
        trayHintShown = true
        notifyTrayHint()
      }
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

// ── 快速记笔记弹窗 ──
function createQuickNoteWindow() {
  quickNoteWin = new BrowserWindow({
    width: 480,
    height: 190,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: windowBg(),
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  if (DEV_SERVER_URL) {
    quickNoteWin.loadURL(DEV_SERVER_URL + '/quicknote.html')
  } else {
    quickNoteWin.loadFile(path.join(RENDERER_DIR, 'dist', 'quicknote.html'))
  }

  // 显示时通知渲染进程聚焦输入
  quickNoteWin.on('show', () => {
    try {
      quickNoteWin.webContents.send('quicknote:show')
    } catch {}
  })

  // 关闭即隐藏，保留窗口供复用
  quickNoteWin.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault()
      quickNoteWin.hide()
    }
  })

  quickNoteWin.on('closed', () => {
    quickNoteWin = null
  })
}

function showQuickNote() {
  if (!quickNoteWin) createQuickNoteWindow()
  if (quickNoteWin.isMinimized()) quickNoteWin.restore()
  quickNoteWin.center()
  quickNoteWin.show()
  quickNoteWin.focus()
}

function hideQuickNote() {
  if (quickNoteWin) quickNoteWin.hide()
}

// ── 全局快捷键（快速记笔记），可在设置中编辑 ──
function applyShortcut(accel) {
  const target = (accel && accel.trim()) || SHORTCUT_DEFAULT
  globalShortcut.unregister(currentShortcut)
  let ok = globalShortcut.register(target, showQuickNote)
  if (ok) {
    currentShortcut = target
  } else {
    // 注册失败（冲突 / 非法）：回退默认
    currentShortcut = SHORTCUT_DEFAULT
    globalShortcut.register(SHORTCUT_DEFAULT, showQuickNote)
  }
  rebuildTrayMenu()
  return { ok, accel: currentShortcut }
}

// ── 主题（原生：标题栏 / 窗口底色 / 原生控件）──
function applyNativeTheme(theme) {
  nativeTheme.themeSource = theme === 'dark' ? 'dark' : theme === 'light' ? 'light' : 'system'
  const bg = windowBg()
  for (const w of BrowserWindow.getAllWindows()) {
    try { w.setBackgroundColor(bg) } catch {}
  }
  return isDark()
}

// ── 托盘 ──
function createTray() {
  const image = nativeImage.createFromBuffer(trayIconBuffer(32))
  tray = new Tray(image)
  tray.setToolTip('WeekLog — Git 周报/日报生成工具')
  rebuildTrayMenu()
  // 单击托盘图标：切换主窗口显隐
  tray.on('click', () => toggleMainWindow())
}

function rebuildTrayMenu() {
  if (!tray) return
  const menu = Menu.buildFromTemplate([
    { label: '显示主窗口', click: showMainWindow },
    { label: '快速记笔记', accelerator: currentShortcut, click: showQuickNote },
    { type: 'separator' },
    { label: '退出', click: quitApp },
  ])
  tray.setContextMenu(menu)
}

function showMainWindow() {
  if (!mainWindow) createWindow()
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function toggleMainWindow() {
  if (!mainWindow) { createWindow(); return }
  if (mainWindow.isVisible() && mainWindow.isFocused()) mainWindow.hide()
  else showMainWindow()
}

function notifyTrayHint() {
  if (!Notification.isSupported()) return
  try {
    new Notification({
      title: 'WeekLog 已最小化到托盘',
      body: '窗口后台运行，点击托盘图标可恢复；' + friendlyShortcut(currentShortcut) + ' 快速记笔记。',
    }).show()
  } catch {}
}

/** 把 Electron accelerator 转成人类可读标签 */
function friendlyShortcut(accel) {
  const isMac = process.platform === 'darwin'
  return (accel || '').split('+').map((p) => {
    if (p === 'CommandOrControl' || p === 'CmdOrCtrl') return isMac ? '⌘' : 'Ctrl'
    if (p === 'Control' || p === 'Ctrl') return 'Ctrl'
    if (p === 'Command' || p === 'Cmd' || p === 'Meta') return isMac ? '⌘' : 'Win'
    if (p === 'Alt' || p === 'Option') return isMac ? '⌥' : 'Alt'
    if (p === 'Shift') return isMac ? '⇧' : 'Shift'
    return p.length === 1 ? p.toUpperCase() : p
  }).join(isMac ? '' : ' + ')
}

function quitApp() {
  isQuitting = true
  globalShortcut.unregisterAll()
  if (tray) { tray.destroy(); tray = null }
  app.quit()
}

app.whenReady().then(() => {
  // Windows 下设置 AppUserModelId，使通知以正确应用名显示
  if (process.platform === 'win32') {
    try { app.setAppUserModelId('com.weeklog.desktop') } catch {}
  }

  const cfg = loadConfig(app.getPath('userData'))

  registerIpc({ app, getMainWindow: () => mainWindow })

  // 先应用主题，使窗口创建时底色正确（避免闪烁）
  applyNativeTheme(cfg.ui && cfg.ui.theme)

  createWindow()
  createTray()
  applyShortcut(cfg.ui && cfg.ui.quickNoteShortcut)

  // ── IPC ──
  ipcMain.on('quicknote:hide', () => hideQuickNote())

  // 重新读取配置并注册全局快捷键（设置保存后调用）
  ipcMain.handle('shortcut:apply', () => {
    const c = loadConfig(app.getPath('userData'))
    return applyShortcut(c.ui && c.ui.quickNoteShortcut)
  })
  // 录制快捷键时临时停用 / 恢复，避免按下当前组合键触发弹窗
  ipcMain.handle('shortcut:suspend', () => { globalShortcut.unregister(currentShortcut); return true })
  ipcMain.handle('shortcut:resume', () => {
    globalShortcut.unregister(currentShortcut)
    globalShortcut.register(currentShortcut, showQuickNote)
    return true
  })

  // 切换原生主题（设置中点选主题时调用）
  ipcMain.handle('ui:setTheme', (_e, theme) => applyNativeTheme(theme))

  // 系统主题变化（auto 模式）时刷新所有窗口底色
  nativeTheme.on('changed', () => {
    const bg = windowBg()
    for (const w of BrowserWindow.getAllWindows()) {
      try { w.setBackgroundColor(bg) } catch {}
    }
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => {
  isQuitting = true
})

// 退出时务必注销全局快捷键
app.on('will-quit', () => {
  globalShortcut.unregisterAll()
})

// 托盘模式下：所有窗口关闭也不退出，保持后台运行
app.on('window-all-closed', () => {
  // 不主动退出；退出统一走托盘菜单 / 系统关机
})
