'use strict'
/* Auto-update smoke test: verifies updater wiring without starting the app.
 *
 * 外壳已从 Electron 迁移到 Tauri 2。自动更新在 Tauri 后端 src-tauri/src/updates.rs
 * 中实现（手动 GitHub 流程：查最新版 → 下载安装包 → 打开由 OS 安装；不依赖
 * electron-updater / latest.yml / minisign）。本测试覆盖 Tauri 后端 + 渲染层桥接/UI。
 * 渲染层断言（types / SettingsPage / Statusbar）与 Electron 版相同——渲染层未改。 */
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

console.log('\n[Tauri backend updater]')
ok('updater module exists', fs.existsSync(path.join(root, 'src-tauri/src/updates.rs')))
if (fs.existsSync(path.join(root, 'src-tauri/src/updates.rs'))) {
  const updater = read('src-tauri/src/updates.rs')
  ok('queries GitHub releases API', updater.includes('api.github.com/repos'))
  ok('uses reqwest for HTTP (not electron-updater at runtime)', updater.includes('reqwest::Client'))
  ok('picks .exe on windows', /#\[cfg\(target_os = "windows"\)\][\s\S]*?\.exe/.test(updater))
  ok('picks .dmg on macos', /#\[cfg\(target_os = "macos"\)\][\s\S]*?\.dmg/.test(updater))
  ok('tracks startup disabled state (dev)', updater.includes('is_packaged') && updater.includes('disabled'))
  ok('emits updates:update status event', updater.includes('updates:update'))
  ok('exposes status/check/download/install', ['pub fn status', 'pub async fn check', 'pub async fn download', 'pub fn install'].every((s) => updater.includes(s)))
  ok('compares semver versions', updater.includes('compare_versions'))
}

console.log('\n[Tauri command registration]')
const lib = read('src-tauri/src/lib.rs')
ok('registers updates_status command', lib.includes('updates_status'))
ok('registers updates_check command', lib.includes('updates_check'))
ok('registers updates_download command', lib.includes('updates_download'))
ok('registers updates_install command', lib.includes('updates_install'))
ok('spawns startup update check in release', lib.includes('updates::check') && lib.includes('not(debug_assertions)'))

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
ok('SettingsPage does not repeat download progress text under progress bar', !settings.includes('下载进度 {Math.round(updateStatus.progress.percent || 0)}%'))
const statusbar = read('src/renderer/src/components/Statusbar.tsx')
ok('Statusbar reads update status on mount', statusbar.includes('updates.status()'))
ok('Statusbar subscribes to update events', statusbar.includes('updates.onUpdate'))
ok('Statusbar renders update reminder near version', statusbar.includes('statusbarUpdateText') && statusbar.includes('发现 v'))
ok('Statusbar update reminder opens SettingsPage', statusbar.includes("navigate('settings')"))

console.log('\n[Release workflow]')
const pkg = JSON.parse(read('package.json'))
ok('exposes tauri:build script', !!pkg.scripts['tauri:build'])
const releaseWorkflow = read('.github/workflows/release.yml')
ok('release workflow runs tauri build', releaseWorkflow.includes('tauri build'))
ok('release workflow fetches tags for release notes', releaseWorkflow.includes('fetch-depth: 0') && releaseWorkflow.includes('fetch-tags: true'))
ok('release workflow writes commit-based release notes', releaseWorkflow.includes('Generate release notes') && releaseWorkflow.includes('RELEASE_NOTES.md'))
ok('release action uses generated release notes body', releaseWorkflow.includes('body_path: RELEASE_NOTES.md'))
ok('release workflow uploads bundle artifacts', releaseWorkflow.includes('src-tauri/target/release/bundle/'))

console.log(`\nResult: ${pass} passed, ${fail} failed\n`)
process.exit(fail ? 1 : 0)
