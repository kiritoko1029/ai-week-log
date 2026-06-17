'use strict'
/* Codex hook local HTTP ingress tests. */
const fs = require('fs')
const http = require('http')
const os = require('os')
const path = require('path')
const { createCodexHookServer } = require('../src/main/codex-hook-server')
const P = require('../src/main/codex-pending-notes')

let pass = 0
let fail = 0

function ok(name, cond, extra) {
  if (cond) {
    pass++
    console.log('  ✓ ' + name)
  } else {
    fail++
    console.log('  ✗ ' + name + (extra ? '  → ' + extra : ''))
  }
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wl-codex-server-'))
}

function postJson(port, token, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload)
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/api/codex/pending-notes',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { text += chunk })
      res.on('end', () => {
        let data = {}
        try { data = JSON.parse(text) } catch {}
        resolve({ status: res.statusCode, data })
      })
    })
    req.on('error', reject)
    req.end(body)
  })
}

async function main() {
  console.log('\n[1] disabled server rejects writes')
  {
    const dir = tmpDir()
    const server = createCodexHookServer({
      dir,
      getConfig: () => ({ codexHook: { enabled: false, port: 0 }, repos: [], notes: { miscProject: '日常工作' } }),
      getToken: () => 'secret',
    })
    try {
      await server.applyConfig()
      ok('disabled server is not running', !server.status().running)
    } finally {
      await server.close()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }

  console.log('\n[2] token protected POST')
  {
    const dir = tmpDir()
    const server = createCodexHookServer({
      dir,
      getConfig: () => ({
        codexHook: { enabled: true, port: 0 },
        notes: { miscProject: '日常工作' },
        repos: [{ path: '/repo/weeklog', name: 'WeekLog' }],
      }),
      getToken: () => 'secret-token',
    })
    try {
      await server.applyConfig()
      const port = server.status().port
      ok('enabled server listens on loopback', server.status().running && server.status().host === '127.0.0.1', JSON.stringify(server.status()))
      const missing = await postJson(port, '', { cwd: '/repo/weeklog', summary: 'missing token' })
      ok('missing token is rejected', missing.status === 401, JSON.stringify(missing))
      const wrong = await postJson(port, 'bad-token', { cwd: '/repo/weeklog', summary: 'wrong token' })
      ok('wrong token is rejected', wrong.status === 401, JSON.stringify(wrong))
      const good = await postJson(port, 'secret-token', {
        source: 'codex',
        cwd: '/repo/weeklog',
        summary: '完成 Codex hook 接入。',
        changedFiles: ['src/main/ipc.js'],
        finishedAt: '2026-06-17T10:00:00.000Z',
      })
      ok('valid token stores pending note', good.status === 201 && good.data.id, JSON.stringify(good))
      const list = P.listPendingNotes(dir)
      ok('stored note is pending and project matched', list.length === 1 && list[0].project === 'WeekLog', JSON.stringify(list))
    } finally {
      await server.close()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }

  console.log(`\n结果：${pass} 通过，${fail} 失败\n`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
