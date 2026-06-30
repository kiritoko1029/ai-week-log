'use strict'
// @ts-check
/**
 * WebDAV 同步模块：基于 Node 内置 fetch（支持自定义方法），无第三方依赖。
 * 同步范围：notes/*.md、memory/、history.json、config.json（白名单合并）。
 * 策略：notes/entries 按文件名/日期单位 last-write-wins；index.json/history 按 id 并集合并；
 *       config.json 仅同步用户偏好，不同步 repos（本机路径）与 key。
 */

const fs = require('fs')
const path = require('path')
const os = require('os')
const zlib = require('zlib')

const NOTES_DIR = 'notes'
const MEMORY_DIR = 'memory'
const MEMORY_ENTRIES_DIR = 'memory/entries'
const STATUS_FILE = 'webdav-status.json'
const BACKUPS_DIR = 'backups'
const DEFAULT_BACKUP_RETENTION = 10

/** 把任意字符串转为 Basic Auth header 值 */
function basicAuth(username, password) {
  return 'Basic ' + Buffer.from(`${username || ''}:${password || ''}`, 'utf8').toString('base64')
}

function isPrivateHostname(hostname) {
  const h = String(hostname || '').toLowerCase()
  if (!h) return true
  if (h === 'localhost' || h.endsWith('.localhost')) return true
  if (h === '::1' || h === '[::1]') return true
  if (h.startsWith('127.')) return true
  if (h.startsWith('10.')) return true
  if (h.startsWith('192.168.')) return true
  const parts = h.split('.').map((p) => Number(p))
  if (parts.length === 4 && parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true
    if (parts[0] === 169 && parts[1] === 254) return true
    if (parts[0] === 0) return true
  }
  if (h === 'fc00::' || h === 'fe80::' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80:')) return true
  return false
}

function normalizeWebdavBaseUrl(input, opts = {}) {
  const raw = String(input || '').trim()
  if (!raw) throw new Error('未配置 WebDAV URL')
  let parsed
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error('WebDAV URL 格式无效')
  }
  const allowInsecure = opts.allowInsecure || process.env.WEEKLOG_ALLOW_INSECURE_WEBDAV === '1'
  const allowPrivateHosts = opts.allowPrivateHosts || process.env.WEEKLOG_ALLOW_PRIVATE_WEBDAV === '1'
  if (parsed.protocol !== 'https:' && !(allowInsecure && parsed.protocol === 'http:')) {
    throw new Error('WebDAV URL 必须使用 HTTPS')
  }
  if (!allowPrivateHosts && isPrivateHostname(parsed.hostname)) {
    throw new Error('WebDAV URL 不能指向本机或私有网络地址')
  }
  parsed.hash = ''
  parsed.search = ''
  if (!parsed.pathname.endsWith('/')) parsed.pathname += '/'
  return parsed.toString()
}

/** 规范化 URL：确保以 / 结尾，拼 path 时去掉重复斜杠 */
function joinUrl(base, rel) {
  const b = base.endsWith('/') ? base : base + '/'
  const r = rel.replace(/^\/+/, '')
  return b + r
}

// ── WebDAV 原语（基于 fetch）──

async function davRequest(method, url, { username, password, headers = {}, body = null, expect = [200, 204], logger = null } = {}) {
  const res = await fetch(url, {
    method,
    headers: { Authorization: basicAuth(username, password), ...headers },
    body,
  })
  if (logger) logger.debug('webdav.http', `${method} ${res.status}`, { method, url, status: res.status })
  if (!expect.includes(res.status)) {
    const text = await res.text().catch(() => '')
    if (logger) logger.warn('webdav.http', `${method} 返回非预期状态`, { method, url, status: res.status, response: text.slice(0, 200) })
    throw new Error(`WebDAV ${method} ${url} → ${res.status}: ${text.slice(0, 200)}`)
  }
  return res
}

/** PROPFIND depth:1 列出目录下的直接子项。返回 [{href, displayName, isCollection, size, lastModified}] */
async function propfind(url, { username, password, logger = null }) {
  const body = `<?xml version="1.0" encoding="utf-8"?>
<D:propfind xmlns:D="DAV:">
  <D:prop>
    <D:displayname/>
    <D:resourcetype/>
    <D:getcontentlength/>
    <D:getlastmodified/>
  </D:prop>
</D:propfind>`
  const res = await fetch(url, {
    method: 'PROPFIND',
    headers: {
      Authorization: basicAuth(username, password),
      Depth: '1',
      'Content-Type': 'application/xml; charset=utf-8',
    },
    body,
  })
  if (logger) logger.debug('webdav.http', `PROPFIND ${res.status}`, { method: 'PROPFIND', url, status: res.status })
  if (res.status !== 207 && res.status !== 200) {
    const text = await res.text().catch(() => '')
    if (logger) logger.warn('webdav.http', 'PROPFIND 返回非预期状态', { method: 'PROPFIND', url, status: res.status, response: text.slice(0, 200) })
    throw new Error(`PROPFIND ${url} → ${res.status}: ${text.slice(0, 200)}`)
  }
  const xml = await res.text()
  return parsePropfind(xml)
}

