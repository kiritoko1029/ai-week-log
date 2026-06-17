'use strict'
/* Smoke test for local backup UI and IPC wiring. */
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

console.log('\n[Local backup IPC]')
const ipc = read('src/main/ipc.js')
ok('registers localBackup:create IPC', ipc.includes("ipcMain.handle('localBackup:create'"))
ok('registers dialog:pickBackupFolder IPC', ipc.includes("ipcMain.handle('dialog:pickBackupFolder'"))
ok('uses Electron downloads directory', ipc.includes("app.getPath('downloads')"))
ok('backup folder dialog defaults to Downloads', /defaultPath:\s*app\.getPath\('downloads'\)/.test(ipc))

console.log('\n[Renderer bridge and types]')
const preload = read('src/preload/index.js')
const types = read('src/renderer/src/types/weeklog.d.ts')
ok('preload exposes dialog.pickBackupFolder', /dialog:\s*{[\s\S]*?\bpickBackupFolder:\s*\(/.test(preload))
ok('preload exposes localBackup namespace', /localBackup:\s*{/.test(preload))
ok('preload exposes localBackup.create', /localBackup:\s*{[\s\S]*?\bcreate:\s*\(/.test(preload))
ok('types define LocalBackupResult', types.includes('LocalBackupResult'))
ok('types define dialog.pickBackupFolder', /dialog:\s*{[\s\S]*?\bpickBackupFolder:/.test(types))
ok('types define localBackup API', /localBackup:\s*{[\s\S]*?\bcreate:/.test(types))

console.log('\n[Settings UI]')
const settings = read('src/renderer/src/pages/SettingsPage.tsx')
const localIdx = settings.indexOf('本地备份')
const webdavIdx = settings.indexOf('云同步（WebDAV）')
ok('renders separate local backup section', localIdx !== -1)
ok('local backup section is separate from WebDAV section', localIdx !== -1 && webdavIdx !== -1 && localIdx < webdavIdx)
ok('renders download backup button', settings.includes('下载备份'))
ok('download backup asks for folder first', settings.includes('api.dialog.pickBackupFolder()'))
ok('does not place download backup inside WebDAV restore dialog', settings.indexOf('下载备份') < settings.indexOf('选择备份文件'))

console.log(`\nResult: ${pass} passed, ${fail} failed\n`)
process.exit(fail ? 1 : 0)
