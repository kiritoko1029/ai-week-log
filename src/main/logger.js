'use strict'
// @ts-check
/**
 * Lightweight append-only app logger. Lines are JSONL so the renderer can
 * filter and render them without parsing fragile console text.
 */
const fs = require('fs')
const path = require('path')

const LOG_DIR = 'logs'
const LOG_FILE = 'weeklog.log'
const MAX_LINE_COUNT = 2000

function logPath(userDataDir) {
  return path.join(userDataDir, LOG_DIR, LOG_FILE)
}

function sanitize(value) {
  if (value == null) return value
  if (typeof value === 'string') return value.length > 1000 ? value.slice(0, 1000) + '...' : value
  if (Array.isArray(value)) return value.map(sanitize)
  if (typeof value === 'object') {
    const out = {}
    for (const [key, item] of Object.entries(value)) {
      if (/password|authorization|api[_-]?key|secret|token/i.test(key)) {
        out[key] = '[redacted]'
      } else {
        out[key] = sanitize(item)
      }
    }
    return out
  }
  return value
}

function parseLine(line) {
  try {
    const item = JSON.parse(line)
    return item && typeof item === 'object' ? item : null
  } catch {
    return null
  }
}

function createLogger(userDataDir) {
  const file = logPath(userDataDir)

  function write(level, scope, message, data = {}) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const entry = {
        ts: new Date().toISOString(),
        level,
        scope,
        message,
        data: sanitize(data || {}),
      }
      fs.appendFileSync(file, JSON.stringify(entry) + '\n', 'utf8')
    } catch (e) {
      console.warn('[logger] 写入失败：', e.message)
    }
  }

  return {
    debug: (scope, message, data) => write('debug', scope, message, data),
    info: (scope, message, data) => write('info', scope, message, data),
    warn: (scope, message, data) => write('warn', scope, message, data),
    error: (scope, message, data) => write('error', scope, message, data),
  }
}

function listLogs(userDataDir, limit = 500) {
  const file = logPath(userDataDir)
  if (!fs.existsSync(file)) return []
  const raw = fs.readFileSync(file, 'utf8')
  const lines = raw.split(/\r?\n/).filter(Boolean)
  const n = Math.max(1, Math.min(Number(limit) || 500, MAX_LINE_COUNT))
  return lines.slice(Math.max(0, lines.length - n)).map(parseLine).filter(Boolean).reverse()
}

function clearLogs(userDataDir) {
  const file = logPath(userDataDir)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, '', 'utf8')
  return { ok: true }
}

module.exports = {
  createLogger,
  listLogs,
  clearLogs,
  logPath,
  _test: { sanitize, parseLine },
}
