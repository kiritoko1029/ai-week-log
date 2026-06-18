'use strict'
// @ts-check
/**
 * Codex hooks.json integration for WeekLog pending notes.
 *
 * The installer owns only hooks carrying WEEKLOG_HOOK_ID. It preserves every
 * other user-defined Codex hook and refuses to rewrite invalid JSON.
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const {
  MAX_SUMMARY_CHARS,
  stripCodexMetadata,
  trimSummary,
} = require('./codex-summary')

const WEEKLOG_HOOK_ID = 'weeklog-codex-pending-note'
const WEEKLOG_STATUS_MESSAGE = `Saving Codex pending note (${WEEKLOG_HOOK_ID})`
const DEFAULT_TIMEOUT_SECONDS = 30

function defaultHooksPath(env = process.env) {
  const home = env.CODEX_HOME || path.join(os.homedir(), '.codex')
  return path.join(home, 'hooks.json')
}

function timestampForFile(now = () => new Date()) {
  return now().toISOString().replace(/[:.]/g, '-')
}

function backupFile(file, now) {
  if (!fs.existsSync(file)) return ''
  const backupPath = `${file}.weeklog-backup-${timestampForFile(now)}`
  fs.copyFileSync(file, backupPath)
  return backupPath
}

function readHooksFile(file) {
  if (!fs.existsSync(file)) return { config: { hooks: {} }, exists: false }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    const config = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    if (!config.hooks || typeof config.hooks !== 'object' || Array.isArray(config.hooks)) config.hooks = {}
    return { config, exists: true }
  } catch (e) {
    return { error: e.message || String(e), exists: true }
  }
}

function writeHooksFile(file, config) {
  const dir = path.dirname(file)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n', 'utf8')
}

function textFromValue(value, depth = 0) {
  if (depth > 4 || value == null) return ''
  if (typeof value === 'string') return value.trim()
  if (Array.isArray(value)) {
    return value
      .map((item) => textFromValue(item, depth + 1))
      .filter(Boolean)
      .join('\n\n')
      .trim()
  }
  if (typeof value === 'object') {
    for (const key of ['text', 'content', 'value', 'message', 'summary', 'final_message', 'finalMessage', 'final_response', 'finalResponse']) {
      const picked = textFromValue(value[key], depth + 1)
      if (picked) return picked
    }
  }
  return ''
}

function firstText(...values) {
  for (const value of values) {
    const text = textFromValue(value)
    if (text) return trimSummary(text)
  }
  return ''
}

function readTranscriptSummary(transcriptPath, fsModule = fs) {
  const file = textFromValue(transcriptPath)
  if (!file) return ''
  try {
    if (!fsModule.existsSync(file)) return ''
    const stat = fsModule.statSync(file)
    if (!stat.isFile() || stat.size > 10 * 1024 * 1024) return ''
    const raw = fsModule.readFileSync(file, 'utf8')
    let lastAssistantText = ''
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue
      let item
      try {
        item = JSON.parse(line)
      } catch {
        continue
      }
      const payload = item && (item.payload || item)
      const role = payload && (payload.role || payload.author || (payload.message && payload.message.role))
      const type = payload && payload.type
      const isAssistant =
        role === 'assistant' ||
        type === 'assistant_message' ||
        type === 'assistant' ||
        (type === 'message' && role === 'assistant')
      if (!isAssistant) continue
      const text = firstText(payload.content, payload.message && payload.message.content, payload.text, payload.delta)
      if (text) lastAssistantText = text
    }
    return lastAssistantText
  } catch {
    return ''
  }
}

function deriveCodexSummary(event, opts = {}) {
  const e = event && typeof event === 'object' ? event : {}
  const direct = firstText(
    e.final_response,
    e.finalResponse,
    e.final_message,
    e.finalMessage,
    e.assistant_response,
    e.assistantResponse,
    e.assistant_message,
    e.assistantMessage,
    e.output_text,
    e.outputText,
    e.summary,
    e.result && e.result.final_response,
    e.result && e.result.finalResponse,
    e.result && e.result.final_message,
    e.result && e.result.finalMessage,
    e.result && e.result.summary,
    e.turn && e.turn.final_response,
    e.turn && e.turn.finalResponse,
    e.turn && e.turn.final_message,
    e.turn && e.turn.finalMessage,
    e.turn && e.turn.summary
  )
  if (direct) return direct
  const fromTranscript = readTranscriptSummary(
    firstText(e.transcript_path, e.transcriptPath, e.transcript_file, e.transcriptFile, e.transcript),
    opts.fs || fs
  )
  return fromTranscript
}

function buildHookScript({ endpoint, token }) {
  return `
const fs = require('fs')
const http = require('http')
const cp = require('child_process')
const endpoint = ${JSON.stringify(endpoint)}
const token = ${JSON.stringify(token)}
function run(cmd, args) {
  try {
    return cp.execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 1000 }).trim()
  } catch {
    return ''
  }
}
function parseInput() {
  try {
    if (process.stdin.isTTY) return {}
    const raw = fs.readFileSync(0, 'utf8')
    return raw.trim() ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}
const MAX_SUMMARY_CHARS = ${MAX_SUMMARY_CHARS}
${stripCodexMetadata.toString()}
${trimSummary.toString()}
${textFromValue.toString()}
${firstText.toString()}
${readTranscriptSummary.toString()}
${deriveCodexSummary.toString()}
const event = parseInput()
const summary = deriveCodexSummary(event, { fs })
if (!summary) process.exit(0)
const changed = run('git', ['diff', '--name-only', 'HEAD'])
  .split(/\\r?\\n/)
  .map((line) => line.trim())
  .filter(Boolean)
const statusFiles = run('git', ['status', '--short'])
  .split(/\\r?\\n/)
  .map((line) => line.slice(3).trim())
  .filter(Boolean)
const changedFiles = Array.from(new Set([...changed, ...statusFiles])).slice(0, 80)
const payload = JSON.stringify({
  source: 'codex',
  cwd: process.cwd(),
  summary,
  title: firstText(event.title, event.prompt),
  branch: run('git', ['branch', '--show-current']) || run('git', ['rev-parse', '--short', 'HEAD']),
  changedFiles,
  finishedAt: new Date().toISOString(),
})
const req = http.request(endpoint, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    Authorization: 'Bearer ' + token,
  },
}, (res) => res.resume())
req.on('error', () => {})
req.end(payload)
`
}

function buildCommands({ endpoint, token }) {
  const encoded = Buffer.from(buildHookScript({ endpoint, token }), 'utf8').toString('base64')
  return {
    command: `node -e 'eval(Buffer.from("${encoded}","base64").toString())'`,
    commandWindows: `node -e "eval(Buffer.from('${encoded}','base64').toString())"`,
  }
}

function buildCodexPendingNoteHook({ endpoint, token, timeout = DEFAULT_TIMEOUT_SECONDS }) {
  const commands = buildCommands({ endpoint, token })
  return {
    type: 'command',
    command: commands.command,
    commandWindows: commands.commandWindows,
    timeout,
    statusMessage: WEEKLOG_STATUS_MESSAGE,
  }
}

function buildCodexHookSnippet({ endpoint, token }) {
  const hook = buildCodexPendingNoteHook({ endpoint, token })
  return JSON.stringify({
    hooks: {
      Stop: [
        {
          hooks: [hook],
        },
      ],
    },
  }, null, 2)
}

function isManagedWeekLogHook(hook) {
  return !!(
    hook &&
    typeof hook === 'object' &&
    (
      hook.weeklogHookId === WEEKLOG_HOOK_ID ||
      (typeof hook.statusMessage === 'string' && hook.statusMessage.includes(WEEKLOG_HOOK_ID))
    )
  )
}

function normalizeStopGroups(config) {
  config.hooks = config.hooks && typeof config.hooks === 'object' && !Array.isArray(config.hooks) ? config.hooks : {}
  config.hooks.Stop = Array.isArray(config.hooks.Stop) ? config.hooks.Stop : []
  return config.hooks.Stop
}

function removeManagedHooks(config) {
  const groups = normalizeStopGroups(config)
  let removed = 0
  const nextGroups = []
  for (const group of groups) {
    if (!group || typeof group !== 'object') {
      nextGroups.push(group)
      continue
    }
    const hooks = Array.isArray(group.hooks) ? group.hooks : []
    const keptHooks = hooks.filter((hook) => {
      const managed = isManagedWeekLogHook(hook)
      if (managed) removed++
      return !managed
    })
    if (hooks.length === 0 || keptHooks.length > 0) {
      nextGroups.push({ ...group, hooks: keptHooks })
    }
  }
  config.hooks.Stop = nextGroups
  return removed
}

function installCodexHook({ hooksPath = defaultHooksPath(), hook, now = () => new Date() }) {
  if (!hook || typeof hook !== 'object') return { ok: false, installed: false, replaced: 0, error: '缺少 hook 配置' }
  const read = readHooksFile(hooksPath)
  if (read.error) return { ok: false, installed: false, replaced: 0, error: `Codex hooks 配置不是有效 JSON：${read.error}` }

  const config = read.config
  const replaced = removeManagedHooks(config)
  normalizeStopGroups(config).push({ hooks: [hook] })
  const backupPath = read.exists ? backupFile(hooksPath, now) : ''
  writeHooksFile(hooksPath, config)
  return { ok: true, installed: true, replaced, hooksPath, backupPath }
}

function uninstallCodexHook({ hooksPath = defaultHooksPath(), now = () => new Date() }) {
  const read = readHooksFile(hooksPath)
  if (read.error) return { ok: false, removed: 0, error: `Codex hooks 配置不是有效 JSON：${read.error}` }
  if (!read.exists) return { ok: true, removed: 0, hooksPath, backupPath: '' }

  const config = read.config
  const removed = removeManagedHooks(config)
  if (!removed) return { ok: true, removed: 0, hooksPath, backupPath: '' }
  const backupPath = backupFile(hooksPath, now)
  writeHooksFile(hooksPath, config)
  return { ok: true, removed, hooksPath, backupPath }
}

function getCodexHookInstallStatus({ hooksPath = defaultHooksPath() } = {}) {
  const read = readHooksFile(hooksPath)
  if (read.error) {
    return { hooksPath, exists: true, installed: false, hookCount: 0, error: `Codex hooks 配置不是有效 JSON：${read.error}` }
  }
  const groups = read.config && read.config.hooks && Array.isArray(read.config.hooks.Stop) ? read.config.hooks.Stop : []
  let hookCount = 0
  for (const group of groups) {
    const hooks = group && Array.isArray(group.hooks) ? group.hooks : []
    hookCount += hooks.filter(isManagedWeekLogHook).length
  }
  return { hooksPath, exists: !!read.exists, installed: hookCount > 0, hookCount, error: '' }
}

module.exports = {
  WEEKLOG_HOOK_ID,
  WEEKLOG_STATUS_MESSAGE,
  defaultHooksPath,
  buildHookScript,
  deriveCodexSummary,
  buildCodexPendingNoteHook,
  buildCodexHookSnippet,
  isManagedWeekLogHook,
  installCodexHook,
  uninstallCodexHook,
  getCodexHookInstallStatus,
}
