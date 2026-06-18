'use strict'
// @ts-check

const MAX_SUMMARY_CHARS = 4000
const MISSING_ZCODE_SUMMARY = '未捕获到 ZCode 任务总结；请在 WeekLog 待处理池中补充这次任务完成了什么。'

function stripZcodeMetadata(text) {
  return String(text || '')
    // ZCode/Claude Code 风格的 citation / thinking 块清理
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .replace(/<oai-mem-citation>[\s\S]*?<\/oai-mem-citation>/g, '')
    .trim()
}

function trimSummary(text) {
  const s = stripZcodeMetadata(text)
  if (s.length <= MAX_SUMMARY_CHARS) return s
  return s.slice(0, MAX_SUMMARY_CHARS - 1).trimEnd() + '…'
}

function sanitizeZcodeSummary(text) {
  return trimSummary(text)
}

module.exports = {
  MAX_SUMMARY_CHARS,
  MISSING_ZCODE_SUMMARY,
  stripZcodeMetadata,
  trimSummary,
  sanitizeZcodeSummary,
}