/** 解析 PROPFIND multistatus XML（轻量正则实现，避免引入 xml 解析库） */
function parsePropfind(xml) {
  const items = []
  const responseRe = /<D?:?response[^>]*>([\s\S]*?)<\/D?:?response>/gi
  const hrefRe = /<D?:?href[^>]*>([\s\S]*?)<\/D?:?href>/i
  const nameRe = /<D?:?displayname[^>]*>([\s\S]*?)<\/D?:?displayname>/i
  const typeRe = /<D?:?collection[^>]*\/?>/i
  const sizeRe = /<D?:?getcontentlength[^>]*>([\s\S]*?)<\/D?:?getcontentlength>/i
  const modRe = /<D?:?getlastmodified[^>]*>([\s\S]*?)<\/D?:?getlastmodified>/i

  let m
  while ((m = responseRe.exec(xml)) !== null) {
    const block = m[1]
    const href = (hrefRe.exec(block) || [])[1] || ''
    const isCollection = typeRe.test(block)
    const displayName = ((nameRe.exec(block) || [])[1] || '').trim()
    const size = parseInt(((sizeRe.exec(block) || [])[1] || '0').trim(), 10) || 0
    const lastModified = ((modRe.exec(block) || [])[1] || '').trim()
    items.push({ href: decodeURIComponent(href.trim()), displayName, isCollection, size, lastModified })
  }
  // 第一个总是目录自身，跳过
  return items.slice(1)
}

async function ensureCollection(url, creds) {
  const logger = creds.logger || null
  // 先 PROPFIND 确认是否已存在
  try {
    await propfind(url.endsWith('/') ? url : url + '/', creds)
    if (logger) logger.debug('webdav.collection', '远端目录已存在', { url })
    return { ok: true, created: false }
  } catch {}
  // 不存在 → 逐级 MKCOL（WebDAV 只能创建单层，需先确保父目录存在）
  const parts = url.replace(/^https?:\/\//, '').split('/').filter(Boolean)
  // parts[0] = host:port，其后才是路径段
  if (parts.length < 2) {
    // 仅根域名，无法 MKCOL（根已存在），视为成功
    return { ok: true, created: false }
  }
  const proto = url.startsWith('https') ? 'https://' : 'http://'
  const host = parts[0]
  let cur = proto + host
  let createdAny = false
  for (let i = 1; i < parts.length; i++) {
    cur += '/' + decodeURIComponent(parts[i])
    // 先查
    try {
      await propfind(cur + '/', creds)
      if (logger) logger.debug('webdav.collection', '远端父目录已存在', { url: cur + '/' })
      continue // 已存在，下一级
    } catch {}
    // 不存在则 MKCOL
    const res = await fetch(cur + '/', {
      method: 'MKCOL',
      headers: { Authorization: basicAuth(creds.username, creds.password) },
    })
    if (logger) logger.debug('webdav.http', `MKCOL ${res.status}`, { method: 'MKCOL', url: cur + '/', status: res.status })
    if (res.status === 201) {
      createdAny = true
      if (logger) logger.info('webdav.collection', '创建远端目录', { url: cur + '/' })
      continue
    }
    if (res.status === 405 || res.status === 301) {
      // 已存在（Method Not Allowed），放行
      continue
    }
    if (res.status >= 200 && res.status < 400) continue
    // 409 Conflict：父目录不存在 —— 理论上逐级创建不会发生；兜底报错
    const text = await res.text().catch(() => '')
    throw new Error(`MKCOL ${cur} → ${res.status} ${text.slice(0, 120)}`.trim())
  }
  return { ok: true, created: createdAny }
}

async function davGet(url, creds) {
  const logger = creds.logger || null
  const res = await fetch(url, { headers: { Authorization: basicAuth(creds.username, creds.password) } })
  if (logger) logger.debug('webdav.http', `GET ${res.status}`, { method: 'GET', url, status: res.status })
  if (res.status === 404) return null
  if (res.status !== 200) {
    const text = await res.text().catch(() => '')
    if (logger) logger.warn('webdav.http', 'GET 返回非预期状态', { method: 'GET', url, status: res.status, response: text.slice(0, 200) })
    throw new Error(`GET ${url} → ${res.status}: ${text.slice(0, 200)}`)
  }
  return await res.text()
}

async function davPut(url, creds, content) {
  const logger = creds.logger || null
  await davRequest('PUT', url, {
    ...creds,
    body: content,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    expect: [200, 201, 204],
    logger,
  })
}

async function davGetBuffer(url, creds) {
  const logger = creds.logger || null
  const res = await fetch(url, { headers: { Authorization: basicAuth(creds.username, creds.password) } })
  if (logger) logger.debug('webdav.http', `GET ${res.status}`, { method: 'GET', url, status: res.status })
  if (res.status !== 200) {
    const text = await res.text().catch(() => '')
    if (logger) logger.warn('webdav.http', 'GET 返回非预期状态', { method: 'GET', url, status: res.status, response: text.slice(0, 200) })
    throw new Error(`GET ${url} → ${res.status}: ${text.slice(0, 200)}`)
  }
  return Buffer.from(await res.arrayBuffer())
}

async function davDelete(url, creds) {
  await davRequest('DELETE', url, { ...creds, expect: [200, 202, 204, 404] })
}

// ── 同步状态读写 ──

function readStatus(dir) {
  try {
    const p = path.join(dir, STATUS_FILE)
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8')) || {}
  } catch {}
  return {}
}

function writeStatus(dir, status) {
  try {
    fs.writeFileSync(path.join(dir, STATUS_FILE), JSON.stringify(status, null, 2), 'utf8')
  } catch (e) {
    console.warn('[webdav] 状态写入失败：', e.message)
  }
}

// ── 本地辅助：读/写文件 ──

function readLocalFile(localPath) {
  try {
    if (fs.existsSync(localPath)) return fs.readFileSync(localPath, 'utf8')
  } catch {}
  return null
}

function writeLocalFile(localPath, content) {
  fs.mkdirSync(path.dirname(localPath), { recursive: true })
  fs.writeFileSync(localPath, content, 'utf8')
}

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
        out[`${relPrefix}/${rel}`] = fs.readFileSync(p, 'utf8')
      }
    }
  }
  walk(baseDir)
  return out
}

