'use strict'
/* Model cache smoke test: embedding models must survive DMG app replacement. */
const fs = require('fs')
const os = require('os')
const path = require('path')

const root = path.resolve(__dirname, '..')
const memory = require(path.join(root, 'src/main/memory'))

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

function makeTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'weeklog-model-cache-'))
}

console.log('\n[Embedding model cache]')
const dir = makeTmp()
const userDataDir = path.join(dir, 'userData')
const resourcesDir = path.join(dir, 'WeekLog.app', 'Contents', 'Resources')
fs.mkdirSync(userDataDir, { recursive: true })
fs.mkdirSync(resourcesDir, { recursive: true })

const originalResourcesPath = process.resourcesPath
try {
  Object.defineProperty(process, 'resourcesPath', {
    value: resourcesDir,
    configurable: true,
  })
  const cacheDir = memory.resolveModelCacheDir(userDataDir)
  ok('stores embedding models under userData', cacheDir === path.join(userDataDir, 'models'), cacheDir)
  ok('does not store embedding models inside app resources', !cacheDir.startsWith(resourcesDir), cacheDir)
} finally {
  Object.defineProperty(process, 'resourcesPath', {
    value: originalResourcesPath,
    configurable: true,
  })
  fs.rmSync(dir, { recursive: true, force: true })
}

console.log(`\nResult: ${pass} passed, ${fail} failed\n`)
process.exit(fail ? 1 : 0)
