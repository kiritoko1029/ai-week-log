'use strict'
/* Windows installer smoke test: uninstall user-data cleanup must be opt-in. */
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

console.log('\n[Windows uninstall cleanup option]')
const installer = read('build/installer.nsh')

ok('uninstaller uses a checkbox page instead of a modal prompt', installer.includes('nsDialogs::Create') && installer.includes('${NSD_CreateCheckbox}'))
ok('legacy yes/no uninstall prompt is not used', !installer.includes('MessageBox MB_YESNO'))
ok('cleanup checkbox starts unchecked by default', installer.includes('StrCpy $WeekLogDeleteUserData "0"'))
ok('checkbox state is read before uninstall cleanup', installer.includes('${NSD_GetState} $WeekLogDeleteUserDataCheckbox $WeekLogDeleteUserData'))
ok('unchecked uninstall keeps app data', installer.includes('StrCmp $WeekLogDeleteUserData ${BST_CHECKED} 0 skipUserDataCleanup'))
ok('cleanup macro is guarded by electron-builder uninstall build flag', installer.includes('!ifdef BUILD_UNINSTALLER') && !installer.includes('!ifdef __UNINSTALL__'))
ok('checked uninstall removes Roaming userData', installer.includes('RMDir /r "$APPDATA\\${APP_FILENAME}"'))
ok('checked uninstall removes LocalAppData cache', installer.includes('RMDir /r "$LOCALAPPDATA\\${APP_FILENAME}"'))
ok('script provides a custom uninstall options page', installer.includes('!macro customUnWelcomePage') && installer.includes('UninstPage custom un.weekLogUninstallOptionsShow un.weekLogUninstallOptionsLeave'))

console.log(`\nResult: ${pass} passed, ${fail} failed\n`)
process.exit(fail ? 1 : 0)
