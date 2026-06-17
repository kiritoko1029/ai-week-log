'use strict'
/* Smoke test for WebDAV backup/restore UI and IPC wiring. */
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

console.log('\n[WebDAV backup IPC]')
const ipc = read('src/main/ipc.js')
ok('registers webdav:backupNow IPC', ipc.includes("ipcMain.handle('webdav:backupNow'"))
ok('registers webdav:listBackups IPC', ipc.includes("ipcMain.handle('webdav:listBackups'"))
ok('registers webdav:restoreBackup IPC', ipc.includes("ipcMain.handle('webdav:restoreBackup'"))

console.log('\n[Renderer bridge and types]')
const preload = read('src/preload/index.js')
const types = read('src/renderer/src/types/weeklog.d.ts')
ok('preload exposes backupNow', /webdav:\s*{[\s\S]*?\bbackupNow:\s*\(/.test(preload))
ok('preload exposes listBackups', /webdav:\s*{[\s\S]*?\blistBackups:\s*\(/.test(preload))
ok('preload exposes restoreBackup', /webdav:\s*{[\s\S]*?\brestoreBackup:\s*\(/.test(preload))
ok('types define WebdavBackupInfo', types.includes('WebdavBackupInfo'))
ok('types define backupNow API', /webdav:\s*{[\s\S]*?\bbackupNow:/.test(types))
ok('types define restoreBackup API', /webdav:\s*{[\s\S]*?\brestoreBackup:/.test(types))

console.log('\n[Settings UI]')
const settings = read('src/renderer/src/pages/SettingsPage.tsx')
ok('renders backup action', settings.includes('立即备份'))
ok('renders restore action', settings.includes('恢复备份'))
ok('renders backup history dialog', settings.includes('选择备份文件'))
ok('does not show old bidirectional sync button', !settings.includes('立即同步（双向）'))
ok('does not show old pull/push buttons', !settings.includes('仅拉取') && !settings.includes('仅推送'))

console.log(`\nResult: ${pass} passed, ${fail} failed\n`)
process.exit(fail ? 1 : 0)
