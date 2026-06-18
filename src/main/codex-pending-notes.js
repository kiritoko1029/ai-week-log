'use strict'
// @ts-check
/**
 * Codex hook 待处理小记池。
 *
 * Hook 只把候选小记写入本池；正式 notes/YYYY-MM-DD.md 写入必须由用户确认触发。
 */
const fs = require('fs')
const path = require('path')
const notes = require('./notes')
const { isoDate } = require('./utils')
const { sanitizeCodexSummary } = require('./codex-summary')

const FILE = 'codex-notes-pending.json'
const MAX_SUMMARY_LENGTH = 4000
const MAX_CHANGED_FILES = 80

function filePath(dir) {
  return path.join(dir, FILE)
}

function newId() {
  return 'cpn_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

function readStore(dir) {
  try {
    const file = filePath(dir)
    if (fs.existsSync(file)) {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (data && Array.isArray(data.items)) {
        return {
          ...data,
          items: data.items
            .map(normalizeStoredItem)
            .filter((item) => !item || item.status !== 'pending' || item.summary),
        }
      }
    }
  } catch (e) {
    console.error('[weeklog] Codex 待处理小记读取失败：', e.message)
  }
  return { schemaVersion: 1, items: [] }
}

function writeStore(dir, data) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(filePath(dir), JSON.stringify(data, null, 2), 'utf8')
}

function normalizeIso(input) {
  const d = input ? new Date(input) : new Date()
  if (Number.isNaN(d.getTime())) return new Date().toISOString()
  return d.toISOString()
}

function truncate(input, limit) {
  const text = String(input || '').trim()
  return text.length > limit ? text.slice(0, limit) : text
}

function normalizeChangedFiles(files) {
  if (!Array.isArray(files)) return []
  const seen = new Set()
  const out = []
  for (const item of files) {
    const value = typeof item === 'string' ? item.trim() : ''
    if (!value || seen.has(value)) continue
    seen.add(value)
    out.push(value)
    if (out.length >= MAX_CHANGED_FILES) break
  }
  return out
}

function normalizeCwd(cwd) {
  return String(cwd || '').trim()
}

function matchProject(cwd, cfg = {}) {
  const target = normalizeCwd(cwd)
  const repos = Array.isArray(cfg.repos) ? cfg.repos : []
  if (!target) return ''
  let best = null
  for (const repo of repos) {
    const repoPath = normalizeCwd(repo && repo.path)
    if (!repoPath) continue
    const normalizedRepo = path.resolve(repoPath)
    let normalizedTarget = target
    try {
      normalizedTarget = path.resolve(target)
    } catch {}
    const isMatch = normalizedTarget === normalizedRepo || normalizedTarget.startsWith(normalizedRepo + path.sep)
    if (!isMatch) continue
    if (!best || normalizedRepo.length > best.path.length) {
      best = { path: normalizedRepo, name: repo.name || repo.alias || path.basename(normalizedRepo) }
    }
  }
  return best ? best.name : (target ? path.basename(target) : '')
}

function normalizePayload(payload = {}, cfg = {}) {
  const summary = sanitizeCodexSummary(payload.summary || payload.content || payload.text)
  if (!summary) throw new Error('summary 不能为空')
  const cwd = normalizeCwd(payload.cwd)
  const createdAt = normalizeIso(payload.finishedAt || payload.createdAt)
  return {
    id: newId(),
    source: 'codex',
    status: 'pending',
    cwd,
    project: truncate(payload.project, 160) || matchProject(cwd, cfg),
    summary,
    branch: truncate(payload.branch, 160),
    changedFiles: normalizeChangedFiles(payload.changedFiles),
    title: truncate(payload.title, 200),
    createdAt,
  }
}

function normalizeStoredItem(item) {
  if (!item || typeof item !== 'object') return item
  return {
    ...item,
    summary: sanitizeCodexSummary(item.summary),
  }
}

function listPendingNotes(dir, { includeAll = false } = {}) {
  const data = readStore(dir)
  const items = includeAll ? data.items : data.items.filter((item) => item.status === 'pending')
  return items.slice().sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
}

function addPendingNote(dir, payload, cfg) {
  const data = readStore(dir)
  const item = normalizePayload(payload, cfg)
  data.items.unshift(item)
  writeStore(dir, data)
  return item
}

