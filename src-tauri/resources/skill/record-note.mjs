#!/usr/bin/env node
// WeekLog AI 小记记录脚本（零 npm 依赖，纯 Node 内置模块，ESM）。
//
// 由各 AI agent（codex / claude code / zcode）的 weeklog-ai-note skill 在对话收尾时调用：
//  1. 定位本次会话 transcript（JSONL）。
//  2. 抽取「用户提问 + AI 回复」纯文本（剔除思考/工具调用/系统提示噪声）。
//  3. 采集 git 分支与改动文件。
//  4. 经 MCP（streamable-http）调用 WeekLog 的 submit_conversation 工具发回。
//
// WeekLog 端再用「小记总结模型」总结成一条中文小记入待处理池，由用户确认后写入笔记。
//
// 端点 + token + 来源 + 会话目录从同目录的 weeklog.json 读取（安装时写入）。

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

const MAX_TOTAL_CHARS = 24000
const MAX_MSG_CHARS = 8000

// ── 文本清洗 ──

// 需要整块剔除的包裹标签（思考/系统注入/记忆引用等噪声）。
const WRAPPER_TAGS = [
  'oai-mem-citation',
  'system-reminder',
  'think',
  'thinking',
  'reasoning',
  'claude-mem-context',
  'user_instructions',
  'environment_context',
  'app-context',
  'INSTRUCTIONS',
  'permissions instructions',
]

export function stripWrappers(text) {
  let s = String(text == null ? '' : text)
  for (const tag of WRAPPER_TAGS) {
    const re = new RegExp(`<${tag}>[\\s\\S]*?<\\/${tag}>`, 'gi')
    s = s.replace(re, '')
  }
  // Claude 斜杠命令展开标记
  s = s
    .replace(/<command-message>[\s\S]*?<\/command-message>/gi, '')
    .replace(/<command-name>[\s\S]*?<\/command-name>/gi, '')
    .replace(/<command-args>[\s\S]*?<\/command-args>/gi, '')
    .replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/gi, '')
  return s.replace(/\n{3,}/g, '\n\n').trim()
}

// 允许保留的文本类 block 类型；其余（thinking/reasoning_text/summary_text/tool_use/
// tool_result/image/input_image…）一律剔除，确保只留用户提问与 AI 回复正文。
const TEXT_BLOCK_TYPES = new Set(['text', 'input_text', 'output_text'])

// 从消息 content（字符串或 block 数组）抽取纯文本。
export function textFromContent(content) {
  if (content == null) return ''
  if (typeof content === 'string') return content.trim()
  if (Array.isArray(content)) {
    const parts = []
    for (const block of content) {
      if (block == null) continue
      if (typeof block === 'string') {
        if (block.trim()) parts.push(block.trim())
        continue
      }
      if (typeof block !== 'object') continue
      const type = String(block.type || '')
      if (TEXT_BLOCK_TYPES.has(type) && typeof block.text === 'string') {
        if (block.text.trim()) parts.push(block.text.trim())
      } else if (!type && typeof block.text === 'string') {
        if (block.text.trim()) parts.push(block.text.trim())
      }
    }
    return parts.join('\n').trim()
  }
  return ''
}

function normalizeRole(role) {
  const r = String(role || '').toLowerCase()
  if (r === 'user' || r === 'human') return 'user'
  if (r === 'assistant' || r === 'ai' || r === 'model') return 'assistant'
  return r
}

// 解析单行 JSONL 对象 → {role,text} 或 null（兼容 codex rollout 与 claude/zcode transcript）。
export function parseLine(obj) {
  if (!obj || typeof obj !== 'object') return null
  if (obj.isMeta === true || obj.isSidechain === true) return null
  const payload = obj.payload && typeof obj.payload === 'object' ? obj.payload : obj
  const msg = obj.message && typeof obj.message === 'object' ? obj.message
    : payload.message && typeof payload.message === 'object' ? payload.message
    : null
  const role = normalizeRole(
    (msg && msg.role) || payload.role || obj.role || (msg && msg.author) || ''
  )
  if (role !== 'user' && role !== 'assistant') return null
  const content = (msg && msg.content) ?? payload.content ?? obj.content ?? payload.text ?? obj.text
  const text = stripWrappers(textFromContent(content))
  if (!text) return null
  return { role, text }
}