function pickConfigForBackup(localCfg) {
  const out = {}
  for (const field of CONFIG_SYNC_FIELDS) {
    const pathArr = Array.isArray(field) ? field : [field]
    const v = getByPath(localCfg, pathArr)
    if (v !== undefined) setByPath(out, pathArr, v)
  }
  return out
}

function mergeRestoredConfig(currentCfg, backupCfg) {
  const out = { ...(currentCfg || {}) }
  for (const field of CONFIG_SYNC_FIELDS) {
    const pathArr = Array.isArray(field) ? field : [field]
    const v = getByPath(backupCfg, pathArr)
    if (v !== undefined) setByPath(out, pathArr, v)
  }
  return out
}

function createBackupPayload({ cfg, dir, deviceName, appVersion, now = new Date() }) {
  const files = {}
  const notesDir = getNotesDirFromConfig(cfg, dir)
  Object.assign(files, readTreeFiles(notesDir, NOTES_DIR, '.md'))
  Object.assign(files, readTreeFiles(path.join(dir, MEMORY_ENTRIES_DIR), MEMORY_ENTRIES_DIR, '.md'))

  for (const rel of [`${MEMORY_DIR}/index.json`, 'history.json']) {
    const p = path.join(dir, rel)
    if (fs.existsSync(p)) files[rel] = fs.readFileSync(p, 'utf8')
  }

  const configPath = path.join(dir, 'config.json')
  if (fs.existsSync(configPath)) {
    try {
      files['config.json'] = JSON.stringify(pickConfigForBackup(JSON.parse(fs.readFileSync(configPath, 'utf8'))), null, 2)
    } catch {}
  }

  return {
    manifest: {
      schemaVersion: 1,
      createdAt: (now instanceof Date ? now : new Date(now)).toISOString(),
      deviceName: deviceName || os.hostname() || 'device',
      appVersion: appVersion || '',
      fileCount: Object.keys(files).length,
    },
    files,
  }
}

function backupName({ deviceName, now = new Date() }) {
  return `weeklog-${safeFileNamePart(deviceName || os.hostname())}-${compactTimestamp(now)}.json.gz`
}

function parseBackupName(name) {
  const m = /^weeklog-(.+)-(\d{8}-\d{6})\.json\.gz$/.exec(String(name || ''))
  if (!m) return { name, deviceName: '', createdAt: '' }
  const ts = m[2]
  const createdAt = `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}T${ts.slice(9, 11)}:${ts.slice(11, 13)}:${ts.slice(13, 15)}.000Z`
  return { name, deviceName: m[1].replace(/-/g, ' '), createdAt }
}

function backupSortValue(item) {
  return item.createdAt || item.lastModified || item.name || ''
}

