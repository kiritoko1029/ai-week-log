'use strict'
// @ts-check
/**
 * Electron 主进程入口：创建窗口、注册 IPC、处理生命周期。
 */
const { app, BrowserWindow } = require('electron')
const path = require('path')
const { registerIpc } = require('./ipc')

let mainWindow = null

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 980,
    minHeight: 640,
    backgroundColor: '#f5f8ff',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'))

  // 开发时按需打开 DevTools（打包构建时关闭）
  if (process.env.WEEKLOG_DEV === '1') {
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

app.whenReady().then(() => {
  registerIpc({ app, getMainWindow: () => mainWindow })
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
