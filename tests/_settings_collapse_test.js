'use strict'
/* Settings page smoke test: disabled feature details should be conditionally hidden. */
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

console.log('\n[Settings disabled feature collapse]')
const settings = read('src/renderer/src/pages/SettingsPage.tsx')

const webdavEnabledIdx = settings.indexOf('draft.webdav.enabled &&')
const webdavUrlIdx = settings.indexOf('WebDAV 服务器 URL')
const webdavBackupIdx = settings.indexOf('立即备份', webdavEnabledIdx)
const webdavRestoreIdx = settings.indexOf('恢复备份', webdavEnabledIdx)
ok('WebDAV details are gated by enabled flag', webdavEnabledIdx !== -1)
ok(
  'WebDAV URL is inside enabled-only block',
  webdavEnabledIdx !== -1 && webdavUrlIdx > webdavEnabledIdx,
  `gate=${webdavEnabledIdx}, url=${webdavUrlIdx}`
)
ok(
  'WebDAV backup buttons are inside enabled-only block',
  webdavEnabledIdx !== -1 && webdavBackupIdx > webdavEnabledIdx && webdavRestoreIdx > webdavEnabledIdx,
  `gate=${webdavEnabledIdx}, backup=${webdavBackupIdx}, restore=${webdavRestoreIdx}`
)

const memoryEnabledIdx = settings.indexOf('draft.memory.enabled &&')
const memoryStatusIdx = settings.indexOf('运行状态')
const memoryEmbeddingIdx = settings.indexOf('Embedding 来源')
ok('Memory details are gated by enabled flag', memoryEnabledIdx !== -1)
ok(
  'Memory runtime status is inside enabled-only block',
  memoryEnabledIdx !== -1 && memoryStatusIdx > memoryEnabledIdx,
  `gate=${memoryEnabledIdx}, status=${memoryStatusIdx}`
)
ok(
  'Memory embedding settings are inside enabled-only block',
  memoryEnabledIdx !== -1 && memoryEmbeddingIdx > memoryEnabledIdx,
  `gate=${memoryEnabledIdx}, embedding=${memoryEmbeddingIdx}`
)
ok('Hidden details no longer rely on disabled inputs', !settings.includes('disabled={!draft.webdav.enabled}') && !settings.includes('disabled={!draft.memory.enabled}'))

console.log('\n[Settings save action]')
const saveTextIdx = settings.indexOf('保存设置')
const floatingSaveIdx = settings.indexOf('fixed')
ok('Save action is rendered as a floating control', floatingSaveIdx !== -1 && saveTextIdx > floatingSaveIdx)
ok('Floating save action is anchored near the bottom edge', settings.includes('bottom-'))
ok('Settings page reserves bottom space for the floating save action', /className="[^"]*\bpb-/.test(settings))
const floatingSaveClass = /<div className="([^"]*\bfixed\b[^"]*)">\s*<Button onClick=\{handleSave\}/.exec(settings)?.[1] || ''
ok('Floating save wrapper has no visual border', floatingSaveClass !== '' && !/\bborder\b/.test(floatingSaveClass), floatingSaveClass)

console.log(`\nResult: ${pass} passed, ${fail} failed\n`)
process.exit(fail ? 1 : 0)