async function listBackups({ cfg, password, logger = null }) {
  const wcfg = cfg.webdav || {}
  const base = normalizeWebdavBaseUrl(wcfg.url || '')
  const creds = { username: wcfg.username || '', password, logger }
  const remoteBase = joinUrl(base, `${BACKUPS_DIR}/`)
  let items = []
  try {
    items = await propfind(remoteBase, creds)
  } catch (e) {
    if (String(e.message || '').includes('404')) {
      await ensureCollection(remoteBase, creds)
      return []
    }
    throw e
  }
  return items
    .filter((i) => !i.isCollection && /\.json\.gz$/.test(i.displayName || ''))
    .map((i) => {
      const parsed = parseBackupName(i.displayName)
      return {
        name: i.displayName,
        deviceName: parsed.deviceName,
        createdAt: parsed.createdAt,
        size: i.size || 0,
        lastModified: i.lastModified || '',
      }
    })
    .sort((a, b) => backupSortValue(b).localeCompare(backupSortValue(a)))
}

async function pruneBackups({ cfg, password, keep = DEFAULT_BACKUP_RETENTION, logger = null, current = null }) {
  const wcfg = cfg.webdav || {}
  const base = normalizeWebdavBaseUrl(wcfg.url || '')
  const creds = { username: wcfg.username || '', password, logger }
  let backups = await listBackups({ cfg, password, logger })
  if (current && current.name && !backups.some((item) => item.name === current.name)) {
    backups = [current, ...backups]
      .sort((a, b) => backupSortValue(b).localeCompare(backupSortValue(a)))
  }
  const extra = backups.slice(Math.max(1, Number(keep) || DEFAULT_BACKUP_RETENTION))
  for (const item of extra) {
    await davDelete(joinUrl(base, `${BACKUPS_DIR}/${encodeURIComponent(item.name)}`), creds)
    if (logger) logger.info('webdav.backup.prune', '删除旧备份', { name: item.name })
  }
  return extra.length
}

async function createBackup({ cfg, dir, password, deviceName = os.hostname(), appVersion = '', now = new Date(), logger = null }) {
  const wcfg = cfg.webdav || {}
  const base = normalizeWebdavBaseUrl(wcfg.url || '')
  const creds = { username: wcfg.username || '', password, logger }
  const retention = Math.max(1, Number(wcfg.backupRetention) || DEFAULT_BACKUP_RETENTION)
  const remoteBackups = joinUrl(base, `${BACKUPS_DIR}/`)
  const name = backupName({ deviceName, now })
  const remoteUrl = joinUrl(remoteBackups, encodeURIComponent(name))
  const t0 = Date.now()

  if (logger) logger.info('webdav.backup.start', '开始创建 WebDAV 备份', { remoteUrl, retention, deviceName })
  await ensureCollection(base, creds)
  await ensureCollection(remoteBackups, creds)
  const payload = createBackupPayload({ cfg, dir, deviceName, appVersion, now })
  const body = zlib.gzipSync(Buffer.from(JSON.stringify(payload), 'utf8'))
  await davRequest('PUT', remoteUrl, {
    ...creds,
    body,
    headers: { 'Content-Type': 'application/gzip' },
    expect: [200, 201, 204],
  })
  const pruned = await pruneBackups({
    cfg,
    password,
    keep: retention,
    logger,
    current: { name, deviceName, createdAt: payload.manifest.createdAt, size: body.length, lastModified: payload.manifest.createdAt },
  })
  const result = { name, remoteUrl, bytes: body.length, fileCount: Object.keys(payload.files).length, pruned }
  writeStatus(dir, {
    lastBackup: new Date().toISOString(),
    direction: 'backup',
    durationMs: Date.now() - t0,
    pulled: 0,
    pushed: 1,
    errors: [],
    backup: result,
  })
  if (logger) logger.info('webdav.backup.done', 'WebDAV 备份完成', { ...result, durationMs: Date.now() - t0 })
  return result
}

function restorePayloadToLocal(payload, { cfg, dir }) {
  if (!payload || !payload.manifest || payload.manifest.schemaVersion !== 1 || !payload.files || typeof payload.files !== 'object') {
    throw new Error('备份文件格式无效')
  }
  let restoredFiles = 0
  const notesDir = getNotesDirFromConfig(cfg, dir)
  for (const [rel, content] of Object.entries(payload.files)) {
    if (rel.startsWith(`${NOTES_DIR}/`)) {
      writeLocalFile(path.join(notesDir, rel.slice(NOTES_DIR.length + 1)), String(content))
      restoredFiles++
    } else if (rel.startsWith(`${MEMORY_ENTRIES_DIR}/`)) {
      writeLocalFile(path.join(dir, rel), String(content))
      restoredFiles++
    } else if (rel === `${MEMORY_DIR}/index.json` || rel === 'history.json') {
      writeLocalFile(path.join(dir, rel), String(content))
      restoredFiles++
    } else if (rel === 'config.json') {
      const currentPath = path.join(dir, 'config.json')
      const currentCfg = fs.existsSync(currentPath) ? JSON.parse(fs.readFileSync(currentPath, 'utf8')) : {}
      const backupCfg = JSON.parse(String(content || '{}'))
      writeLocalFile(currentPath, JSON.stringify(mergeRestoredConfig(currentCfg, backupCfg), null, 2))
      restoredFiles++
    }
  }
  return { restoredFiles, manifest: payload.manifest }
}