// 从一份 transcript JSONL 文本抽取 user/assistant 消息序列。
export function extractMessages(jsonlText) {
  const out = []
  let bestArray = null
  for (const rawLine of String(jsonlText || '').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    let obj
    try {
      obj = JSON.parse(line)
    } catch {
      continue
    }
    const parsed = parseLine(obj)
    if (parsed) {
      // 折叠完全重复的相邻消息
      const last = out[out.length - 1]
      if (!last || last.role !== parsed.role || last.text !== parsed.text) out.push(parsed)
      continue
    }
    // 兜底：model-io 风格日志里可能带完整 messages 数组
    const arr = (obj && (obj.messages || (obj.request && obj.request.messages) || (obj.body && obj.body.messages) || obj.input))
    if (Array.isArray(arr) && (!bestArray || arr.length > bestArray.length)) {
      const mapped = arr
        .map((m) => parseLine(m && typeof m === 'object' ? m : {}))
        .filter(Boolean)
      if (mapped.length) bestArray = mapped
    }
  }
  if (out.length >= 2) return out
  if (bestArray && bestArray.length > out.length) return bestArray
  return out
}

// 按总字符上限保留最近的消息（保持原顺序）；单条超长则截断。
export function capMessages(messages, maxTotal = MAX_TOTAL_CHARS, maxMsg = MAX_MSG_CHARS) {
  const trimmed = messages.map((m) => ({
    role: m.role,
    text: m.text.length > maxMsg ? m.text.slice(0, maxMsg - 1) + '…' : m.text,
  }))
  const kept = []
  let total = 0
  for (let i = trimmed.length - 1; i >= 0; i--) {
    const len = trimmed[i].text.length
    if (kept.length && total + len > maxTotal) break
    kept.push(trimmed[i])
    total += len
  }
  kept.reverse()
  return kept
}

// ── transcript 定位 ──

function expandHome(p) {
  if (!p) return p
  if (p === '~') return os.homedir()
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2))
  return p
}

function collectJsonl(dir, out, depth = 0) {
  if (depth > 4 || out.length > 4000) return
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const ent of entries) {
    const full = path.join(dir, ent.name)
    try {
      if (ent.isDirectory()) {
        collectJsonl(full, out, depth + 1)
      } else if (ent.isFile() && ent.name.endsWith('.jsonl')) {
        out.push({ file: full, mtime: fs.statSync(full).mtimeMs })
      }
    } catch {
      // ignore unreadable entries
    }
  }
}

// 读取 transcript 头部若干行，尝试取出会话的 cwd（claude 行含 cwd；codex session_meta.payload.cwd）。
function transcriptCwd(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8')
    let count = 0
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue
      if (++count > 120) break
      let obj
      try {
        obj = JSON.parse(line)
      } catch {
        continue
      }
      const cwd = obj.cwd || (obj.payload && obj.payload.cwd) || (obj.payload && obj.payload.cwd)
      if (typeof cwd === 'string' && cwd) return cwd
    }
  } catch {
    // ignore
  }
  return ''
}

export function claudeSlug(cwd) {
  return String(cwd || '').replace(/[^a-zA-Z0-9]/g, '-')
}

function findTranscript(cfg, cwd) {
  const dirs = Array.isArray(cfg.sessionsDirs) ? cfg.sessionsDirs : []
  const candidates = []
  const slug = claudeSlug(cwd)
  for (const d of dirs) {
    const dir = expandHome(d)
    if (!dir) continue
    const slugDir = path.join(dir, slug)
    if (fs.existsSync(slugDir)) collectJsonl(slugDir, candidates)
    collectJsonl(dir, candidates)
  }
  if (!candidates.length) return ''
  // 去重
  const seen = new Set()
  const uniq = candidates.filter((c) => (seen.has(c.file) ? false : (seen.add(c.file), true)))
  uniq.sort((a, b) => b.mtime - a.mtime)
  const recent = uniq.filter((c) => Date.now() - c.mtime < 24 * 3600 * 1000)
  const pool = recent.length ? recent : uniq
  // 优先 cwd 精确匹配（仅检查最近的若干个，避免读太多大文件）
  for (const c of pool.slice(0, 8)) {
    if (transcriptCwd(c.file) === cwd) return c.file
  }
  return pool[0].file
}

// ── git 元信息 ──

function git(args, cwd) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1500,
    }).trim()
  } catch {
    return ''
  }
}

function gitBranch(cwd) {
  return git(['branch', '--show-current'], cwd) || git(['rev-parse', '--short', 'HEAD'], cwd)
}

function gitChangedFiles(cwd) {
  const diff = git(['diff', '--name-only', 'HEAD'], cwd)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
  const status = git(['status', '--short'], cwd)
    .split(/\r?\n/)
    .map((l) => l.slice(3).trim())
    .filter(Boolean)
  return Array.from(new Set([...diff, ...status])).slice(0, 80)
}

function firstUserSnippet(messages) {
  const first = messages.find((m) => m.role === 'user')
  if (!first) return ''
  const oneLine = first.text.replace(/\s+/g, ' ').trim()
  return oneLine.length > 80 ? oneLine.slice(0, 80) + '…' : oneLine
}

