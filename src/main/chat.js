'use strict'
// @ts-check
/**
 * AI 对话问答：会话持久化（chats.json）+ RAG 检索 + 流式编排。
 *
 * RAG 上下文来源：记忆索引（memory.search，主）→ 历史报告 + 笔记关键词粗筛（兜底）。
 * memory 通过依赖注入（askStream 的 searchMemory 参数）传入，故本模块不直接 require ./memory，
 * 单测时无需加载 onnxruntime 等重依赖。
 */
const fs = require('fs')
const path = require('path')
const { isoDate } = require('./utils')
const notes = require('./notes')
const { createProvider } = require('./llm')
const { LLMAborted } = require('./llm/base')

const CHATS_FILE = 'chats.json'
const MAX_SNIPPET = 600 // 注入单条记录的正文上限（字符）
const MAX_SESSIONS = 100 // 会话保留上限

function newId(prefix) {
  return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
}

function truncate(s, n) {
  const t = String(s || '').trim()
  return t.length > n ? t.slice(0, n) + '…' : t
}

// ── 存储 ────────────────────────────────────────────────

function readChats(dir) {
  const file = path.join(dir, CHATS_FILE)
  try {
    if (fs.existsSync(file)) {
      const d = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (d && Array.isArray(d.sessions)) return d
    }
  } catch (e) {
    console.error('[weeklog] chats 读取失败：', e.message)
  }
  return { schemaVersion: 1, sessions: [] }
}

function writeChats(dir, data) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, CHATS_FILE), JSON.stringify(data, null, 2), 'utf8')
}

/** 会话列表（轻量元数据，不含 messages 全文），按 updatedAt 倒序 */
function listSessions(dir) {
  const data = readChats(dir)
  return data.sessions
    .slice()
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
    .map((s) => ({
      id: s.id,
      title: s.title,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      messageCount: (s.messages || []).length,
    }))
}

/** 单个会话完整内容（含 messages），不存在返回 null */
function getSession(dir, id) {
  const data = readChats(dir)
  return data.sessions.find((s) => s.id === id) || null
}

function createSession(dir, title) {
  const data = readChats(dir)
  const now = new Date().toISOString()
  const session = {
    id: newId('c'),
    title: (title && String(title).trim()) || '新对话',
    createdAt: now,
    updatedAt: now,
    messages: [],
  }
  data.sessions.unshift(session)
  data.sessions = data.sessions.slice(0, MAX_SESSIONS)
  writeChats(dir, data)
  return session
}

function renameSession(dir, id, title) {
  const data = readChats(dir)
  const s = data.sessions.find((x) => x.id === id)
  if (!s) return { ok: false }
  const next = String(title || '').trim()
  if (next) s.title = next
  s.updatedAt = new Date().toISOString()
  writeChats(dir, data)
  return { ok: true, title: s.title }
}

function deleteSession(dir, id) {
  const data = readChats(dir)
  const before = data.sessions.length
  data.sessions = data.sessions.filter((s) => s.id !== id)
  writeChats(dir, data)
  return { ok: data.sessions.length < before }
}

/** 追加一条消息；首条 user 消息自动作会话标题 */
function appendMessage(dir, sessionId, msg) {
  const data = readChats(dir)
  const s = data.sessions.find((x) => x.id === sessionId)
  if (!s) return null
  const saved = {
    id: msg.id || newId('msg'),
    role: msg.role,
    content: msg.content,
    createdAt: new Date().toISOString(),
  }
  if (msg.refs && msg.refs.length) saved.refs = msg.refs
  if (msg.reasoning) saved.reasoning = msg.reasoning
  if (msg.usage) saved.usage = msg.usage
  if (!Array.isArray(s.messages)) s.messages = []
  s.messages.push(saved)
  if ((!s.title || s.title === '新对话') && msg.role === 'user') {
    s.title = truncate(msg.content, 20) || s.title
  }
  s.updatedAt = saved.createdAt
  writeChats(dir, data)
  return saved
}

// ── RAG 检索 ────────────────────────────────────────────

