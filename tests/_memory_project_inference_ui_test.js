'use strict'
/* Memory project inference UI coverage checks. */
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

console.log('\n[Memory project inference UI]')

const hookPath = path.join(root, 'src/renderer/src/hooks/useMemoryProjectInference.ts')
const hintPath = path.join(root, 'src/renderer/src/components/MemoryProjectHint.tsx')

ok('shared memory inference hook exists', fs.existsSync(hookPath))
ok('shared memory project hint component exists', fs.existsSync(hintPath))

const notesPage = read('src/renderer/src/pages/NotesPage.tsx')
const dashboardPage = read('src/renderer/src/pages/DashboardPage.tsx')
const quicknote = read('src/renderer/src/quicknote.tsx')
const pendingPool = read('src/renderer/src/components/PendingNotePool.tsx')

ok('Notes page quick add uses shared memory inference hook', notesPage.includes('useMemoryProjectInference'))
ok('Notes page renders shared memory project hint', notesPage.includes('<MemoryProjectHint'))
ok('Dashboard quick note uses memory project inference', dashboardPage.includes('useMemoryProjectInference'))
ok('Dashboard quick note renders memory project hint', dashboardPage.includes('<MemoryProjectHint'))
ok('Quicknote popup uses memory project inference', quicknote.includes('useMemoryProjectInference'))
ok('Quicknote popup renders a memory inference hint', quicknote.includes('memoryInfer') || quicknote.includes('inferResult'))
ok('Pending note summary draft uses memory project inference', pendingPool.includes('useMemoryProjectInference'))
ok('Pending note summary write can accept inferred project', pendingPool.includes('pendingSummaryProject'))

const hook = fs.existsSync(hookPath) ? read('src/renderer/src/hooks/useMemoryProjectInference.ts') : ''
ok('memory inference hook guards stale async results', hook.includes('requestIdRef') && hook.includes('latestRequestId'))
ok('memory inference hook respects enabled memory setting', hook.includes('memoryEnabled') && hook.includes('setEnabled'))

console.log(`\nResult: ${pass} passed, ${fail} failed\n`)
process.exit(fail ? 1 : 0)
