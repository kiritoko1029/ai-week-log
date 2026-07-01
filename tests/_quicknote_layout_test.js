'use strict'
/* Quick note popup layout regression checks. */
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

console.log('\n[Quick note popup layout]')

const tauriConfig = JSON.parse(read('src-tauri/tauri.conf.json'))
const quicknoteWindow = tauriConfig.app.windows.find((win) => win.label === 'quicknote')
ok('Tauri quicknote window exists', !!quicknoteWindow)
ok('Tauri quicknote window defaults to the compact visual panel height', quicknoteWindow && quicknoteWindow.height <= 180, `height=${quicknoteWindow && quicknoteWindow.height}`)
ok('Tauri quicknote popup keeps enough width for controls', quicknoteWindow && quicknoteWindow.width >= 540, `width=${quicknoteWindow && quicknoteWindow.width}`)
ok('Tauri quicknote window is transparent around the compact panel', quicknoteWindow && quicknoteWindow.transparent === true)

const electronMain = read('src/main/index.js')
const quicknoteBlock = electronMain.slice(
  electronMain.indexOf('function createQuickNoteWindow()'),
  electronMain.indexOf('function showQuickNote()')
)
ok('Electron quicknote window defaults to the compact visual panel height', quicknoteBlock.includes('height: QUICK_NOTE_PANEL_HEIGHT') && electronMain.includes('QUICK_NOTE_PANEL_HEIGHT = 176'))
ok('Electron quicknote window uses the compact panel height constant', quicknoteBlock.includes('height: QUICK_NOTE_PANEL_HEIGHT'))
ok('Electron quicknote popup keeps enough width for controls', quicknoteBlock.includes('width: QUICK_NOTE_WIDTH') || /width:\s*5[4-9]\d/.test(quicknoteBlock))
ok('Electron quicknote window is not expanded for project dropdowns', !electronMain.includes('quicknote:set-expanded') && !electronMain.includes('QUICK_NOTE_EXPANDED_HEIGHT'))

const tauriLib = read('src-tauri/src/lib.rs')
ok('Tauri quicknote is not expanded for project dropdowns', !tauriLib.includes('quicknote_set_expanded') && !tauriLib.includes('QUICK_NOTE_EXPANDED_HEIGHT'))

const quicknoteRenderer = read('src/renderer/src/quicknote.tsx')
const quicknoteHtml = read('src/renderer/quicknote.html')
const globals = read('src/renderer/src/styles/globals.css')
ok('Quicknote visual panel remains compact', quicknoteRenderer.includes('h-[176px]'))
ok('Quicknote project selector uses a native select popup', quicknoteRenderer.includes('<select') && quicknoteRenderer.includes('<option'))
ok('Quicknote renderer does not ask native shell to expand for the selector', !quicknoteRenderer.includes('api.quicknote.setExpanded') && !quicknoteRenderer.includes('projectMenuOpen'))
ok('Quicknote project selector does not use Radix Select in the popup', !quicknoteRenderer.includes("from '@/components/ui/select'") && !quicknoteRenderer.includes('<Select'))
ok('Quicknote has no transparent overflow shell that can reveal a white background', !quicknoteRenderer.includes('quicknote-transparent') && !quicknoteHtml.includes('quicknote-transparent') && !globals.includes('quicknote-transparent'))

console.log(`\nResult: ${pass} passed, ${fail} failed\n`)
process.exit(fail ? 1 : 0)
