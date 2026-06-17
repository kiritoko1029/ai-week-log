'use strict'
/* Auto-update smoke test: verifies updater wiring without starting Electron. */
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

console.log('\n[Package metadata]')
const pkg = JSON.parse(read('package.json'))
ok('depends on electron-updater', !!(pkg.dependencies && pkg.dependencies['electron-updater']))
const publish = Array.isArray(pkg.build && pkg.build.publish) ? pkg.build.publish : []
ok(
  'publishes updates to GitHub Releases',
  publish.some((p) => p.provider === 'github' && p.owner === 'kiritoko1029' && p.repo === 'ai-week-log'),
  JSON.stringify(publish)
)

console.log('\n[Main process updater]')
ok('updater module exists', fs.existsSync(path.join(root, 'src/main/updater.js')))
if (fs.existsSync(path.join(root, 'src/main/updater.js'))) {
  const updater = read('src/main/updater.js')
  ok('exports createUpdaterController', updater.includes('createUpdaterController'))
  ok('uses electron-updater autoUpdater', updater.includes('autoUpdater'))
  ok('tracks startup disabled state', updater.includes('disabled') && updater.includes('isPackaged'))
  ok('falls back to bundled GitHub publish source', updater.includes('DEFAULT_GITHUB_PUBLISH'))
  ok('does not surface package build.publish as user-facing updater error', !updater.includes('未配置 GitHub 发布源（build.publish）'))
}
const ipc = read('src/main/ipc.js')
ok('registers updates:status IPC', ipc.includes("ipcMain.handle('updates:status'"))
ok('registers updates:check IPC', ipc.includes("ipcMain.handle('updates:check'"))
ok('registers updates:download IPC', ipc.includes("ipcMain.handle('updates:download'"))
ok('registers updates:install IPC', ipc.includes("ipcMain.handle('updates:install'"))
ok('pushes updates:update event', ipc.includes("'updates:update'"))
const main = read('src/main/index.js')
ok('initializes updater controller', main.includes('createUpdaterController'))
ok('schedules startup update check', main.includes('scheduleStartupCheck'))

console.log('\n[Renderer bridge]')
const preload = read('src/preload/index.js')
ok('preload exposes updates namespace', /updates:\s*{/.test(preload))
ok('preload exposes updates.status', /updates:\s*{[\s\S]*?\bstatus:\s*\(/.test(preload))
ok('preload exposes updates.check', /updates:\s*{[\s\S]*?\bcheck:\s*\(/.test(preload))
ok('preload exposes updates.download', /updates:\s*{[\s\S]*?\bdownload:\s*\(/.test(preload))
ok('preload exposes updates.install', /updates:\s*{[\s\S]*?\binstall:\s*\(/.test(preload))
ok('preload exposes updates.onUpdate', /updates:\s*{[\s\S]*?\bonUpdate:\s*\(/.test(preload))

console.log('\n[Renderer types and UI]')
const types = read('src/renderer/src/types/weeklog.d.ts')
ok('defines UpdatePhase', types.includes('UpdatePhase'))
ok('defines UpdateStatus', types.includes('UpdateStatus'))
ok('WeeklogAPI includes updates namespace', /updates:\s*{/.test(types))
const settings = read('src/renderer/src/pages/SettingsPage.tsx')
ok('SettingsPage has update card title', settings.includes('应用更新'))
ok('SettingsPage has check update button', settings.includes('检查更新'))
ok('SettingsPage has download update button', settings.includes('下载更新'))
ok('SettingsPage has install update button', settings.includes('重启安装'))
ok('SettingsPage subscribes to update events', settings.includes('updates.onUpdate'))
const statusbar = read('src/renderer/src/components/Statusbar.tsx')
ok('Statusbar reads update status on mount', statusbar.includes('updates.status()'))
ok('Statusbar subscribes to update events', statusbar.includes('updates.onUpdate'))
ok('Statusbar renders update reminder near version', statusbar.includes('statusbarUpdateText') && statusbar.includes('发现 v'))
ok('Statusbar update reminder opens SettingsPage', statusbar.includes("navigate('settings')"))

console.log('\n[Release packaging]')
ok('dist:win disables electron-builder GitHub publishing', pkg.scripts['dist:win'].includes('--publish never'))
ok('dist:mac disables electron-builder GitHub publishing', pkg.scripts['dist:mac'].includes('--publish never'))
const releaseWorkflow = read('.github/workflows/release.yml')
ok('release workflow does not pass GH_TOKEN to electron-builder packaging', !releaseWorkflow.includes('GH_TOKEN:'))

console.log(`\nResult: ${pass} passed, ${fail} failed\n`)
process.exit(fail ? 1 : 0)
