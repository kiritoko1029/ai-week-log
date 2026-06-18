'use strict'
// @ts-check
/**
 * 渲染：把 WeeklyReport 渲染为 compact / text / md / json。
 * - compact：每天一行，【项目】：摘要连排，天与天换行
 * - text：严格匹配周报格式规范（YYYY/M/D，全角：，日期块间空一行）
 * - md：Markdown
 * - json：含 commit/笔记明细
 *
 * 另提供 convertFormat()：基于字符串解析在 compact / text / md 三种格式间互转（不调 AI）。
 * 解析器以三种格式的共同原子 `【项目】：内容` + 日期行 为基础，无法解析时回退原文本，保证不丢内容。
 */
const { formatDateNoZero } = require('./utils')

function nl(newline, s) {
  return newline === 'CRLF' ? s.replace(/\n/g, '\r\n') : s
}

function paragraphText(p) {
  let t = p.text || ''
  if (p.degraded && !t.includes('AI 总结不可用')) {
    t = t // 降级文本已自带说明，不再重复
  }
  return t
}

/** 把 day 的段落渲染成 `【项目】：摘要` 数组 */
function paragraphLines(day, opts = {}) {
  const out = []
  for (const p of day.paragraphs) {
    let line = `【${p.project}】：${paragraphText(p)}`
    if (opts.withCommits && p.commits && p.commits.length) {
      line += `  (commits: ${p.commits.map((c) => c.shortHash).join(', ')})`
    }
    if (opts.showNotes) {
      const notes = [...(p.notes || []), ...(p.sharedNotes || [])]
      if (notes.length) line += `\n    笔记：${notes.map((n) => n.content).join('；')}`
    }
    out.push(line)
  }
  return out
}

/** compact 格式：每个日期一行，行内段落连排；天与天换行 */
function renderCompact(report, opts = {}) {
  const lines = []
  report.days.forEach((day) => {
    const paras = paragraphLines(day, opts).map((l) => l.replace(/\n/g, ' '))
    if (paras.length) lines.push(`${formatDateNoZero(day.day)} ${paras.join('')}`)
    else lines.push(formatDateNoZero(day.day))
  })
  if (report.failedUnits && report.failedUnits.length) {
    lines.push(`⚠ 以下单元 AI 失败已降级：${report.failedUnits.join('；')}`)
  }
  return nl(opts.newline, lines.join('\n'))
}

/** text 格式：日期行 + 每项目一行【项目】：摘要 */
function renderText(report, opts = {}) {
  const lines = []
  report.days.forEach((day, i) => {
    if (i > 0) lines.push('') // 日期块之间空一行
    lines.push(formatDateNoZero(day.day))
    for (const l of paragraphLines(day, opts)) lines.push(l)
  })
  if (report.failedUnits && report.failedUnits.length) {
    lines.push('')
    lines.push(`⚠ 以下单元 AI 失败已降级：${report.failedUnits.join('；')}`)
  }
  return nl(opts.newline, lines.join('\n'))
}

/** md 格式 */
function renderMarkdown(report, opts = {}) {
  const lines = []
  // rangeStart/rangeEnd 可能缺失（如从 text/compact 互转而来），缺则用首尾日期兜底，避免 NaN
  const start = report.rangeStart || (report.days.length ? report.days[0].day : new Date())
  const end = report.rangeEnd || (report.days.length ? report.days[report.days.length - 1].day : start)
  lines.push(`# 工作周报 (${formatDateNoZero(start)} - ${formatDateNoZero(end)})`)
  lines.push('')
  for (const day of report.days) {
    lines.push(`## ${formatDateNoZero(day.day)}`)
    for (const p of day.paragraphs) {
      let line = `- **【${p.project}】**：${paragraphText(p)}`
      if (opts.withCommits && p.commits && p.commits.length) {
        line += `  (commits: ${p.commits.map((c) => c.shortHash).join(', ')})`
      }
      lines.push(line)
    }
    lines.push('')
  }
  if (report.failedUnits && report.failedUnits.length) {
    lines.push(`> ⚠ 降级单元：${report.failedUnits.join('；')}`)
  }
  return nl(opts.newline, lines.join('\n'))
}

/** json 格式（含 commit/笔记明细） */
function renderJSON(report) {
  return JSON.stringify(report, null, 2)
}

function render(report, opts = {}) {
  const format = opts.format || 'text'
  if (format === 'md') return renderMarkdown(report, opts)
  if (format === 'compact') return renderCompact(report, opts)
  if (format === 'json') return renderJSON(report)
  return renderText(report, opts)
}

// ── 解析器：把渲染后的字符串解析回结构，用于格式互转 ──

// 日期行（text/compact）：YYYY/M/D
const DATE_LINE_RE = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/
// 日期前缀（compact 行首）：YYYY/M/D 后跟空格再跟内容
const DATE_PREFIX_RE = /^(\d{4}\/\d{1,2}\/\d{1,2})(?:\s+(.*))?$/
// 【项目】：内容
const PARA_RE = /^【([^】]+)】：?([\s\S]*)$/
// md 段落：- **【项目】**：内容
const MD_PARA_RE = /^-\s*\*\*【([^】]+)】\*\*：?(.*)$/
// md 日期标题：## YYYY/M/D
const MD_DATE_RE = /^##\s*(\d{4}\/\d{1,2}\/\d{1,2})/
// md 报告标题：# 工作周报 (YYYY/M/D - YYYY/M/D)
const MD_TITLE_RE = /^#\s+工作周报\s*\((\d{4}\/\d{1,2}\/\d{1,2})\s*-\s*(\d{4}\/\d{1,2}\/\d{1,2})\)/

