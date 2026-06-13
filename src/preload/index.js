'use strict'
// @ts-check
/**
 * preload：通过 contextBridge 向渲染进程暴露安全的 weeklog API。
 * 渲染进程不直接访问 Node / IPC 原语，只通过 window.weeklog 调用。
 */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('weeklog', {
  config: {
    get: () => ipcRenderer.invoke('config:get'),
    save: (cfg) => ipcRenderer.invoke('config:save', cfg),
    reset: () => ipcRenderer.invoke('config:reset'),
    notesDir: () => ipcRenderer.invoke('config:notesDir'),
  },
  env: {
    gitOk: () => ipcRenderer.invoke('env:gitOk'),
    apiKeyStatus: () => ipcRenderer.invoke('env:apiKeyStatus'),
  },
  secrets: {
    available: () => ipcRenderer.invoke('secrets:available'),
    get: (provider) => ipcRenderer.invoke('secrets:get', { provider }),
    set: (provider, key) => ipcRenderer.invoke('secrets:set', { provider, key }),
    clear: (provider) => ipcRenderer.invoke('secrets:clear', { provider }),
  },
  repo: {
    validate: (p) => ipcRenderer.invoke('repo:validate', p),
    add: (r) => ipcRenderer.invoke('repo:add', r),
    update: (id, patch) => ipcRenderer.invoke('repo:update', { id, patch }),
    remove: (id) => ipcRenderer.invoke('repo:remove', id),
  },
  notes: {
    add: (n) => ipcRenderer.invoke('notes:add', n),
    getText: (date) => ipcRenderer.invoke('notes:getText', date),
    saveText: (n) => ipcRenderer.invoke('notes:saveText', n),
    list: (q) => ipcRenderer.invoke('notes:list', q),
  },
  collect: (q) => ipcRenderer.invoke('collect', q),
  generate: (q) => ipcRenderer.invoke('generate', q),
  onProgress: (cb) => {
    const handler = (_e, msg) => cb(msg)
    ipcRenderer.on('generate:progress', handler)
    return () => ipcRenderer.removeListener('generate:progress', handler)
  },
  history: {
    list: () => ipcRenderer.invoke('history:list'),
    save: (e) => ipcRenderer.invoke('history:save', e),
  },
  dialog: {
    pickFolder: () => ipcRenderer.invoke('dialog:pickFolder'),
    pickRepo: () => ipcRenderer.invoke('dialog:pickRepo'),
  },
  ui: {
    /** 同步原生外观（标题栏/窗口底色），返回当前是否深色 */
    setTheme: (theme) => ipcRenderer.invoke('ui:setTheme', theme),
  },
  shortcut: {
    /** 读取已保存配置并重新注册全局快捷键，返回 { ok, accel } */
    apply: () => ipcRenderer.invoke('shortcut:apply'),
    /** 录制快捷键时临时停用，避免按下当前组合键时触发弹窗 */
    suspend: () => ipcRenderer.invoke('shortcut:suspend'),
    resume: () => ipcRenderer.invoke('shortcut:resume'),
  },
  quicknote: {
    hide: () => ipcRenderer.send('quicknote:hide'),
    onShow: (cb) => {
      const handler = () => cb()
      ipcRenderer.on('quicknote:show', handler)
      return () => ipcRenderer.removeListener('quicknote:show', handler)
    },
  },
})
