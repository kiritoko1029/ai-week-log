'use strict'
// @ts-check
/**
 * 渲染：把 WeeklyReport 渲染为 text / md / json。
 * 默认 text 严格匹配周报格式规范（YYYY/M/D，全角：，日期块间空一行）。
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

/** text 格式：日期行 + 每项目一行【项目】：摘要 */
function renderText(report, opts = {}) {
  const lines = []
  report.days.forEach((day, i) => {
    if (i > 0) lines.push('') // 日期块之间空一行
    lines.push(formatDateNoZero(day.day))
    for (const p of day.paragraphs) {
      let line = `【${p.project}】：${paragraphText(p)}`
      if (opts.withCommits && p.commits && p.commits.length) {
        line += `  (commits: ${p.commits.map((c) => c.shortHash).join(', ')})`
      }
      if (opts.showNotes) {
        const notes = [...(p.notes || []), ...(p.sharedNotes || [])]
        if (notes.length) line += `\n    笔记：${notes.map((n) => n.content).join('；')}`
      }
      lines.push(line)
    }
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
  lines.push(`# 工作周报 (${formatDateNoZero(report.rangeStart)} - ${formatDateNoZero(report.rangeEnd)})`)
  lines.push('')
  for (const day of report.days) {
    lines.push(`## ${formatDateNoZero(day.day)}`)
    for (const p of day.paragraphs) {
      lines.push(`- **【${p.project}】**：${paragraphText(p)}`)
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
  if (format === 'json') return renderJSON(report)
  return renderText(report, opts)
}

module.exports = { render, renderText, renderMarkdown, renderJSON }
