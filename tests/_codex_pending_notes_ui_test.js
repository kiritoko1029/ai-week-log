'use strict'
/* Static contract checks for Codex pending-note UI/IPC wiring. */
const fs = require('fs')
const path = require('path')

let pass = 0
let fail = 0

function read(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8')
}

function ok(name, cond, extra) {
  if (cond) {
    pass++
    console.log('  ✓ ' + name)
  } else {
    fail++
    console.log('  ✗ ' + name + (extra ? '  → ' + extra : ''))
  }
}

const config = read('src/main/config.js')
const ipc = read('src/main/ipc.js')
const preload = read('src/preload/index.js')
const types = read('src/renderer/src/types/weeklog.d.ts')
const notesPage = read('src/renderer/src/pages/NotesPage.tsx')
const settingsPage = read('src/renderer/src/pages/SettingsPage.tsx')
const mainIndex = read('src/main/index.js')

console.log('\n[1] config and lifecycle')
ok('default config includes codexHook block', /codexHook:\s*{[\s\S]*enabled:\s*false[\s\S]*port:\s*17321/.test(config))
ok('main starts codex hook server', mainIndex.includes('createCodexHookServer') && mainIndex.includes('codexHookServer.applyConfig'))
ok('main closes codex hook server on quit', mainIndex.includes('codexHookServer.close'))

console.log('\n[2] IPC and preload')
for (const name of ['list', 'delete', 'write', 'summarize', 'status', 'copyConfig', 'installHook', 'uninstallHook']) {
  ok(`preload exposes codexNotes.${name}`, new RegExp(`codexNotes:\\s*{[\\s\\S]*?\\b${name}:\\s*\\(`).test(preload))
}
for (const channel of [
  'codexNotes:list',
  'codexNotes:delete',
  'codexNotes:write',
  'codexNotes:summarize',
  'codexHook:status',
  'codexHook:copyConfig',
  'codexHook:install',
  'codexHook:uninstall',
]) {
  ok(`IPC registers ${channel}`, ipc.includes(`ipcMain.handle('${channel}'`))
}
ok('types define CodexPendingNote', types.includes('export interface CodexPendingNote'))
ok('types expose codexNotes API', /codexNotes:\s*{[\s\S]*?\bcopyConfig:[\s\S]*?\binstallHook:[\s\S]*?\buninstallHook:/.test(types))

console.log('\n[3] renderer UI')
ok('settings page has Codex hook section', settingsPage.includes('Codex Hook 小记'))
ok('settings page can enable codex hook', settingsPage.includes('draft.codexHook.enabled'))
ok('settings page can copy hook config', settingsPage.includes('copyCodexHookConfig'))
ok('settings page can install hook', settingsPage.includes('installCodexHook'))
ok('settings page can uninstall hook', settingsPage.includes('uninstallCodexHook'))
ok('notes page lists pending notes', notesPage.includes('待处理小记池') && notesPage.includes('pendingNotes'))
ok('notes page can batch write pending notes', notesPage.includes('writeSelectedPendingNotes'))
ok('notes page can summarize pending notes', notesPage.includes('summarizeSelectedPendingNotes'))

console.log(`\n结果：${pass} 通过，${fail} 失败\n`)
process.exit(fail ? 1 : 0)