function updateStatus(dir, ids, status, extra = {}) {
  const wanted = new Set((ids || []).filter(Boolean))
  const data = readStore(dir)
  let count = 0
  for (const item of data.items) {
    if (!wanted.has(item.id) || item.status !== 'pending') continue
    item.status = status
    Object.assign(item, extra)
    count++
  }
  writeStore(dir, data)
  return count
}

function deletePendingNotes(dir, ids) {
  const deletedAt = new Date().toISOString()
  return { deleted: updateStatus(dir, ids, 'deleted', { deletedAt }) }
}

function dateFromCreatedAt(createdAt) {
  return isoDate(new Date(createdAt || Date.now()))
}

function contentForItem(item) {
  const files = Array.isArray(item.changedFiles) && item.changedFiles.length
    ? `（Codex 自动小记；分支：${item.branch || '未知'}；改动文件：${item.changedFiles.slice(0, 6).join('、')}${item.changedFiles.length > 6 ? ` 等 ${item.changedFiles.length} 个` : ''}）`
    : ''
  return [item.summary, files].filter(Boolean).join('\n')
}

function writePendingNotes(dir, { ids, notesDir, miscProject = '日常工作', project, content } = {}) {
  const wanted = new Set((ids || []).filter(Boolean))
  const data = readStore(dir)
  const now = new Date().toISOString()
  let written = 0
  const files = []
  const selected = data.items.filter((item) => wanted.has(item.id) && item.status === 'pending')
  const customContent = content != null ? String(content).trim() : ''
  if (customContent && selected.length) {
    const first = selected.slice().sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')))[0]
    const file = notes.appendNote(notesDir, dateFromCreatedAt(first.createdAt), project != null ? project : first.project, customContent, miscProject)
    files.push(file)
    for (const item of selected) {
      item.status = 'written'
      item.writtenAt = now
      item.noteFile = file
      written++
    }
    writeStore(dir, data)
    return { written, files }
  }
  for (const item of selected) {
    const file = notes.appendNote(notesDir, dateFromCreatedAt(item.createdAt), project != null ? project : item.project, contentForItem(item), miscProject)
    item.status = 'written'
    item.writtenAt = now
    item.noteFile = file
    written++
    files.push(file)
  }
  writeStore(dir, data)
  return { written, files }
}

const SUMMARY_SYSTEM = `你是一名研发工作小记整理助手。
请把多条 Codex 候选小记合并成一条适合写入日报/周报素材的中文小记。
要求：客观、简洁、书面化；保留真实完成事项和价值；不要编造未提供的信息。
直接输出小记内容本身，不要标题、不要解释、不要项目名前缀。`

function buildSummaryPrompt(items) {
  const lines = ['请整理以下 Codex 待处理小记：', '']
  items.forEach((item, index) => {
    lines.push(`${index + 1}. ${item.summary}`)
    const meta = []
    if (item.project) meta.push(`项目：${item.project}`)
    if (item.branch) meta.push(`分支：${item.branch}`)
    if (item.changedFiles && item.changedFiles.length) meta.push(`文件：${item.changedFiles.slice(0, 8).join('、')}`)
    if (meta.length) lines.push(`   ${meta.join('；')}`)
  })
  lines.push('', '请输出一条可直接写入工作小记的中文内容。')
  return lines.join('\n')
}

async function summarizePendingNotes(dir, { ids, provider } = {}) {
  if (!provider || typeof provider.summarize !== 'function') throw new Error('未提供 AI provider')
  const wanted = new Set((ids || []).filter(Boolean))
  const items = readStore(dir).items.filter((item) => item.status === 'pending' && wanted.has(item.id))
  if (!items.length) return { text: '', model: '' }
  const result = await provider.summarize(SUMMARY_SYSTEM, buildSummaryPrompt(items))
  return {
    text: String((result && result.text) || '').trim(),
    model: result && result.model,
    inputTokens: result && result.inputTokens,
    outputTokens: result && result.outputTokens,
  }
}

module.exports = {
  FILE,
  filePath,
  readStore,
  writeStore,
  listPendingNotes,
  addPendingNote,
  deletePendingNotes,
  writePendingNotes,
  summarizePendingNotes,
  _test: {
    normalizePayload,
    matchProject,
    buildSummaryPrompt,
    SUMMARY_SYSTEM,
  },
}
