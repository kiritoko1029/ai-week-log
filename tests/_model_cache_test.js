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

async function main() {
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

  console.log('\n[Manual model download controls]')
  const manualDir = makeTmp()
  const manualUserDataDir = path.join(manualDir, 'userData')
  fs.mkdirSync(manualUserDataDir, { recursive: true })
  try {
    const cfg = { memory: { embeddingSource: 'local', embeddingModel: 'Xenova/multilingual-e5-small', modelSource: 'auto' } }
    const entry = {
      id: 'm_manual',
      project: 'WeekLog',
      digest: '测试手动模型下载',
      keywords: ['memory'],
    }
    memory.writeIndex(manualUserDataDir, [entry])
    ok('local model is not ready before explicit download', memory.getStatus(manualUserDataDir, cfg).modelReady === false)
    ok('manual download API is exported', typeof memory.downloadLocalModel === 'function')
    ok('model folder API is exported', typeof memory.openModelFolder === 'function')
    ok('model cleanup API is exported', typeof memory.clearLocalModel === 'function')

    const started = memory.processEmbedding(manualUserDataDir, cfg, entry.id)
    ok('processEmbedding returns a promise', started && typeof started.then === 'function')
    await started
    const list = memory.readIndex(manualUserDataDir)
    const item = list.find((x) => x.id === entry.id)
    ok('background embedding skips when local model is missing', item && !item.embeddingReady && !item.embedding)
    fs.rmSync(manualDir, { recursive: true, force: true })
  } catch (e) {
    ok('background embedding does not reject when local model is missing', false, e && e.message)
    fs.rmSync(manualDir, { recursive: true, force: true })
  }
}

main().finally(() => {
  console.log(`\nResult: ${pass} passed, ${fail} failed\n`)
  process.exit(fail ? 1 : 0)
})