async function restoreBackup({ cfg, dir, password, name, logger = null }) {
  if (!/^[^/\\]+\.json\.gz$/.test(String(name || ''))) throw new Error('备份文件名无效')
  const wcfg = cfg.webdav || {}
  const base = normalizeWebdavBaseUrl(wcfg.url || '')
  const creds = { username: wcfg.username || '', password, logger }
  const remoteUrl = joinUrl(base, `${BACKUPS_DIR}/${encodeURIComponent(name)}`)
  const t0 = Date.now()
  if (logger) logger.info('webdav.restore.start', '开始恢复 WebDAV 备份', { name, remoteUrl })

  const localSafety = createBackupPayload({ cfg, dir, deviceName: os.hostname(), appVersion: '', now: new Date() })
  const safetyDir = path.join(dir, BACKUPS_DIR)
  fs.mkdirSync(safetyDir, { recursive: true })
  const safetyName = `before-restore-${compactTimestamp(new Date())}.json.gz`
  fs.writeFileSync(path.join(safetyDir, safetyName), zlib.gzipSync(Buffer.from(JSON.stringify(localSafety), 'utf8')))

  const compressed = await davGetBuffer(remoteUrl, creds)
  const payload = JSON.parse(zlib.gunzipSync(compressed).toString('utf8'))
  const result = restorePayloadToLocal(payload, { cfg, dir })
  writeStatus(dir, {
    lastRestore: new Date().toISOString(),
    direction: 'restore',
    durationMs: Date.now() - t0,
    pulled: result.restoredFiles,
    pushed: 0,
    errors: [],
    restore: { name, safetyName, manifest: result.manifest },
  })
  if (logger) logger.info('webdav.restore.done', 'WebDAV 备份恢复完成', { name, safetyName, restoredFiles: result.restoredFiles, durationMs: Date.now() - t0 })
  return { name, safetyName, ...result }
}

function parseIsoFromText(text) {
  // 解析 JSON 中的 updatedAt / 或 md 顶部 frontmatter —— 通用：尝试 JSON，否则用 mtime
  try {
    const o = JSON.parse(text)
    return o.updatedAt || o._updatedAt || ''
  } catch {
    return ''
  }
}

// ── 同步单文件：last-write-wins（按内容 updatedAt，无则跳过、保留本地）──

async function syncFile(remoteUrl, localPath, creds, direction) {
  let result = 'noop'
  const local = readLocalFile(localPath)
  let remote = null
  let remoteChecked = false
  const wantPull = direction === 'pull' || direction === 'both'
  const wantPush = direction === 'push' || direction === 'both'

  if (wantPull) {
    remote = await davGet(remoteUrl, creds)
    remoteChecked = true
    if (remote !== null) {
      if (local === null) {
        writeLocalFile(localPath, remote)
        result = 'pulled'
      } else if (remote !== local) {
        // 远端更新（简单内容比对）→ 拉取覆盖（单人两机场景，覆盖即可）
        writeLocalFile(localPath, remote)
        result = 'pulled'
      }
    }
  }

  if (wantPush && result !== 'pulled') {
    if (!remoteChecked) remote = await davGet(remoteUrl, creds)
    if (local !== null && local !== remote) {
      await davPut(remoteUrl, creds, local)
      result = result === 'pulled' ? 'both' : 'pushed'
    }
  }

  if (creds.logger) {
    creds.logger.info('webdav.file.result', '文件同步完成', {
      result,
      direction,
      remoteUrl,
      localPath,
      localExists: local !== null,
      remoteExists: remote !== null,
    })
  }
  return result
}

// ── 同步目录：列出两边文件，逐一同步 ──

