'use strict'
/* Sidebar collapse regression checks for the renderer shell. */
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const appShell = fs.readFileSync(path.join(root, 'src/renderer/src/components/AppShell.tsx'), 'utf8')

let pass = 0
let fail = 0

function ok(name, cond, extra) {
  if (cond) {
    pass++
    console.log('  PASS ' + name)
  } else {
    fail++
    console.log('  FAIL ' + name + (extra ? ' -> ' + extra : ''))
  }
}

console.log('\n[Sidebar collapse]')
ok('AppShell owns collapsed sidebar state', /useState\s*<\s*boolean\s*>\s*\(\s*false\s*\)/.test(appShell))
ok('sidebar exposes an aria-pressed collapse toggle', appShell.includes('aria-pressed={sidebarCollapsed}'))
ok('collapse toggle has explicit expanded and collapsed labels', appShell.includes('收起侧边栏') && appShell.includes('展开侧边栏'))
ok('collapsed sidebar uses icon-only width', appShell.includes("sidebarCollapsed ? 'w-[72px]' : 'w-[240px]'"))
ok('collapsed navigation items expose tooltip labels', appShell.includes('<TooltipProvider') && appShell.includes('<TooltipContent') && appShell.includes('{item.label}'))
ok('collapsed state hides section labels from layout', appShell.includes('sr-only') && appShell.includes('{sec.title}'))
ok('collapsed badges stay visible as compact counters', appShell.includes('size-5') && appShell.includes('{item.badge}'))

console.log(`\nResult: ${pass} passed, ${fail} failed\n`)
process.exit(fail ? 1 : 0)
