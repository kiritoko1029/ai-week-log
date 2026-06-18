'use strict'
// @ts-check
/**
 * 本地 ZCode hook HTTP 入口。
 *
 * 仅绑定 127.0.0.1；外部 hook 必须携带本机 token，写入待处理池而非正式笔记。
 */
const http = require('http')
const pending = require('./zcode-pending-notes')

const DEFAULT_PORT = 17322
const HOST = '127.0.0.1'
const MAX_BODY_BYTES = 256 * 1024

function json(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
  })
  res.end(text)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => {
      size += Buffer.byteLength(chunk)
      if (size > MAX_BODY_BYTES) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      body += chunk
    })
    req.on('end', () => resolve(body))
    req.on('error', reject)
  })
}

function extractBearer(req) {
  const raw = req.headers.authorization || ''
  const m = /^Bearer\s+(.+)$/i.exec(String(raw))
  return m ? m[1].trim() : ''
}

function validPort(port) {
  const n = Number(port)
  if (!Number.isInteger(n) || n < 0 || n > 65535) return DEFAULT_PORT
  return n
}

function createZcodeHookServer({ dir, getConfig, getToken, logger } = {}) {
  let server = null
  let status = { running: false, host: HOST, port: 0, error: '' }

  const close = () => new Promise((resolve) => {
    if (!server) {
      status = { ...status, running: false, port: 0 }
      resolve()
      return
    }
    const current = server
    server = null
    current.close(() => {
      status = { running: false, host: HOST, port: 0, error: '' }
      resolve()
    })
  })

  const handle = async (req, res) => {
    const cfg = (getConfig && getConfig()) || {}
    const hookCfg = cfg.zcodeHook || {}
    if (!hookCfg.enabled) {
      json(res, 403, { error: 'ZCode hook 未启用' })
      return
    }
    if (req.method !== 'POST' || req.url !== '/api/zcode/pending-notes') {
      json(res, 404, { error: 'not found' })
      return
    }
    const expected = getToken ? getToken() : ''
    if (!expected || extractBearer(req) !== expected) {
      json(res, 401, { error: 'unauthorized' })
      return
    }
    try {
      const raw = await readBody(req)
      const payload = raw ? JSON.parse(raw) : {}
      const item = pending.addPendingNote(dir, payload, cfg)
      if (logger) logger.info('zcode.hook', '收到 ZCode 待处理小记', { id: item.id, project: item.project, cwd: item.cwd })
      json(res, 201, { id: item.id, item })
    } catch (e) {
      if (logger) logger.warn('zcode.hook', 'ZCode 待处理小记写入失败', { error: e.message })
      json(res, /JSON/.test(String(e.message)) ? 400 : 422, { error: e.message || 'invalid request' })
    }
  }

  const applyConfig = async () => {
    const cfg = (getConfig && getConfig()) || {}
    const hookCfg = cfg.zcodeHook || {}
    if (!hookCfg.enabled) {
      await close()
      return status
    }
    const desiredPort = validPort(hookCfg.port == null ? DEFAULT_PORT : hookCfg.port)
    if (server && status.running && status.port === desiredPort) return status
    await close()
    server = http.createServer(handle)
    await new Promise((resolve) => {
      server.once('error', (err) => {
        status = { running: false, host: HOST, port: 0, error: err.message }
        if (logger) logger.error('zcode.hook', 'ZCode hook 本地服务启动失败', { error: err.message, port: desiredPort })
        server = null
        resolve()
      })
      server.listen(desiredPort, HOST, () => {
        const addr = server.address()
        status = {
          running: true,
          host: HOST,
          port: addr && typeof addr === 'object' ? addr.port : desiredPort,
          error: '',
        }
        if (logger) logger.info('zcode.hook', 'ZCode hook 本地服务已启动', { port: status.port })
        resolve()
      })
    })
    return status
  }

  return {
    applyConfig,
    close,
    status: () => ({ ...status }),
  }
}

module.exports = {
  DEFAULT_PORT,
  HOST,
  createZcodeHookServer,
  _test: { extractBearer, validPort },
}