/** 从 query 提取检索词：英文/数字词 + 中文 2-gram */
function keyTerms(query) {
  const q = String(query || '').toLowerCase()
  const terms = new Set()
  for (const w of q.split(/[^a-z0-9一-鿿]+/i)) {
    if (w && /[a-z0-9]/i.test(w) && w.length >= 2) terms.add(w)
  }
  const zh = q.replace(/[^一-鿿]/g, '')
  for (let i = 0; i + 2 <= zh.length; i++) terms.add(zh.slice(i, i + 2))
  return [...terms]
}

function countHits(text, terms) {
  const t = String(text || '').toLowerCase()
  let n = 0
  for (const term of terms) if (term && t.includes(term)) n++
  return n
}

function reportLabel(r) {
  const type = r.type === 'weekly' ? '周报' : r.type === 'daily' ? '日报' : r.type || '报告'
  const a = r.rangeStart || ''
  const b = r.rangeEnd || ''
  const range = a && b && a !== b ? `${a}~${b}` : a || b
  return `${type}${range ? ' ' + range : ''}`.trim()
}

/** 报告兜底：命中关键词的优先，否则取最近 limit 份 */
function pickReports(history, terms, limit) {
  const scored = (history || []).map((r) => ({ r, score: countHits(r.text, terms) }))
  const hit = scored.filter((x) => x.score > 0).sort((a, b) => b.score - a.score)
  return (hit.length ? hit : scored.slice(0, limit)).slice(0, limit).map((x) => x.r)
}

/** 笔记兜底：近 90 天，命中关键词优先，否则取最近 limit 条 */
function pickNotes(notesDir, cfg, terms, limit) {
  if (!notesDir) return []
  const to = new Date()
  const from = new Date()
  from.setDate(from.getDate() - 90)
  const misc = (cfg.notes && cfg.notes.miscProject) || '日常工作'
  let all = []
  try {
    all = notes.loadNotes(notesDir, isoDate(from), isoDate(to), misc)
  } catch {
    all = []
  }
  const scored = all.map((n) => ({ n, score: countHits(`${n.content} ${n.project || ''}`, terms) }))
  const hit = scored.filter((x) => x.score > 0).sort((a, b) => b.score - a.score)
  return (hit.length ? hit : scored.slice(-limit)).slice(0, limit).map((x) => x.n)
}

/**
 * 检索与 query 相关的工作上下文。
 * @param {object} p
 * @param {string} p.query
 * @param {object} p.cfg
 * @param {object[]} [p.history] 历史报告列表（倒序）
 * @param {string} [p.notesDir]
 * @param {number} [p.topK]
 * @param {(q:string,k:number)=>Promise<object[]>} [p.searchMemory] 记忆检索注入
 * @returns {Promise<{contextText:string, refs:object[]}>}
 */
async function retrieveContext({ query, cfg, history, notesDir, topK, searchMemory }) {
  const refs = []
  const blocks = []
  const k =
    topK || (cfg.ai && cfg.ai.chat && cfg.ai.chat.topK) || (cfg.memory && cfg.memory.topK) || 6

  // 主：记忆检索
  let hits = []
  if (searchMemory && cfg.memory && cfg.memory.enabled) {
    try {
      hits = await searchMemory(query, k)
    } catch (e) {
      console.warn('[weeklog] 对话记忆检索失败：', e.message)
    }
  }
  for (const h of hits || []) {
    const body = String(h.full || h.digest || '').trim()
    if (!body) continue
    refs.push({
      kind: 'memory',
      label: `${h.project || '记忆'}${h.date ? ' · ' + h.date : ''}`,
      date: h.date,
      project: h.project,
      snippet: truncate(body, 160),
    })
    blocks.push(`【记忆 · ${h.project || ''} ${h.date || ''}】\n${truncate(body, MAX_SNIPPET)}`)
  }

  // 兜底：记忆命中过少 → 报告 + 笔记关键词粗筛
  if (refs.length < 2) {
    const terms = keyTerms(query)
    for (const r of pickReports(history || [], terms, 3)) {
      const label = reportLabel(r)
      refs.push({ kind: 'report', label, date: r.rangeStart, snippet: truncate(r.text || '', 160) })
      blocks.push(`【报告 · ${label}】\n${truncate(r.text || '', MAX_SNIPPET)}`)
    }
    for (const n of pickNotes(notesDir, cfg, terms, 5)) {
      const label = `笔记 · ${n.date}${n.project ? ' · ' + n.project : ''}`
      refs.push({ kind: 'note', label, date: n.date, project: n.project, snippet: truncate(n.content, 160) })
      blocks.push(`【${label}】\n${truncate(n.content, MAX_SNIPPET)}`)
    }
  }

  return { contextText: blocks.join('\n\n'), refs }
}

