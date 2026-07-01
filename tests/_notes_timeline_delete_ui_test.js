'use strict'
/* Notes timeline ordering and delete UI checks. */
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

console.log('\n[Notes timeline delete UI]')

const page = read('src/renderer/src/pages/NotesPage.tsx')
const card = read('src/renderer/src/components/NoteCard.tsx')
const typeFile = read('src/renderer/src/types/weeklog.d.ts')

ok('Notes page opens on timeline tab first', page.includes('<Tabs defaultValue="timeline">'))
ok(
  'Timeline tab trigger is before quick add trigger',
  page.indexOf('value="timeline">笔记时间线') > -1 &&
    page.indexOf('value="timeline">笔记时间线') < page.indexOf('value="quick">快速添加'),
)
ok('Notes page defines single note delete handler', page.includes('deleteTimelineNote'))
ok('Notes page defines batch delete handler', page.includes('deleteSelectedTimelineNotes'))
ok('Single delete uses replaceSummarized with empty content', page.includes('removeItems: [note]') && page.includes("content: ''"))
ok('Batch delete uses selected timeline notes as removeItems', page.includes('removeItems: selectedTimelineNotes'))
ok('Timeline toolbar has batch delete button', page.includes('删除选中'))
ok('NoteCard accepts delete callback', card.includes('onDelete?: () => void'))
ok('NoteCard renders a delete action button', card.includes('删除笔记') && card.includes('Trash2'))
ok('WeeklogAPI already exposes replaceSummarized for deletion reuse', typeFile.includes('replaceSummarized'))

console.log(`\nResult: ${pass} passed, ${fail} failed\n`)
process.exit(fail ? 1 : 0)
