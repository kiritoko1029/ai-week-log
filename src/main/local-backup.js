'use strict'
// @ts-check
/**
 * Local backup module: writes a portable .zip snapshot to the system Downloads
 * directory. It is intentionally separate from WebDAV/cloud backup.
 */
const fs = require('fs')
const path = require('path')
const os = require('os')

const NOTES_DIR = 'notes'
const MEMORY_DIR = 'memory'
const MEMORY_ENTRIES_DIR = 'memory/entries'

const CONFIG_BACKUP_FIELDS = [
  'schemaVersion',
  'weekStart',
  'timezone',
  'dateBasis',
  ['filters'],
  ['notes', 'enabled'],
  ['notes', 'miscProject'],
  ['codexHook', 'enabled'],
  ['codexHook', 'port'],
  ['ui', 'theme'],
  ['ai', 'provider'],
  ['ai', 'concurrency'],
  ['ai', 'anthropic', 'model'],
  ['ai', 'anthropic', 'temperature'],
  ['ai', 'anthropic', 'maxTokens'],
  ['ai', 'openai', 'model'],
  ['ai', 'openai', 'temperature'],
  ['ai', 'openai', 'maxTokens'],
  ['output'],
  ['memory', 'enabled'],
  ['memory', 'embeddingSource'],
  ['memory', 'embeddingModel'],
  ['memory', 'topK'],
]

function safeFileNamePart(input) {
  return String(input || 'device')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'device'
}

function compactTimestamp(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  const h = String(d.getHours()).padStart(2, '0')
  const min = String(d.getMinutes()).padStart(2, '0')
  const s = String(d.getSeconds()).padStart(2, '0')
  return `${y}${m}${day}-${h}${min}${s}`
}

function getByPath(obj, pathArr) {
  let cur = obj
  for (const k of pathArr) {
    if (cur == null) return undefined
    cur = cur[k]
  }
  return cur
}

function setByPath(obj, pathArr, value) {
  let cur = obj
  for (let i = 0; i < pathArr.length - 1; i++) {
    if (cur[pathArr[i]] == null || typeof cur[pathArr[i]] !== 'object') cur[pathArr[i]] = {}
    cur = cur[pathArr[i]]
  }
  cur[pathArr[pathArr.length - 1]] = value
}

function pickConfigForBackup(localCfg) {
  const out = {}
  for (const field of CONFIG_BACKUP_FIELDS) {
    const pathArr = Array.isArray(field) ? field : [field]
    const v = getByPath(localCfg, pathArr)
    if (v !== undefined) setByPath(out, pathArr, v)
  }
  return out
}

function getNotesDirFromConfig(cfg, userDataDir) {
  const d = cfg && cfg.notes && cfg.notes.dir
  if (d && path.isAbsolute(d)) return d
  if (d) return path.join(userDataDir, d)
  return path.join(userDataDir, NOTES_DIR)
}

function readTreeFiles(baseDir, relPrefix, ext = null) {
  const out = {}
  if (!fs.existsSync(baseDir)) return out
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name)
      const stat = fs.statSync(p)
      if (stat.isDirectory()) {
        walk(p)
      } else if (!ext || name.endsWith(ext)) {
        const rel = path.relative(baseDir, p).split(path.sep).join('/')
        out[`${relPrefix}/${rel}`] = fs.readFileSync(p)
      }
    }
  }
  walk(baseDir)
  return out
}

function buildSnapshotFiles({ cfg, dir, deviceName, appVersion, now = new Date() }) {
  const files = {}
  const notesDir = getNotesDirFromConfig(cfg, dir)
  Object.assign(files, readTreeFiles(notesDir, NOTES_DIR, '.md'))
  Object.assign(files, readTreeFiles(path.join(dir, MEMORY_ENTRIES_DIR), MEMORY_ENTRIES_DIR, '.md'))

  for (const rel of [`${MEMORY_DIR}/index.json`, 'history.json']) {
    const p = path.join(dir, rel)
    if (fs.existsSync(p)) files[rel] = fs.readFileSync(p)
  }

  const configPath = path.join(dir, 'config.json')
  if (fs.existsSync(configPath)) {
    try {
      const picked = pickConfigForBackup(JSON.parse(fs.readFileSync(configPath, 'utf8')))
      files['config.json'] = Buffer.from(JSON.stringify(picked, null, 2), 'utf8')
    } catch {}
  }

  const manifest = {
    schemaVersion: 1,
    createdAt: (now instanceof Date ? now : new Date(now)).toISOString(),
    deviceName: deviceName || os.hostname() || 'device',
    appVersion: appVersion || '',
    fileCount: Object.keys(files).length,
    format: 'weeklog-local-backup-zip',
  }
  files['manifest.json'] = Buffer.from(JSON.stringify(manifest, null, 2), 'utf8')
  return files
}

function makeCrc32Table() {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c >>> 0
  }
  return table
}

const CRC32_TABLE = makeCrc32Table()

function crc32(buf) {
  let c = 0xffffffff
  for (const b of buf) c = CRC32_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function dosDateTime(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date)
  const year = Math.max(1980, d.getFullYear())
  const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2)
  const dosDate = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  return { dosTime, dosDate }
}

function createZipBuffer(files, now = new Date()) {
  const localParts = []
  const centralParts = []
  let offset = 0
  const { dosTime, dosDate } = dosDateTime(now)

  for (const name of Object.keys(files).sort()) {
    const data = Buffer.isBuffer(files[name]) ? files[name] : Buffer.from(String(files[name]), 'utf8')
    const fileName = Buffer.from(name, 'utf8')
    const crc = crc32(data)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt16LE(dosTime, 10)
    local.writeUInt16LE(dosDate, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(fileName.length, 26)
    local.writeUInt16LE(0, 28)
    localParts.push(local, fileName, data)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt16LE(dosTime, 12)
    central.writeUInt16LE(dosDate, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(fileName.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0, 38)
    central.writeUInt32LE(offset, 42)
    centralParts.push(central, fileName)

    offset += local.length + fileName.length + data.length
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0)
  const centralOffset = offset
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(Object.keys(files).length, 8)
  end.writeUInt16LE(Object.keys(files).length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(centralOffset, 16)
  end.writeUInt16LE(0, 20)
  return Buffer.concat([...localParts, ...centralParts, end])
}

function createLocalBackup({ cfg, dir, downloadsDir, deviceName = os.hostname(), appVersion = '', now = new Date() }) {
  if (!downloadsDir) throw new Error('未找到系统下载目录')
  fs.mkdirSync(downloadsDir, { recursive: true })
  const name = `weeklog-${safeFileNamePart(deviceName)}-${compactTimestamp(now)}.zip`
  const filePath = path.join(downloadsDir, name)
  const files = buildSnapshotFiles({ cfg, dir, deviceName, appVersion, now })
  const zip = createZipBuffer(files, now)
  fs.writeFileSync(filePath, zip)
  return { name, filePath, bytes: zip.length, fileCount: Object.keys(files).length }
}

module.exports = {
  createLocalBackup,
  _test: {
    createZipBuffer,
    buildSnapshotFiles,
    crc32,
  },
}
