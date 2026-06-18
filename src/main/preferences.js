'use strict'
// @ts-check
/**
 * 写作偏好库：独立于 memory 存储，避免污染 inferProject 与聊天 RAG。
 * 存储于 userData/preferences.json，结构 { items: [{ id, rule, enabled, createdAt }] }。
 * 启用项（enabled=true）会在报告生成时注入系统提示词。
 */
const fs = require('fs')
const path = require('path')

const FILE = 'preferences.json'

function prefsPath(dir) {
  return path.join(dir, FILE)
}

function readPrefs(dir) {
  try {
    const file = prefsPath(dir)
    if (fs.existsSync(file)) {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'))
      return data && Array.isArray(data.items) ? data.items : []
    }
  } catch (e) {
    console.error('[weeklog] preferences 读取失败：', e.message)
  }
  return []
}

function writePrefs(dir, items) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(prefsPath(dir), JSON.stringify({ items }, null, 2), 'utf8')
}

function newId() {
  return 'pf_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
}

/** 列出全部偏好（含禁用项） */
function listPreferences(dir) {
  return readPrefs(dir)
}

/** 仅返回启用的规则文本，供注入系统提示词 */
function enabledRules(dir) {
  return readPrefs(dir).filter((p) => p && p.enabled && p.rule && p.rule.trim()).map((p) => p.rule.trim())
}

/** 新增一条偏好规则 */
function addPreference(dir, rule) {
  const text = String(rule || '').trim()
  if (!text) return null
  const items = readPrefs(dir)
  const item = { id: newId(), rule: text, enabled: true, createdAt: new Date().toISOString() }
  items.unshift(item)
  writePrefs(dir, items)
  return item
}

/** 切换启用/禁用 */
function togglePreference(dir, id, enabled) {
  const items = readPrefs(dir)
  const item = items.find((p) => p.id === id)
  if (!item) return null
  item.enabled = !!enabled
  writePrefs(dir, items)
  return item
}

/** 删除 */
function removePreference(dir, id) {
  const items = readPrefs(dir)
  const next = items.filter((p) => p.id !== id)
  writePrefs(dir, next)
  return { deleted: items.length - next.length }
}

// ── AI 抽取规则：对比修改前后文本，提炼一条写作偏好 ──

const EXTRACT_SYSTEM = `你是一名写作偏好提炼助手。
用户对一份工作周报/日报做了人工修改。请对比"修改前"与"修改后"两段文本，提炼出一条通用、可复用的中文写作规则。
要求：
1. 聚焦"用户希望 AI 今后如何写作"，而非本次具体内容（例：用「灰度发布」代替「上线」；不要以「完成了」开头；语气更口语化）。
2. 若修改仅是增删具体工作内容（非风格/措辞调整），返回「无」。
3. 规则要简短（一句话）、可执行、通用化。
4. 只输出规则本身这一句话，不要解释、不要前缀、不要引号。若判定为无则只输出「无」。`

function buildExtractPrompt(oldText, newText) {
  return [
    '请对比以下两段工作周报/日报文本，提炼一条通用写作偏好规则。',
    '',
    '【修改前】',
    String(oldText || '').trim(),
    '',
    '【修改后】',
    String(newText || '').trim(),
  ].join('\n')
}

/**
 * AI 抽取写作规则。
 * @param {{ oldText: string; newText: string; provider?: any }} opts
 * @returns {Promise<{ rule?: string; model?: string; inputTokens?: number; outputTokens?: number; error?: string }>}
 */
async function extractRuleFromDiff({ oldText, newText, provider } = {}) {
  if (!provider || typeof provider.summarize !== 'function') {
    return { error: '未提供 AI provider' }
  }
  if (!String(oldText || '').trim() || !String(newText || '').trim()) {
    return { rule: '' }
  }
  try {
    const result = await provider.summarize(EXTRACT_SYSTEM, buildExtractPrompt(oldText, newText))
    const rule = String((result && result.text) || '').trim()
    // 「无」或过短视为无可提炼规则
    if (!rule || /^无$/.test(rule)) return { rule: '' }
    return {
      rule,
      model: result && result.model,
      inputTokens: result && result.inputTokens,
      outputTokens: result && result.outputTokens,
    }
  } catch (e) {
    return { error: (e && e.message) || '抽取失败' }
  }
}

module.exports = {
  listPreferences,
  enabledRules,
  addPreference,
  togglePreference,
  removePreference,
  extractRuleFromDiff,
  EXTRACT_SYSTEM,
}
