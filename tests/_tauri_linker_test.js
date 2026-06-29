'use strict'
/* Tauri macOS linker smoke test: build.rs should add the active clang runtime path. */
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

console.log('\n[Tauri macOS linker runtime]')
const buildRs = read('src-tauri/build.rs')
ok('build.rs probes active clang resource dir', buildRs.includes('-print-resource-dir'))
ok('build.rs uses xcrun clang when available', buildRs.includes('xcrun') && buildRs.includes('clang'))
ok('build.rs adds darwin clang runtime search path', buildRs.includes('lib/darwin') && buildRs.includes('cargo:rustc-link-search=native='))
ok('build.rs reruns when developer dir changes', buildRs.includes('cargo:rerun-if-env-changed=DEVELOPER_DIR'))
ok('build.rs keeps tauri-build invocation', buildRs.includes('tauri_build::build()'))

console.log(`\nResult: ${pass} passed, ${fail} failed\n`)
process.exit(fail ? 1 : 0)