// ── 最小 MCP streamable-http 客户端 ──

function parseRpc(text, contentType) {
  const t = String(text || '').trim()
  if (!t) return null
  const ct = String(contentType || '')
  if (!ct.includes('event-stream')) {
    try {
      return JSON.parse(t)
    } catch {
      // 落到 SSE 解析
    }
  }
  const datas = []
  let cur = []
  for (const line of t.split(/\r?\n/)) {
    if (line.startsWith('data:')) {
      cur.push(line.slice(5).replace(/^ /, ''))
    } else if (line.trim() === '') {
      if (cur.length) {
        datas.push(cur.join('\n'))
        cur = []
      }
    }
  }
  if (cur.length) datas.push(cur.join('\n'))
  for (const d of datas) {
    try {
      const o = JSON.parse(d)
      if (o && (o.result !== undefined || o.error !== undefined || o.id !== undefined)) return o
    } catch {
      // ignore
    }
  }
  try {
    return JSON.parse(t)
  } catch {
    return null
  }
}

async function safeText(res) {
  try {
    return await res.text()
  } catch {
    return ''
  }
}

async function mcpSubmit(endpoint, token, args) {
  const baseHeaders = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    Authorization: 'Bearer ' + token,
  }
  const initRes = await fetch(endpoint, {
    method: 'POST',
    headers: baseHeaders,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'weeklog-record-note', version: '1.0.0' },
      },
    }),
  })
  if (!initRes.ok) throw new Error('initialize 失败 ' + initRes.status + '：' + (await safeText(initRes)))
  const sessionId = initRes.headers.get('mcp-session-id') || ''
  const initData = parseRpc(await initRes.text(), initRes.headers.get('content-type') || '')
  const protocolVersion = (initData && initData.result && initData.result.protocolVersion) || '2025-03-26'

  const headers = { ...baseHeaders, 'MCP-Protocol-Version': protocolVersion }
  if (sessionId) headers['Mcp-Session-Id'] = sessionId

  await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  }).catch(() => {})

  const callRes = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'submit_conversation', arguments: args },
    }),
  })
  if (!callRes.ok) throw new Error('tools/call 失败 ' + callRes.status + '：' + (await safeText(callRes)))
  const data = parseRpc(await callRes.text(), callRes.headers.get('content-type') || '')
  if (data && data.error) throw new Error('MCP 错误：' + JSON.stringify(data.error))
  return data && data.result
}

// ── CLI ──

function loadConfig() {
  const file = path.join(HERE, 'weeklog.json')
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return {}
  }
}

function parseArgv(argv = process.argv.slice(2)) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dry-run') out.dryRun = true
    else if (a === '--transcript') out.transcript = argv[++i]
    else if (a === '--cwd') out.cwd = argv[++i]
    else if (a === '--source') out.source = argv[++i]
    else if (a === '--text') out.text = argv[++i]
  }
  return out
}

function readSafe(file) {
  try {
    const stat = fs.statSync(file)
    if (!stat.isFile() || stat.size > 50 * 1024 * 1024) return ''
    return fs.readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

async function main() {
  const cfg = loadConfig()
  const args = parseArgv()
  const cwd = args.cwd || process.cwd()

  let messages = []
  if (args.text) {
    messages = [{ role: 'user', text: String(args.text) }]
  } else {
    const transcript = args.transcript || (cfg.transcript ? expandHome(cfg.transcript) : '') || findTranscript(cfg, cwd)
    if (transcript) messages = extractMessages(readSafe(transcript))
  }
  messages = capMessages(messages)
  if (!messages.length) {
    console.error('[weeklog] 未找到可用对话内容，已跳过本次小记。')
    process.exit(0)
  }

  const payload = {
    source: args.source || cfg.source || 'ai',
    cwd,
    branch: gitBranch(cwd),
    changedFiles: gitChangedFiles(cwd),
    title: firstUserSnippet(messages),
    messages,
  }

  if (args.dryRun) {
    console.log(JSON.stringify(payload, null, 2))
    return
  }

  if (!cfg.endpoint || !cfg.token) {
    console.error('[weeklog] 缺少 endpoint/token（weeklog.json 未正确安装），已跳过。')
    process.exit(0)
  }

  const result = await mcpSubmit(cfg.endpoint, cfg.token, payload)
  const content = result && result.content && result.content[0] && result.content[0].text
  console.log('[weeklog] 已提交小记：' + (content || JSON.stringify(result || {})))
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (invokedDirectly) {
  main().catch((e) => {
    console.error('[weeklog] 提交失败：' + (e && e.message ? e.message : e))
    process.exit(0)
  })
}