const CHAT_SYSTEM_BASE = `你是 WeekLog 的工作助手，基于用户本地的 Git 工作记录、周报/日报与笔记回答问题。
规则：
- 优先依据下方「已知工作记录」回答；这些是用户真实的历史工作内容。
- 若已知记录不足以回答，如实说明「记录中暂无相关信息」，不要编造项目、日期或成果。
- 回答用简体中文，简洁专业；涉及代码时用 Markdown 代码块。`

function buildChatSystem(contextText) {
  if (!contextText || !contextText.trim()) {
    return (
      CHAT_SYSTEM_BASE +
      '\n\n【已知工作记录】\n（未检索到相关记录。可提示用户先生成报告或在设置中重建 AI 记忆，问答会更准确。）'
    )
  }
  return CHAT_SYSTEM_BASE + '\n\n【已知工作记录】\n' + contextText
}

/** 把会话历史转为 provider messages，截断到最近 turns 轮 */
function buildMessages(session, turns) {
  const all = ((session && session.messages) || []).filter(
    (m) => m.role === 'user' || m.role === 'assistant'
  )
  const limit = Math.max(2, (turns || 12) * 2)
  return all.slice(-limit).map((m) => ({ role: m.role, content: m.content }))
}

/**
 * 流式问答编排：落盘 user 消息 → RAG 检索 → 流式生成 → 落盘 assistant 消息。
 * 通过 onEvent 推送 { type: 'refs'|'delta'|'done'|'aborted'|'error', ... }。
 */
async function askStream({ dir, cfg, apiKey, sessionId, content, history, notesDir, searchMemory, onEvent, signal }) {
  const emit = (p) => {
    if (onEvent) onEvent(p)
  }

  const userMsg = appendMessage(dir, sessionId, { role: 'user', content })
  if (!userMsg) {
    emit({ type: 'error', message: '会话不存在' })
    return { error: '会话不存在' }
  }

  let ctx = { contextText: '', refs: [] }
  try {
    ctx = await retrieveContext({ query: content, cfg, history, notesDir, searchMemory })
  } catch (e) {
    console.warn('[weeklog] 对话上下文检索失败：', e.message)
  }
  emit({ type: 'refs', refs: ctx.refs })

  let provider
  try {
    provider = createProvider(cfg, apiKey)
  } catch (e) {
    emit({ type: 'error', message: e.message })
    return { error: e.message }
  }

  const session = getSession(dir, sessionId)
  const turns = (cfg.ai && cfg.ai.chat && cfg.ai.chat.historyTurns) || 12
  const msgs = buildMessages(session, turns)
  const system = buildChatSystem(ctx.contextText)
  const maxTokens = (cfg.ai && cfg.ai.chat && cfg.ai.chat.maxTokens) || undefined
  const thinking = !!(cfg.ai && cfg.ai.chat && cfg.ai.chat.thinking)

  let acc = ''
  let reasoningAcc = ''
  try {
    const res = await provider.streamChat(system, msgs, {
      signal,
      maxTokens,
      thinking,
      onDelta: (t) => {
        acc += t
        emit({ type: 'delta', text: t })
      },
      onThinking: (t) => {
        reasoningAcc += t
        emit({ type: 'thinking', text: t })
      },
    })
    const usage = { inputTokens: res.inputTokens, outputTokens: res.outputTokens, model: res.model }
    const saved = appendMessage(dir, sessionId, {
      role: 'assistant',
      content: res.text,
      refs: ctx.refs,
      reasoning: reasoningAcc || undefined,
      usage,
    })
    emit({ type: 'done', message: saved, usage })
    return { ok: true }
  } catch (e) {
    const aborted = e instanceof LLMAborted
    if (acc.trim() || reasoningAcc.trim()) {
      // 保留已生成的部分（正文 + 思考），避免用户丢失内容
      appendMessage(dir, sessionId, {
        role: 'assistant',
        content: acc + (aborted ? '\n\n_(已停止生成)_' : ''),
        refs: ctx.refs,
        reasoning: reasoningAcc || undefined,
      })
    }
    if (aborted) {
      emit({ type: 'aborted' })
      return { aborted: true }
    }
    emit({ type: 'error', message: (e && e.message) || '生成失败' })
    return { error: (e && e.message) || '生成失败' }
  }
}

