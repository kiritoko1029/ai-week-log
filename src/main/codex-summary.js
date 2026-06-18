'use strict'
// @ts-check

const MAX_SUMMARY_CHARS = 4000
const MISSING_CODEX_SUMMARY = '未捕获到 Codex 任务总结；请在 WeekLog 待处理池中补充这次任务完成了什么。'

function stripCodexMetadata(text) {
  return String(text || '')
    .replace(/<oai-mem-citation>[\s\S]*?<\/oai-mem-citation>/g, '')
    .trim()
}

function trimSummary(text) {
  const s = stripCodexMetadata(text)
  if (s.length <= MAX_SUMMARY_CHARS) return s
  return s.slice(0, MAX_SUMMARY_CHARS - 1).trimEnd() + '…'
}

function sanitizeCodexSummary(text) {
  return trimSummary(text)
}

module.exports = {
  MAX_SUMMARY_CHARS,
  MISSING_CODEX_SUMMARY,
  stripCodexMetadata,
  trimSummary,
  sanitizeCodexSummary,
}