async function syncDirectory(remoteBase, localDir, creds, direction, ext) {
  let pulled = 0
  let pushed = 0
  if (creds.logger) creds.logger.info('webdav.directory.start', '开始同步目录', { remoteBase, localDir, direction, ext })

  // 远端列表
  let remoteFiles = []
  try {
    const items = await propfind(remoteBase, creds)
    remoteFiles = items.filter((i) => !i.isCollection && (!ext || i.displayName.endsWith(ext)))
    if (creds.logger) creds.logger.info('webdav.directory.remote', '读取远端目录', { remoteBase, count: remoteFiles.length })
  } catch (e) {
    // 远端目录不存在：若要 push 则创建
    if (wantPush(direction)) {
      await ensureCollection(remoteBase, creds)
      if (creds.logger) creds.logger.info('webdav.directory.remote', '远端目录不存在，已尝试创建', { remoteBase })
    } else {
      throw e
    }
  }

  // 本地列表
  let localFiles = []
  try {
    localFiles = fs.existsSync(localDir)
      ? fs.readdirSync(localDir).filter((f) => !ext || f.endsWith(ext))
      : []
    if (creds.logger) creds.logger.info('webdav.directory.local', '读取本地目录', { localDir, count: localFiles.length })
  } catch {}

  const names = new Set([
    ...remoteFiles.map((i) => i.displayName).filter(Boolean),
    ...localFiles,
  ])

  for (const name of names) {
    const remote = joinUrl(remoteBase, encodeURIComponent(name))
    const local = path.join(localDir, name)
    try {
      const r = await syncFile(remote, local, creds, direction)
      if (r === 'pulled' || r === 'both') pulled++
      if (r === 'pushed' || r === 'both') pushed++
    } catch (e) {
      console.warn(`[webdav] 同步 ${name} 失败：`, e.message)
      if (creds.logger) {
        creds.logger.error('webdav.file.error', '文件同步失败', {
          name,
          remoteUrl: remote,
          localPath: local,
          error: e.message,
        })
      }
    }
  }
  if (creds.logger) creds.logger.info('webdav.directory.done', '目录同步完成', { remoteBase, localDir, pulled, pushed, total: names.size })
  return { pulled, pushed }
}

function wantPush(direction) {
  return direction === 'push' || direction === 'both'
}
function wantPull(direction) {
  return direction === 'pull' || direction === 'both'
}

function formatConnectionError(error) {
  const raw = String((error && error.message) || error || '未知错误')
  if (/\b401\b/.test(raw)) return 'WebDAV 连接失败：认证失败（401），请检查用户名或密码'
  if (/\b403\b/.test(raw)) return 'WebDAV 连接失败：没有访问权限（403），请检查账号权限或目录授权'
  if (/\b404\b/.test(raw)) return 'WebDAV 连接失败：远端路径不存在（404）且无法自动创建，请检查服务器 URL'
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|network/i.test(raw)) return `WebDAV 连接失败：网络不可达或服务器无响应（${raw}）`
  return `WebDAV 连接失败：${raw}`
}

// ── 按 id 并集合并 JSON（用于 index.json / history.json）──

function itemKey(item, idField) {
  return (item && item[idField]) || JSON.stringify(item)
}

function itemTimestamp(item) {
  return (item && (item.updatedAt || item._updatedAt || item.createdAt)) || ''
}

function mergeJsonArraysById(localArr, remoteArr, idField) {
  const byId = new Map()
  for (const item of localArr) {
    byId.set(itemKey(item, idField), item)
  }
  let pulled = 0
  for (const item of remoteArr) {
    const k = itemKey(item, idField)
    const existing = byId.get(k)
    if (!existing) {
      byId.set(k, item)
      pulled++
      continue
    }
    const localUp = itemTimestamp(existing)
    const remoteUp = itemTimestamp(item)
    if (remoteUp && (!localUp || remoteUp > localUp)) {
      byId.set(k, item)
      pulled++
    }
  }
  return { items: [...byId.values()], pulled }
}

async function syncMergedJson(remoteUrl, localPath, creds, direction, idField) {
  let pulled = 0
  let pushed = 0
  const localRaw = readLocalFile(localPath)
  let localArr = []
  try {
    localArr = localRaw ? JSON.parse(localRaw) : []
    if (!Array.isArray(localArr)) localArr = []
  } catch {}

  let remoteArr = []
  if (wantPull(direction)) {
    const remoteRaw = await davGet(remoteUrl, creds)
    if (remoteRaw) {
      try {
        remoteArr = JSON.parse(remoteRaw)
        if (!Array.isArray(remoteArr)) remoteArr = []
      } catch {}
    }
  }

  let merged = false
  const mergedResult = mergeJsonArraysById(localArr, remoteArr, idField)
  const out = mergedResult.items
  pulled = mergedResult.pulled
  merged = pulled > 0

  if (merged && wantPull(direction)) {
    writeLocalFile(localPath, JSON.stringify(out, null, 2))
  }

  // 推送：把合并后的写回远端
  if (wantPush(direction)) {
    const remoteRaw = await davGet(remoteUrl, creds)
    let remoteExisting = []
    try {
      remoteExisting = remoteRaw ? JSON.parse(remoteRaw) : []
      if (!Array.isArray(remoteExisting)) remoteExisting = []
    } catch {}
    // 推送新增/更新的本地条目
    const remoteIds = new Set(remoteExisting.map((i) => itemKey(i, idField)))
    const toPush = out.filter((i) => {
      const k = itemKey(i, idField)
      return !remoteIds.has(k) || true // 全量回写，保证远端也包含并集
    })
    if (toPush.length !== remoteExisting.length || JSON.stringify(toPush) !== JSON.stringify(remoteExisting)) {
      await davPut(remoteUrl, creds, JSON.stringify(out, null, 2))
      pushed = out.length - remoteExisting.length
      if (pushed < 0) pushed = 0
    }
  }

  if (creds.logger) {
    creds.logger.info('webdav.json.result', 'JSON 同步完成', {
      remoteUrl,
      localPath,
      direction,
      pulled,
      pushed,
      idField,
    })
  }

  return { pulled, pushed }
}

