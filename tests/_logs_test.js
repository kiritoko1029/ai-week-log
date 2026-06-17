'use strict'
/* Logs feature smoke test: verifies diagnostics are wired end-to-end. */
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
let pass = 0
let fail = 0

function read(file) {
  return fs.readFileSync(path.join(root, file), 'utf8')
}

function ok(name, cond, extra) {
  if (cond) {
    pass++
    console.log('  PASS ' + name)
  } else {
    fail++
    console.log('  FAIL ' + name + (extra ? ' -> ' + extra : ''))
  }
}

console.log('\n[Main logger]')
ok('logger module exists', fs.existsSync(path.join(root, 'src/main/logger.js')))
if (fs.existsSync(path.join(root, 'src/main/logger.js'))) {
  const logger = require('../src/main/logger')
  ok('logger exposes createLogger', typeof logger.createLogger === 'function')
}

const ipc = read('src/main/ipc.js')
ok('registers logs:list IPC', ipc.includes("ipcMain.handle('logs:list'"))
ok('registers logs:clear IPC', ipc.includes("ipcMain.handle('logs:clear'"))
ok('registers logs:path IPC', ipc.includes("ipcMain.handle('logs:path'"))

console.log('\n[Renderer logs API and page]')
const preload = read('src/preload/index.js')
ok('preload exposes logs namespace', /logs:\s*{/.test(preload))
ok('preload exposes logs.list', /logs:\s*{[\s\S]*?\blist:\s*\(/.test(preload))
ok('preload exposes logs.clear', /logs:\s*{[\s\S]*?\bclear:\s*\(/.test(preload))
const types = read('src/renderer/src/types/weeklog.d.ts')
ok('types define AppLogEntry', types.includes('AppLogEntry'))
ok('WeeklogAPI includes logs namespace', /logs:\s*{[\s\S]*?\blist:/.test(types))
ok('LogsPage exists', fs.existsSync(path.join(root, 'src/renderer/src/pages/LogsPage.tsx')))
const nav = read('src/renderer/src/hooks/useNav.tsx')
const shell = read('src/renderer/src/components/AppShell.tsx')
const app = read('src/renderer/src/App.tsx')
ok('navigation supports logs page id', nav.includes("'logs'"))
ok('sidebar shows 日志 entry', shell.includes("id: 'logs'") && shell.includes('日志'))
ok('App renders LogsPage', app.includes('LogsPage') && app.includes("page === 'logs'"))

console.log('\n[WebDAV diagnostics]')
const webdav = read('src/main/webdav.js')
ok('WebDAV sync accepts logger option', /syncAll\(\{[\s\S]*logger/.test(webdav))
ok('WebDAV logs sync start', webdav.includes('webdav.sync.start'))
ok('WebDAV logs file decisions', webdav.includes('webdav.file.result'))
ok('WebDAV logs HTTP status', webdav.includes('webdav.http'))

console.log('\n[WebDAV user-visible failures]')
const mainIndex = read('src/main/index.js')
ok('auto backup creates background task', /tasks\.create\('webdav'/.test(mainIndex) && mainIndex.includes('WebDAV 自动备份'))
ok('auto backup marks task error on failure', /tasks\.error\(taskId/.test(mainIndex))

console.log(`\nResult: ${pass} passed, ${fail} failed\n`)
process.exit(fail ? 1 : 0)
