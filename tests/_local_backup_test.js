'use strict'
/* Local backup regression tests. */
const fs = require('fs')
const path = require('path')
const os = require('os')
const L = require('../src/main/local-backup')

let pass = 0
let fail = 0

function ok(name, cond, extra) {
  if (cond) {
    pass++
    console.log('  ✓ ' + name)
  } else {
    fail++
    console.log('  ✗ ' + name + (extra ? '  → ' + extra : ''))
  }
}

function readZipEntries(file) {
  const buf = fs.readFileSync(file)
  const entries = {}
  let offset = 0
  while (offset < buf.length - 4) {
    const sig = buf.readUInt32LE(offset)
    if (sig !== 0x04034b50) break
    const flags = buf.readUInt16LE(offset + 6)
    const method = buf.readUInt16LE(offset + 8)
    const compressedSize = buf.readUInt32LE(offset + 18)
    const fileNameLength = buf.readUInt16LE(offset + 26)
    const extraLength = buf.readUInt16LE(offset + 28)
    const nameStart = offset + 30
    const name = buf.slice(nameStart, nameStart + fileNameLength).toString('utf8')
    const dataStart = nameStart + fileNameLength + extraLength
    const data = buf.slice(dataStart, dataStart + compressedSize)
    if (flags !== 0 || method !== 0) throw new Error('test zip parser only supports stored entries')
    entries[name] = data.toString('utf8')
    offset = dataStart + compressedSize
  }
  return entries
}

function makeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-local-backup-'))
  const downloadsDir = path.join(dir, 'Downloads')
  const notesDir = path.join(dir, 'my-notes')
  fs.mkdirSync(notesDir, { recursive: true })
  fs.mkdirSync(path.join(dir, 'memory', 'entries'), { recursive: true })
  fs.mkdirSync(downloadsDir, { recursive: true })
  fs.writeFileSync(path.join(notesDir, '2026-06-17.md'), '本地备份内容', 'utf8')
  fs.writeFileSync(path.join(dir, 'memory', 'entries', 'm1.md'), '记忆内容', 'utf8')
  fs.writeFileSync(path.join(dir, 'memory', 'index.json'), JSON.stringify([{ id: 'm1' }]), 'utf8')
  fs.writeFileSync(path.join(dir, 'history.json'), JSON.stringify([{ id: 'h1', text: '历史' }]), 'utf8')
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    schemaVersion: 2,
    weekStart: 'monday',
    timezone: 'Asia/Shanghai',
    repos: [{ id: 'r1', path: '/Users/me/private-project', name: 'private-project' }],
    notes: { enabled: true, miscProject: '日常工作', dir: notesDir },
    ui: { theme: 'dark', quickNoteShortcut: 'CommandOrControl+Shift+L' },
    output: { format: 'text', newline: 'LF', withCommits: false, showNotes: false },
    memory: { enabled: true, embeddingSource: 'local', embeddingModel: 'Xenova/multilingual-e5-small', topK: 5 },
  }, null, 2), 'utf8')
  return { dir, downloadsDir }
}

console.log('\n[Local backup zip]')
ok('module exports createLocalBackup', typeof L.createLocalBackup === 'function')

if (typeof L.createLocalBackup === 'function') {
  const { dir, downloadsDir } = makeFixture()
  try {
    const result = L.createLocalBackup({
      cfg: {
        notes: { dir: path.join(dir, 'my-notes') },
      },
      dir,
      downloadsDir,
      deviceName: 'MacBook Pro',
      appVersion: '1.3.3',
      now: new Date(2026, 5, 17, 22, 15, 30),
    })
    ok('creates zip in Downloads directory', result.filePath.startsWith(downloadsDir + path.sep), result.filePath)
    ok('file name includes device and local time', path.basename(result.filePath) === 'weeklog-MacBook-Pro-20260617-221530.zip', path.basename(result.filePath))
    ok('zip file exists', fs.existsSync(result.filePath))
    const entries = readZipEntries(result.filePath)
    ok('zip contains manifest', entries['manifest.json'] && entries['manifest.json'].includes('MacBook Pro'))
    ok('zip contains custom notes', entries['notes/2026-06-17.md'] === '本地备份内容')
    ok('zip contains memory and history', entries['memory/entries/m1.md'] === '记忆内容' && entries['history.json'].includes('历史'))
    ok('zip config excludes local repo paths', entries['config.json'] && !entries['config.json'].includes('/Users/me/private-project'))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

console.log(`\n结果：${pass} 通过，${fail} 失败\n`)
process.exit(fail ? 1 : 0)