// ── config.json 白名单合并 ──

const CONFIG_SYNC_FIELDS = [
  'schemaVersion',
  'weekStart',
  'timezone',
  'dateBasis',
  ['filters'],
  ['notes', 'enabled'],
  ['notes', 'miscProject'],
  ['mcp', 'enabled'],
  ['mcp', 'port'],
  ['noteSummary'],
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

async function syncConfig(remoteUrl, localPath, creds, direction) {
  let pulled = 0
  let pushed = 0
  const localRaw = readLocalFile(localPath)
  const localCfg = localRaw ? JSON.parse(localRaw) : {}

  let remoteCfg = null
  if (wantPull(direction)) {
    const remoteRaw = await davGet(remoteUrl, creds)
    if (remoteRaw) {
      try {
        remoteCfg = JSON.parse(remoteRaw)
      } catch {}
    }
  }

  // 拉取：把远端偏好字段合并进本地（repos/key/secret 保留本地）
  if (remoteCfg) {
    for (const field of CONFIG_SYNC_FIELDS) {
      const v = getByPath(remoteCfg, Array.isArray(field) ? field : [field])
      if (v !== undefined) {
        setByPath(localCfg, Array.isArray(field) ? field : [field], v)
        pulled++
      }
    }
    writeLocalFile(localPath, JSON.stringify(localCfg, null, 2))
  }

  // 推送：本地（已合并）偏好字段写到远端 —— 但远端可能已有其本地路径/配置
  if (wantPush(direction)) {
    const pushCfg = {}
    for (const field of CONFIG_SYNC_FIELDS) {
      const v = getByPath(localCfg, Array.isArray(field) ? field : [field])
      if (v !== undefined) setByPath(pushCfg, Array.isArray(field) ? field : [field], v)
    }
    // 与远端现有偏好合并（远端的 repos 等保留）
    let remoteBase = {}
    if (!remoteCfg) {
      const remoteRaw = await davGet(remoteUrl, creds)
      if (remoteRaw) try { remoteBase = JSON.parse(remoteRaw) } catch {}
    } else {
      remoteBase = remoteCfg
    }
    let changed = false
    for (const field of CONFIG_SYNC_FIELDS) {
      const v = getByPath(pushCfg, Array.isArray(field) ? field : [field])
      if (v !== undefined && JSON.stringify(getByPath(remoteBase, Array.isArray(field) ? field : [field])) !== JSON.stringify(v)) {
        setByPath(remoteBase, Array.isArray(field) ? field : [field], v)
        changed = true
        pushed++
      }
    }
    if (changed) {
      await davPut(remoteUrl, creds, JSON.stringify(remoteBase, null, 2))
    }
  }

  if (creds.logger) {
    creds.logger.info('webdav.config.result', '配置同步完成', {
      remoteUrl,
      localPath,
      direction,
      pulled,
      pushed,
      fieldCount: CONFIG_SYNC_FIELDS.length,
    })
  }

  return { pulled, pushed }
}

// ── 测试连接 ──

async function testConnection({ url, username, password, logger = null }) {
  try {
    const base = normalizeWebdavBaseUrl(url)
    const creds = { username, password, logger }
    if (logger) logger.info('webdav.test.start', '开始测试 WebDAV 连接', { base, username: username || '' })
    // 1) 先 PROPFIND 看根路径（/dav/）是否可达 + 凭证是否正确
    //    目的：早暴露认证/网络问题，且不依赖目标目录已存在
    try {
      const items = await propfind(base, creds)
      await ensureCollection(joinUrl(base, `${BACKUPS_DIR}/`), creds)
      if (logger) logger.info('webdav.test.done', 'WebDAV 连接成功', { base, count: items.length })
      return { ok: true, message: `连接成功，远端有 ${items.length} 个项目` }
    } catch (e) {
      // 目标目录不存在（404）→ 尝试自动创建，再验证
      const msg = String(e.message || '')
      if (msg.includes('404')) {
        try {
          const r = await ensureCollection(base, creds)
          if (r.created) {
            if (logger) logger.info('webdav.test.done', 'WebDAV 连接成功并创建目录', { base })
            return { ok: true, message: `连接成功，已自动创建远端目录 ${base}` }
          }
          // created=false 但没报错：可能并发已存在，再 PROPFIND 确认
          const items = await propfind(base, creds)
          await ensureCollection(joinUrl(base, `${BACKUPS_DIR}/`), creds)
          if (logger) logger.info('webdav.test.done', 'WebDAV 连接成功', { base, count: items.length })
          return { ok: true, message: `连接成功，远端有 ${items.length} 个项目` }
        } catch (e2) {
          if (logger) logger.error('webdav.test.error', 'WebDAV 目标目录创建失败', { base, error: e2.message })
          return { ok: false, message: `目标目录不存在且自动创建失败：${e2.message}` }
        }
      }
      // 其它错误（401/403/网络）原样返回
      if (logger) logger.warn('webdav.test.error', 'WebDAV 连接失败', { base, error: msg })
      return { ok: false, message: msg }
    }
  } catch (e) {
    if (logger) logger.error('webdav.test.error', 'WebDAV 连接测试异常', { error: e.message })
    return { ok: false, message: e.message }
  }
}

// ── 主同步入口 ──

async function syncAll({ cfg, dir, password, direction = 'both', logger = null }) {
  const wcfg = cfg.webdav || {}
  const url = normalizeWebdavBaseUrl(wcfg.url || '')
  const username = wcfg.username || ''
  const creds = { username, password, logger }
  const base = url

  const result = { pulled: 0, pushed: 0, errors: [] }
  const t0 = Date.now()
  if (logger) logger.info('webdav.sync.start', '开始 WebDAV 同步', { base, direction, userDataDir: dir, username })

  // 确保远端目录结构
  try {
    await ensureCollection(base, creds)
    await ensureCollection(joinUrl(base, NOTES_DIR), creds)
    await ensureCollection(joinUrl(base, MEMORY_DIR), creds)
    await ensureCollection(joinUrl(base, MEMORY_ENTRIES_DIR), creds)
  } catch (e) {
    const message = formatConnectionError(e)
    result.errors.push(message)
    writeStatus(dir, {
      lastSync: new Date().toISOString(),
      direction,
      durationMs: Date.now() - t0,
      ...result,
    })
    if (logger) logger.error('webdav.sync.error', 'WebDAV 连接失败', { base, error: e.message, message })
    throw new Error(message)
  }

  // 1. notes/ 目录同步（按日期文件名）
  try {
    const r = await syncDirectory(joinUrl(base, NOTES_DIR), path.join(dir, NOTES_DIR), creds, direction, '.md')
    result.pulled += r.pulled
    result.pushed += r.pushed
  } catch (e) {
    result.errors.push(`notes 同步失败：${e.message}`)
    if (logger) logger.error('webdav.sync.error', 'notes 同步失败', { error: e.message })
  }

  // 2. memory/entries/ 目录同步
  try {
    const r = await syncDirectory(joinUrl(base, MEMORY_ENTRIES_DIR), path.join(dir, MEMORY_ENTRIES_DIR), creds, direction, '.md')
    result.pulled += r.pulled
    result.pushed += r.pushed
  } catch (e) {
    result.errors.push(`memory/entries 同步失败：${e.message}`)
    if (logger) logger.error('webdav.sync.error', 'memory/entries 同步失败', { error: e.message })
  }

  // 3. memory/index.json 按 id 并集合并
  try {
    const r = await syncMergedJson(joinUrl(base, `${MEMORY_DIR}/index.json`), path.join(dir, MEMORY_DIR, 'index.json'), creds, direction, 'id')
    result.pulled += r.pulled
    result.pushed += r.pushed
  } catch (e) {
    result.errors.push(`memory/index.json 同步失败：${e.message}`)
    if (logger) logger.error('webdav.sync.error', 'memory/index.json 同步失败', { error: e.message })
  }

  // 4. history.json 按 id 并集合并
  try {
    const r = await syncMergedJson(joinUrl(base, 'history.json'), path.join(dir, 'history.json'), creds, direction, 'id')
    result.pulled += r.pulled
    result.pushed += r.pushed
  } catch (e) {
    result.errors.push(`history.json 同步失败：${e.message}`)
    if (logger) logger.error('webdav.sync.error', 'history.json 同步失败', { error: e.message })
  }

  // 5. config.json 白名单合并
  try {
    const r = await syncConfig(joinUrl(base, 'config.json'), path.join(dir, 'config.json'), creds, direction)
    result.pulled += r.pulled
    result.pushed += r.pushed
  } catch (e) {
    result.errors.push(`config.json 同步失败：${e.message}`)
    if (logger) logger.error('webdav.sync.error', 'config.json 同步失败', { error: e.message })
  }

  // 写状态
  writeStatus(dir, {
    lastSync: new Date().toISOString(),
    direction,
    durationMs: Date.now() - t0,
    ...result,
  })
  if (logger) logger.info('webdav.sync.done', 'WebDAV 同步完成', { direction, durationMs: Date.now() - t0, ...result })

  return result
}

module.exports = {
  testConnection,
  syncAll,
  createBackup,
  listBackups,
  restoreBackup,
  readStatus,
  STATUS_FILE,
  _test: {
    normalizeWebdavBaseUrl,
    mergeJsonArraysById,
    syncFile,
    createBackupPayload,
    restorePayloadToLocal,
  },
}
