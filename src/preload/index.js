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
    status: () => ipcRenderer.invoke('memory:status'),
    rebuild: () => ipcRenderer.invoke('memory:rebuild'),
    remove: (id) => ipcRenderer.invoke('memory:delete', { id }),
    inferProject: (noteText) => ipcRenderer.invoke('memory:inferProject', { noteText }),
  },
  chat: {
    sessions: () => ipcRenderer.invoke('chat:sessions'),
    getSession: (id) => ipcRenderer.invoke('chat:session:get', { id }),
    createSession: (title) => ipcRenderer.invoke('chat:session:create', { title }),
    renameSession: (id, title) => ipcRenderer.invoke('chat:session:rename', { id, title }),
    deleteSession: (id) => ipcRenderer.invoke('chat:session:delete', { id }),
    /** 发起流式问答，立即返回 { msgId }，正文经 onStream 推送 */
    send: (sessionId, content) => ipcRenderer.invoke('chat:send', { sessionId, content }),
    /** 快捷生成日报/周报，立即返回 { msgId }，进度与结果经 onStream 推送 */
    generate: (sessionId, reportType, when) =>
      ipcRenderer.invoke('chat:generate', { sessionId, reportType, when }),
    cancel: (msgId) => ipcRenderer.invoke('chat:cancel', { msgId }),
    onStream: (cb) => {
      const handler = (_e, payload) => cb(payload)
      ipcRenderer.on('chat:stream', handler)
      return () => ipcRenderer.removeListener('chat:stream', handler)
    },
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
  updates: {
    status: () => ipcRenderer.invoke('updates:status'),
    check: () => ipcRenderer.invoke('updates:check'),
    download: () => ipcRenderer.invoke('updates:download'),
    install: () => ipcRenderer.invoke('updates:install'),
    onUpdate: (cb) => {
      const handler = (_e, payload) => cb(payload)
      ipcRenderer.on('updates:update', handler)
      return () => ipcRenderer.removeListener('updates:update', handler)
    },
  },
  ui: {
    /** 同步原生外观（标题栏/窗口底色），返回当前是否深色 */
    setTheme: (theme) => ipcRenderer.invoke('ui:setTheme', theme),
  },
  shell: {
    /** 在系统默认浏览器打开外链（仅 http/https） */
    openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
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
