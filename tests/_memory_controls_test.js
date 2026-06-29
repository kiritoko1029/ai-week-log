'use strict'
/* AI memory control smoke test: memory and model downloads are opt-in. */
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

console.log('\n[Memory defaults]')
const mainConfig = read('src/main/config.js')
const tauriConfig = read('src-tauri/src/config.rs')
ok('Electron memory default is disabled', /memory:\s*{[\s\S]*?enabled:\s*false/.test(mainConfig))
ok('Electron auto memory generation default is disabled', /memory:\s*{[\s\S]*?autoGenerate:\s*false/.test(mainConfig))
ok('Tauri memory default is disabled', /"memory":\s*{[\s\S]*?"enabled":\s*false/.test(tauriConfig))
ok('Tauri auto memory generation default is disabled', /"memory":\s*{[\s\S]*?"autoGenerate":\s*false/.test(tauriConfig))

console.log('\n[Memory backend commands]')
const ipc = read('src/main/ipc.js')
const preload = read('src/preload/index.js')
const tauriLib = read('src-tauri/src/lib.rs')
const tauriApi = read('src/renderer/src/lib/api.tauri.ts')
const types = read('src/renderer/src/types/weeklog.d.ts')
ok('Electron registers manual model download IPC', ipc.includes("memory:downloadModel"))
ok('Electron registers model folder open IPC', ipc.includes("memory:openModelFolder"))
ok('Electron registers model cleanup IPC', ipc.includes("memory:clearModel"))
ok('Preload exposes manual model controls', ['downloadModel', 'openModelFolder', 'clearModel'].every((s) => preload.includes(s)))
ok('Tauri registers manual model download command', tauriLib.includes('memory_download_model'))
ok('Tauri registers model folder open command', tauriLib.includes('memory_open_model_folder'))
ok('Tauri registers model cleanup command', tauriLib.includes('memory_clear_model'))
ok('Tauri API exposes manual model controls', ['memory_download_model', 'memory_open_model_folder', 'memory_clear_model'].every((s) => tauriApi.includes(s)))
ok('Renderer types include manual model controls', ['downloadModel', 'openModelFolder', 'clearModel'].every((s) => types.includes(s)))

console.log('\n[Settings UI]')
const settings = read('src/renderer/src/pages/SettingsPage.tsx')
ok('Settings page has manual download button', settings.includes('下载模型'))
ok('Settings page has open model folder button', settings.includes('打开模型文件夹'))
ok('Settings page has clear model button', settings.includes('清理模型'))
ok('Settings page warns model is manually downloaded', settings.includes('模型不会自动下载'))

console.log(`\nResult: ${pass} passed, ${fail} failed\n`)
process.exit(fail ? 1 : 0)
