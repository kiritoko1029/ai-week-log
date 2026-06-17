'use strict'
/* Renderer layout smoke test: verifies shared chrome placement without starting Electron. */
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

console.log('\n[Renderer chrome layout]')
const appShell = read('src/renderer/src/components/AppShell.tsx')
const statusbar = read('src/renderer/src/components/Statusbar.tsx')

ok('sidebar does not render app version', !appShell.includes('__APP_VERSION__'))
ok('sidebar does not render GitHub repository link', !appShell.includes('github.com/kiritoko1029/ai-week-log'))
ok('statusbar renders app version', statusbar.includes('WeekLog v{__APP_VERSION__}'))
ok('statusbar opens GitHub repository', statusbar.includes('github.com/kiritoko1029/ai-week-log'))
ok(
  'GitHub link is placed after statusbar version',
  statusbar.indexOf('WeekLog v{__APP_VERSION__}') !== -1 &&
    statusbar.indexOf('github.com/kiritoko1029/ai-week-log') > statusbar.indexOf('WeekLog v{__APP_VERSION__}')
)

console.log(`\nResult: ${pass} passed, ${fail} failed\n`)
process.exit(fail ? 1 : 0)