// ── 报告生成意图解析 ───────────────────────────────────

const INTENT_SYSTEM = `你是 WeekLog 的意图解析器。判断用户消息是否要"生成一份日报或周报"，并解析参数。只输出 JSON，不要任何多余文字或解释。
输出格式：{"action":"generate"|"chat","reportType":"daily"|"weekly"|null,"rangeOpts":对象|null}
规则：
- action=generate 仅当用户明确要"生成/写/做一份"日报或周报；若只是提问、引用或讨论已有报告（如"上周周报里我说了啥"），则 action=chat。
- reportType：daily=日报，weekly=周报。
- rangeOpts 形态：
  - 今天日报 {"mode":"daily","date":"today"}；昨天 {"mode":"daily","date":"yesterday"}；指定日 {"mode":"daily","date":"YYYY-MM-DD"}
  - 本周周报 {}；上周 {"week":"last"}；指定范围 {"from":"YYYY-MM-DD","to":"YYYY-MM-DD"}
示例：
"帮我写本周周报" → {"action":"generate","reportType":"weekly","rangeOpts":{}}
"生成今天的日报" → {"action":"generate","reportType":"daily","rangeOpts":{"mode":"daily","date":"today"}}
"上周周报里我提到什么" → {"action":"chat","reportType":null,"rangeOpts":null}`

/** 纯正则预筛：是否疑似"生成日报/周报"请求（命中才值得调 LLM 细判） */
function looksLikeReportRequest(text) {
  const t = String(text || '')
  if (!/(日报|周报|月报)/.test(t)) return false
  return /(生成|写|做|出|来|帮我|整理|总结|搞|弄|给我|来一?份|来个)/.test(t)
}

/** 快捷钮语义时间 → rangeOpts（纯函数） */
function whenToRangeOpts(reportType, when) {
  if (reportType === 'daily') {
    return when === 'yesterday' ? { mode: 'daily', date: 'yesterday' } : { mode: 'daily', date: 'today' }
  }
  return when === 'last_week' ? { week: 'last' } : {}
}

/** 从 LLM 文本里抽第一个 JSON 对象 */
function parseIntentJson(text) {
  if (!text) return null
  const m = String(text).match(/\{[\s\S]*\}/)
  if (!m) return null
  try {
    return JSON.parse(m[0])
  } catch {
    return null
  }
}

/** LLM 结构化解析报告意图；任何异常/脏输出降级为 {action:'chat'} */
async function detectReportIntent({ cfg, apiKey, text, now }) {
  let res
  try {
    const provider = createProvider(cfg, apiKey)
    const today = isoDate(now || new Date())
    const ws = cfg.weekStart === 'sunday' ? '一周从周日开始' : '一周从周一开始'
    res = await provider.summarize(INTENT_SYSTEM, `今天是 ${today}，${ws}。\n用户消息：${text}`)
  } catch {
    return { action: 'chat' }
  }
  const parsed = parseIntentJson(res.text)
  if (!parsed || parsed.action !== 'generate') return { action: 'chat' }
  const reportType =
    parsed.reportType === 'daily' || parsed.reportType === 'weekly' ? parsed.reportType : null
  if (!reportType) return { action: 'chat' }
  const rangeOpts = parsed.rangeOpts && typeof parsed.rangeOpts === 'object' ? parsed.rangeOpts : {}
  return { action: 'generate', reportType, rangeOpts }
}

module.exports = {
  listSessions,
  getSession,
  createSession,
  renameSession,
  deleteSession,
  appendMessage,
  retrieveContext,
  buildChatSystem,
  buildMessages,
  keyTerms,
  askStream,
  looksLikeReportRequest,
  whenToRangeOpts,
  detectReportIntent,
}
