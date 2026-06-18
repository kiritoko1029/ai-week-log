'use strict'
// @ts-check
/**
 * 笔记模块：按天 Markdown 文件存储（notes/YYYY-MM-DD.md）。
 * 用 `## 项目名` 二级标题分段；miscProject 段或无标题内容为"通用笔记"（project=null）。
 */
const fs = require('fs')
const path = require('path')
const { isoDate, parseDateInput } = require('./utils')

function noteFilePath(notesDir, dateStr) {
  return path.join(notesDir, `${dateStr}.md`)
}

/** 遍历 [from, to]（含）的每个日期字符串 */
function* iterateDates(fromStr, toStr) {
  const from = parseDateInput(fromStr)
  const to = parseDateInput(toStr)
  const cur = new Date(from)
  cur.setHours(0, 0, 0, 0)
  const end = new Date(to)
  end.setHours(0, 0, 0, 0)
  while (cur <= end) {
    yield isoDate(cur)
    cur.setDate(cur.getDate() + 1)
  }
}

/**
 * 解析单篇笔记文本为 Note[]。
 * @param {string} text
 * @param {string} dateStr
 * @param {string} miscProject
 * @param {string} source
 */
function parseNoteText(text, dateStr, miscProject, source) {
  const notes = []
  if (!text || !text.trim()) return notes
  const lines = text.split(/\r?\n/)
  let currentHeading = miscProject // 顶部无标题内容视为通用
  let buffer = []
  const flush = () => {
    const content = buffer.join('\n').trim()
    if (content) {
      const isMisc = currentHeading === miscProject
      notes.push({
        date: dateStr,
        project: isMisc ? null : currentHeading.trim(),
        content,
        source,
      })
    }
    buffer = []
  }
  for (const line of lines) {
    const m = /^##\s+(.+?)\s*$/.exec(line)
    if (m) {
      flush()
      currentHeading = m[1].trim()
    } else {
      buffer.push(line)
    }
  }
  flush()
  return notes
}

/** 读取区间内所有笔记 */
function loadNotes(notesDir, fromStr, toStr, miscProject = '日常工作') {
  const out = []
  if (!fs.existsSync(notesDir)) return out
  for (const dateStr of iterateDates(fromStr, toStr)) {
    const file = noteFilePath(notesDir, dateStr)
    if (!fs.existsSync(file)) continue
    try {
      const text = fs.readFileSync(file, 'utf8')
      out.push(...parseNoteText(text, dateStr, miscProject, `notes/${dateStr}.md`))
    } catch (err) {
      // 单文件损坏不阻断
      console.error(`[weeklog] 笔记解析失败 ${file}：`, err.message)
    }
  }
  return out
}

/** 读取某天笔记原文（编辑器用） */
function getNoteText(notesDir, dateStr) {
  const file = noteFilePath(notesDir, dateStr)
  if (!fs.existsSync(file)) return ''
  return fs.readFileSync(file, 'utf8')
}

/** 保存某天笔记原文（编辑器用） */
function saveNoteText(notesDir, dateStr, text) {
  if (!fs.existsSync(notesDir)) fs.mkdirSync(notesDir, { recursive: true })
  fs.writeFileSync(noteFilePath(notesDir, dateStr), text || '', 'utf8')
}

/**
 * 向某天笔记追加一条。
 * project 为空或等于 miscProject → 写入 `## miscProject` 段；否则写入 `## project` 段。
 */
function appendNote(notesDir, dateStr, project, content, miscProject = '日常工作') {
  if (!fs.existsSync(notesDir)) fs.mkdirSync(notesDir, { recursive: true })
  const file = noteFilePath(notesDir, dateStr)
  const heading = !project || project === miscProject ? miscProject : project
  const line = (content || '').trim()
  if (!line) return file
  let text = ''
  if (fs.existsSync(file)) text = fs.readFileSync(file, 'utf8')
  text = appendSegment(text, heading, line)
  fs.writeFileSync(file, text, 'utf8')
  return file
}

/** 在文本中指定 heading 段追加一行；段不存在则新建 */
function appendSegment(text, heading, line) {
  const lines = (text || '').split(/\r?\n/)
  const headIdx = lines.findIndex((l) => /^##\s+/.test(l) && l.replace(/^##\s+/, '').trim() === heading)
  if (headIdx >= 0) {
    // 找到该段下一段 `## ` 的位置，在其前插入
    let insertAt = headIdx + 1
    while (insertAt < lines.length && !/^##\s+/.test(lines[insertAt])) insertAt++
    // 跳过段尾空行
    let p = insertAt
    while (p - 1 > headIdx && lines[p - 1].trim() === '') p--
    lines.splice(p, 0, line)
    return lines.join('\n')
  }
  // 段不存在：追加到文件末尾
  const suffix = (text && !text.endsWith('\n') ? '\n' : '') + `\n## ${heading}\n${line}\n`
  return (text || '') + suffix
}

/** 统计某天笔记条数 */
function countNotes(notesDir, dateStr, miscProject) {
  const text = getNoteText(notesDir, dateStr)
  return parseNoteText(text, dateStr, miscProject, '').length
}

// ── AI 精简：把多条笔记合并成一条精简中文小记（供时间线多选精简）──

const NOTE_SUMMARY_SYSTEM = `你是一名研发工作小记整理助手。
请把多条人工工作笔记合并精简成一条适合写入日报/周报素材的中文小记。
要求：客观、简洁、书面化；合并同类事项、剔除冗余；保留真实完成事项和价值；不要编造未提供的信息。
直接输出精简后的小记内容本身，不要标题、不要解释、不要项目名前缀、不要分点。`

function buildNoteSummaryPrompt(notes) {
  const lines = ['请精简整理以下工作笔记：', '']
  notes.forEach((note, index) => {
    const meta = []
    if (note.project) meta.push(`项目：${note.project}`)
    if (note.date) meta.push(`日期：${note.date}`)
    lines.push(`${index + 1}. ${note.content}`)
    if (meta.length) lines.push(`   ${meta.join('；')}`)
  })
  lines.push('', '请输出一条精简后可直接写入工作小记的中文内容。')
  return lines.join('\n')
}

/**
 * AI 精简笔记：多条 → 一条。
 * @param {Array<{ date?: string; project?: string | null; content: string }>} notes
 * @param {{ provider?: any }} opts
 */
async function summarizeNotes(notes, { provider } = {}) {
  const items = (notes || []).filter((n) => n && typeof n.content === 'string' && n.content.trim())
  if (!items.length) return { text: '', model: '' }
  if (!provider || typeof provider.summarize !== 'function') throw new Error('未提供 AI provider')
  const result = await provider.summarize(NOTE_SUMMARY_SYSTEM, buildNoteSummaryPrompt(items))
  return {
    text: String((result && result.text) || '').trim(),
    model: result && result.model,
    inputTokens: result && result.inputTokens,
    outputTokens: result && result.outputTokens,
  }
}

module.exports = {
  noteFilePath,
  iterateDates,
  parseNoteText,
  loadNotes,
  getNoteText,
  saveNoteText,
  appendNote,
  appendSegment,
  countNotes,
  summarizeNotes,
  NOTE_SUMMARY_SYSTEM,
}
