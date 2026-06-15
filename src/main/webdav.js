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

const NOTES_DIR = 'notes'
const MEMORY_DIR = 'memory'
const MEMORY_ENTRIES_DIR = 'memory/entries'
const STATUS_FILE = 'webdav-status.json'

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

async function davRequest(method, url, { username, password, headers = {}, body = null, expect = [200, 204] } = {}) {
  const res = await fetch(url, {
    method,
    headers: { Authorization: basicAuth(username, password), ...headers },
    body,
  })
  if (!expect.includes(res.status)) {
    const text = await res.text().catch(() => '')
    throw new Error(`WebDAV ${method} ${url} → ${res.status}: ${text.slice(0, 200)}`)
  }
  return res
}

/** PROPFIND depth:1 列出目录下的直接子项。返回 [{href, displayName, isCollection, size, lastModified}] */
async function propfind(url, { username, password }) {
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
  if (res.status !== 207 && res.status !== 200) {
    const text = await res.text().catch(() => '')
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
  // 先 PROPFIND 确认是否已存在
  try {
    await propfind(url.endsWith('/') ? url : url + '/', creds)
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
      continue // 已存在，下一级
    } catch {}
    // 不存在则 MKCOL
    const res = await fetch(cur + '/', {
      method: 'MKCOL',
      headers: { Authorization: basicAuth(creds.username, creds.password) },
    })
    if (res.status === 201) {
      createdAny = true
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
  const res = await fetch(url, { headers: { Authorization: basicAuth(creds.username, creds.password) } })
  if (res.status === 404) return null
  if (res.status !== 200) {
    const text = await res.text().catch(() => '')
    throw new Error(`GET ${url} → ${res.status}: ${text.slice(0, 200)}`)
  }
  return await res.text()
}

async function davPut(url, creds, content) {
  await davRequest('PUT', url, {
    ...creds,
    body: content,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    expect: [200, 201, 204],
  })
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
  const wantPull = direction === 'pull' || direction === 'both'
  const wantPush = direction === 'push' || direction === 'both'

  if (wantPull) {
    const remote = await davGet(remoteUrl, creds)
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
    const remote = wantPull ? readLocalFile(localPath) : await davGet(remoteUrl, creds) // 拉取后本地即最新
    if (local !== null && local !== remote) {
      await davPut(remoteUrl, creds, local)
      result = result === 'pulled' ? 'both' : 'pushed'
    }
  }

  return result
}

// ── 同步目录：列出两边文件，逐一同步 ──

async function syncDirectory(remoteBase, localDir, creds, direction, ext) {
  let pulled = 0
  let pushed = 0

  // 远端列表
  let remoteFiles = []
  try {
    const items = await propfind(remoteBase, creds)
    remoteFiles = items.filter((i) => !i.isCollection && (!ext || i.displayName.endsWith(ext)))
  } catch (e) {
    // 远端目录不存在：若要 push 则创建
    if (wantPush(direction)) {
      await ensureCollection(remoteBase, creds)
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
    }
  }
  return { pulled, pushed }
}

function wantPush(direction) {
  return direction === 'push' || direction === 'both'
}
function wantPull(direction) {
  return direction === 'pull' || direction === 'both'
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
  ['ui', 'theme'],
  ['ai', 'provider'],
  ['ai', 'maxInputTokens'],
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

  return { pulled, pushed }
}

// ── 测试连接 ──

async function testConnection({ url, username, password }) {
  try {
    const base = normalizeWebdavBaseUrl(url)
    const creds = { username, password }
    // 1) 先 PROPFIND 看根路径（/dav/）是否可达 + 凭证是否正确
    //    目的：早暴露认证/网络问题，且不依赖目标目录已存在
    try {
      const items = await propfind(base, creds)
      return { ok: true, message: `连接成功，远端有 ${items.length} 个项目` }
    } catch (e) {
      // 目标目录不存在（404）→ 尝试自动创建，再验证
      const msg = String(e.message || '')
      if (msg.includes('404')) {
        try {
          const r = await ensureCollection(base, creds)
          if (r.created) {
            return { ok: true, message: `连接成功，已自动创建远端目录 ${base}` }
          }
          // created=false 但没报错：可能并发已存在，再 PROPFIND 确认
          const items = await propfind(base, creds)
          return { ok: true, message: `连接成功，远端有 ${items.length} 个项目` }
        } catch (e2) {
          return { ok: false, message: `目标目录不存在且自动创建失败：${e2.message}` }
        }
      }
      // 其它错误（401/403/网络）原样返回
      return { ok: false, message: msg }
    }
  } catch (e) {
    return { ok: false, message: e.message }
  }
}

// ── 主同步入口 ──

async function syncAll({ cfg, dir, password, direction = 'both' }) {
  const wcfg = cfg.webdav || {}
  const url = normalizeWebdavBaseUrl(wcfg.url || '')
  const username = wcfg.username || ''
  const creds = { username, password }
  const base = url

  const result = { pulled: 0, pushed: 0, errors: [] }
  const t0 = Date.now()

  // 确保远端目录结构
  try {
    await ensureCollection(base, creds)
    await ensureCollection(joinUrl(base, NOTES_DIR), creds)
    await ensureCollection(joinUrl(base, MEMORY_DIR), creds)
    await ensureCollection(joinUrl(base, MEMORY_ENTRIES_DIR), creds)
  } catch (e) {
    result.errors.push(`创建远端目录失败：${e.message}`)
  }

  // 1. notes/ 目录同步（按日期文件名）
  try {
    const r = await syncDirectory(joinUrl(base, NOTES_DIR), path.join(dir, NOTES_DIR), creds, direction, '.md')
    result.pulled += r.pulled
    result.pushed += r.pushed
  } catch (e) {
    result.errors.push(`notes 同步失败：${e.message}`)
  }

  // 2. memory/entries/ 目录同步
  try {
    const r = await syncDirectory(joinUrl(base, MEMORY_ENTRIES_DIR), path.join(dir, MEMORY_ENTRIES_DIR), creds, direction, '.md')
    result.pulled += r.pulled
    result.pushed += r.pushed
  } catch (e) {
    result.errors.push(`memory/entries 同步失败：${e.message}`)
  }

  // 3. memory/index.json 按 id 并集合并
  try {
    const r = await syncMergedJson(joinUrl(base, `${MEMORY_DIR}/index.json`), path.join(dir, MEMORY_DIR, 'index.json'), creds, direction, 'id')
    result.pulled += r.pulled
    result.pushed += r.pushed
  } catch (e) {
    result.errors.push(`memory/index.json 同步失败：${e.message}`)
  }

  // 4. history.json 按 id 并集合并
  try {
    const r = await syncMergedJson(joinUrl(base, 'history.json'), path.join(dir, 'history.json'), creds, direction, 'id')
    result.pulled += r.pulled
    result.pushed += r.pushed
  } catch (e) {
    result.errors.push(`history.json 同步失败：${e.message}`)
  }

  // 5. config.json 白名单合并
  try {
    const r = await syncConfig(joinUrl(base, 'config.json'), path.join(dir, 'config.json'), creds, direction)
    result.pulled += r.pulled
    result.pushed += r.pushed
  } catch (e) {
    result.errors.push(`config.json 同步失败：${e.message}`)
  }

  // 写状态
  writeStatus(dir, {
    lastSync: new Date().toISOString(),
    direction,
    durationMs: Date.now() - t0,
    ...result,
  })

  return result
}

module.exports = {
  testConnection,
  syncAll,
  readStatus,
  STATUS_FILE,
  _test: {
    normalizeWebdavBaseUrl,
    mergeJsonArraysById,
  },
}