/** 把 `YYYY/M/D` 反向格式化回可被 render 识别的 day 字符串（render 内部用 formatDateNoZero(day)，
 *  只要传入能被 new Date() 解析的值即可；这里转回 ISO 形式最稳妥） */
function dateLabelToValue(label) {
  const m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec((label || '').trim())
  if (!m) return label
  const [, y, mo, d] = m
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

/** 从一行中按 `【...】：` 切出多个段落（compact 用，一行内多个段落连排） */
function splitParagraphsFromInline(line) {
  const result = []
  // 按位置查找所有 `【...】：` 的起止
  const re = /【([^】]+)】：?/g
  const matches = []
  let mm
  while ((mm = re.exec(line)) !== null) {
    matches.push({ index: mm.index, end: re.lastIndex, project: mm[1] })
  }
  if (!matches.length) return result
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].end
    const end = i + 1 < matches.length ? matches[i + 1].index : line.length
    result.push({ project: matches[i].project, text: line.slice(start, end).trim() })
  }
  return result
}

/**
 * 解析渲染后的文本为结构。无法解析返回 { raw: text }。
 * @param {string} text
 * @param {string} fromFormat 'compact' | 'text' | 'md'
 */
function parseRenderedText(text, fromFormat) {
  const raw = String(text || '')
  if (!raw.trim()) return { raw }
  // 统一换行为 \n 再解析
  const normalized = raw.replace(/\r\n?/g, '\n')
  const lines = normalized.split('\n')

  let failedUnits = null
  const days = []
  let rangeStart = null
  let rangeEnd = null

  if (fromFormat === 'md') {
    let cur = null
    for (const line of lines) {
      const tm = MD_TITLE_RE.exec(line)
      if (tm) {
        rangeStart = dateLabelToValue(tm[1])
        rangeEnd = dateLabelToValue(tm[2])
        continue
      }
      const dm = MD_DATE_RE.exec(line)
      if (dm) {
        if (cur) days.push(cur)
        cur = { day: dateLabelToValue(dm[1]), paragraphs: [] }
        continue
      }
      if (!cur) continue
      const pm = MD_PARA_RE.exec(line.trim())
      if (pm) {
        cur.paragraphs.push({ project: pm[1], text: pm[2].trim() })
      } else if (/^>\s*⚠\s*降级单元：/.test(line.trim())) {
        failedUnits = line.trim().replace(/^>\s*⚠\s*降级单元：/, '').split('；').map((s) => s.trim()).filter(Boolean)
      }
    }
    if (cur) days.push(cur)
  } else if (fromFormat === 'compact') {
    // 每行一日期块，行内多个段落连排；最后一行可能是 ⚠ 降级
    for (const line of lines) {
      const s = line.trim()
      if (!s) continue
      if (/^⚠\s*以下单元 AI 失败已降级：/.test(s)) {
        failedUnits = s.replace(/^⚠\s*以下单元 AI 失败已降级：/, '').split('；').map((x) => x.trim()).filter(Boolean)
        continue
      }
      const pm = DATE_PREFIX_RE.exec(s)
      if (pm) {
        const day = dateLabelToValue(pm[1])
        const paragraphs = splitParagraphsFromInline(pm[2] || '')
        days.push({ day, paragraphs })
      }
    }
  } else {
    // text：按空行切日期块；首行日期；【项目】：为段落
    let cur = null
    const flush = () => {
      if (cur) days.push(cur)
      cur = null
    }
    for (const line of lines) {
      if (line.trim() === '') {
        flush()
        continue
      }
      const dm = DATE_LINE_RE.exec(line.trim())
      if (dm) {
        flush()
        cur = { day: dateLabelToValue(dm[0]), paragraphs: [] }
        continue
      }
      if (/^⚠\s*以下单元 AI 失败已降级：/.test(line.trim())) {
        failedUnits = line.trim().replace(/^⚠\s*以下单元 AI 失败已降级：/, '').split('；').map((x) => x.trim()).filter(Boolean)
        continue
      }
      const pm = PARA_RE.exec(line)
      if (pm && cur) {
        cur.paragraphs.push({ project: pm[1], text: pm[2].trim() })
      }
    }
    flush()
  }

  if (!days.length) return { raw }
  const out = { days }
  if (rangeStart) out.rangeStart = rangeStart
  if (rangeEnd) out.rangeEnd = rangeEnd
  if (failedUnits) out.failedUnits = failedUnits
  return out
}

/**
 * 在 compact / text / md 三种格式间互转。不调 AI，纯字符串解析 + 重渲染。
 * 解析失败回退原文本（保证不丢内容）。
 * @param {string} text
 * @param {{ from?: string; to: string; newline?: string }} opts
 */
function convertFormat(text, { from, to, newline } = {}) {
  const srcFormat = from || 'text'
  const target = to || 'text'
  if (srcFormat === target) return String(text || '')
  // json 不参与互转，原样返回
  if (target === 'json' || srcFormat === 'json') return String(text || '')

  const parsed = parseRenderedText(text, srcFormat)
  if (parsed.raw !== undefined) return parsed.raw

  // 用 render 函数重渲染；withCommits/showNotes 的尾缀在解析时被并入段落 text，重渲染不再追加
  const report = {
    days: parsed.days,
    rangeStart: parsed.rangeStart,
    rangeEnd: parsed.rangeEnd,
    failedUnits: parsed.failedUnits || [],
  }
  return render(report, { format: target, newline })
}

module.exports = { render, renderText, renderMarkdown, renderCompact, renderJSON, convertFormat, parseRenderedText }
