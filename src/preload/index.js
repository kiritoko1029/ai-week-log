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
    status: (provider) => ipcRenderer.invoke('secrets:status', { provider }),
    set: (provider, key) => ipcRenderer.invoke('secrets:set', { provider, key }),
    clear: (provider) => ipcRenderer.invoke('secrets:clear', { provider }),
  },
  ai: {
    /** 用当前编辑中的 cfg + apiKey 做一次最小连接测试，返回 { ok, message, model?, latencyMs? } */
    test: (cfg, apiKey) => ipcRenderer.invoke('ai:test', { cfg, apiKey }),
  },
  repo: {
    validate: (p) => ipcRenderer.invoke('repo:validate', p),
    add: (r) => ipcRenderer.invoke('repo:add', r),
    update: (id, patch) => ipcRenderer.invoke('repo:update', { id, patch }),
    remove: (id) => ipcRenderer.invoke('repo:remove', id),
    scan: (rootDir, maxDepth) => ipcRenderer.invoke('repo:scan', { rootDir, maxDepth }),
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
    update: (id, text) => ipcRenderer.invoke('history:update', { id, text }),
  },
  dialog: {
    pickFolder: () => ipcRenderer.invoke('dialog:pickFolder'),
    pickRepo: () => ipcRenderer.invoke('dialog:pickRepo'),
  },
  webdav: {
    test: (url, username, password) => ipcRenderer.invoke('webdav:test', { url, username, password }),
    syncNow: (direction) => ipcRenderer.invoke('webdav:syncNow', { direction }),
    status: () => ipcRenderer.invoke('webdav:status'),
    savePassword: (password) => ipcRenderer.invoke('webdav:savePassword', { password }),
    passwordStatus: () => ipcRenderer.invoke('webdav:passwordStatus'),
    clearPassword: () => ipcRenderer.invoke('webdav:clearPassword'),
  },
  memory: {
    list: () => ipcRenderer.invoke('memory:list'),
    search: (query, topK) => ipcRenderer.invoke('memory:search', { query, topK }),
    queueStatus: () => ipcRenderer.invoke('memory:queueStatus'),
    rebuild: () => ipcRenderer.invoke('memory:rebuild'),
    remove: (id) => ipcRenderer.invoke('memory:delete', { id }),
    inferProject: (noteText) => ipcRenderer.invoke('memory:inferProject', { noteText }),
  },
  tasks: {
    list: () => ipcRenderer.invoke('tasks:list'),
    hasRunning: () => ipcRenderer.invoke('tasks:hasRunning'),
    remove: (id) => ipcRenderer.invoke('tasks:remove', { id }),
    clearFinished: () => ipcRenderer.invoke('tasks:clearFinished'),
    onUpdate: (cb) => {
      const handler = (_e, payload) => cb(payload)
      ipcRenderer.on('task:update', handler)
      return () => ipcRenderer.removeListener('task:update', handler)
    },
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
