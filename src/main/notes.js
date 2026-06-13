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
}
