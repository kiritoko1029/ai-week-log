'use strict'
/* Security/robustness regression tests for Electron IPC boundaries and WebDAV merge helpers. */
const fs = require('fs')
const path = require('path')
const W = require('../src/main/webdav')

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

function throws(name, fn, pattern) {
  try {
    fn()
    ok(name, false, 'did not throw')
  } catch (e) {
    ok(name, pattern ? pattern.test(String(e.message || e)) : true, e.message)
  }
}

console.log('\n[1] preload 不暴露密钥读取能力')
const preload = fs.readFileSync(path.join(__dirname, '..', 'src/preload/index.js'), 'utf8')
ok('不暴露 secrets.get()', !/secrets:\s*{[\s\S]*?\bget:\s*\(/.test(preload))
ok('不调用 secrets:get IPC', !preload.includes('secrets:get'))
ok('不暴露 webdav.getPassword()', !/webdav:\s*{[\s\S]*?\bgetPassword:\s*\(/.test(preload))
ok('不调用 webdav:getPassword IPC', !preload.includes('webdav:getPassword'))
ok('暴露 secrets.status()', /secrets:\s*{[\s\S]*?\bstatus:\s*\(/.test(preload))
ok('暴露 webdav.passwordStatus()', /webdav:\s*{[\s\S]*?\bpasswordStatus:\s*\(/.test(preload))
ok('不暴露 codexHook token 读写能力', !preload.includes('codexHook:getToken') && !preload.includes('codexHook:setToken'))
ok('Codex hook 安装不通过 preload 暴露 token', !preload.includes('codexHookToken') && !preload.includes('token:'))

console.log('\n[2] generate IPC 异常会落到任务失败')
const ipc = fs.readFileSync(path.join(__dirname, '..', 'src/main/ipc.js'), 'utf8')
const generateBlock = (ipc.match(/ipcMain\.handle\('generate'[\s\S]*?^\s{2}\}\)/m) || [''])[0]
ok('generate handler 包含 catch', /catch\s*\(e\)/.test(generateBlock))
ok('generate handler catch 中标记 tasks.error', /catch\s*\(e\)\s*{[\s\S]*tasks\.error\(taskId/.test(generateBlock))

console.log('\n[3] Electron 窗口安全')
const mainIndex = fs.readFileSync(path.join(__dirname, '..', 'src/main/index.js'), 'utf8')
ok('启用 renderer sandbox', /sandbox:\s*true/.test(mainIndex))
ok('拦截非预期导航', mainIndex.includes("will-navigate"))
ok('拦截 window.open', mainIndex.includes('setWindowOpenHandler'))

console.log('\n[4] WebDAV URL 校验')
ok('导出测试辅助', W._test && typeof W._test.normalizeWebdavBaseUrl === 'function')
if (W._test && W._test.normalizeWebdavBaseUrl) {
  ok(
    'HTTPS URL 被规范化为尾斜杠',
    W._test.normalizeWebdavBaseUrl('https://dav.example.com/weeklog') === 'https://dav.example.com/weeklog/'
  )
  throws('拒绝 http URL', () => W._test.normalizeWebdavBaseUrl('http://dav.example.com/weeklog'), /HTTPS/)
  throws('拒绝 localhost URL', () => W._test.normalizeWebdavBaseUrl('https://localhost/weeklog'), /本机|私有/)
  throws('拒绝非 http(s) URL', () => W._test.normalizeWebdavBaseUrl('file:///tmp/weeklog'), /HTTPS/)
}

console.log('\n[5] WebDAV JSON 合并')
ok('导出 mergeJsonArraysById', W._test && typeof W._test.mergeJsonArraysById === 'function')
if (W._test && W._test.mergeJsonArraysById) {
  const local = [
    { id: 'same', text: 'old local', updatedAt: '2026-06-01T00:00:00.000Z' },
    { id: 'local-only', text: 'keep local', updatedAt: '2026-06-01T00:00:00.000Z' },
  ]
  const remote = [
    { id: 'same', text: 'new remote', updatedAt: '2026-06-02T00:00:00.000Z' },
    { id: 'remote-only', text: 'keep remote', updatedAt: '2026-06-01T00:00:00.000Z' },
  ]
  const merged = W._test.mergeJsonArraysById(local, remote, 'id')
  ok('同 id 取 updatedAt 更新者', merged.items.find((i) => i.id === 'same').text === 'new remote')
  ok('保留本地新增项', merged.items.some((i) => i.id === 'local-only'))
  ok('保留远端新增项', merged.items.some((i) => i.id === 'remote-only'))
  ok('报告拉取了远端新增/更新', merged.pulled === 2, 'pulled=' + merged.pulled)
}

async function testWebdavSyncFilePushesMissingRemote() {
  console.log('\n[6] WebDAV 双向同步新本地文件')
  ok('导出 syncFile 测试辅助', W._test && typeof W._test.syncFile === 'function')
  if (!W._test || typeof W._test.syncFile !== 'function') return

  const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'wl-webdav-'))
  const localPath = path.join(tmp, 'notes', '2026-06-17.md')
  fs.mkdirSync(path.dirname(localPath), { recursive: true })
  fs.writeFileSync(localPath, '今日完成 WebDAV 同步修复', 'utf8')

  const calls = []
  const oldFetch = global.fetch
  global.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), method: opts.method || 'GET', body: opts.body || null })
    if (!opts.method || opts.method === 'GET') {
      return {
        status: 404,
        text: async () => 'not found',
      }
    }
    if (opts.method === 'PUT') {
      return {
        status: 201,
        text: async () => '',
      }
    }
    return {
      status: 500,
      text: async () => 'unexpected method',
    }
  }

  try {
    const result = await W._test.syncFile('https://dav.example.com/weeklog/notes/2026-06-17.md', localPath, { username: 'u', password: 'p' }, 'both')
    const put = calls.find((c) => c.method === 'PUT')
    ok('远端缺失时双向同步会上传本地文件', result === 'pushed' && put && put.body === '今日完成 WebDAV 同步修复', JSON.stringify({ result, calls }))
  } finally {
    global.fetch = oldFetch
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

async function testWebdavSyncAllThrowsConnectionFailure() {
  console.log('\n[7] WebDAV 连接失败会直接报错')
  const oldFetch = global.fetch
  const calls = []
  global.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), method: opts.method || 'GET' })
    return {
      status: 401,
      text: async () => 'Unauthorized',
    }
  }

  try {
    let err = null
    try {
      await W.syncAll({
        cfg: { webdav: { url: 'https://dav.example.com/weeklog/', username: 'u' } },
        dir: require('os').tmpdir(),
        password: 'bad-password',
        direction: 'both',
      })
    } catch (e) {
      err = e
    }
    ok('基础连接失败时 syncAll reject', !!err, 'calls=' + JSON.stringify(calls))
    ok('错误信息明确提示 WebDAV 连接失败', /WebDAV 连接失败|认证失败|401/.test(String(err && err.message || '')), String(err && err.message || ''))
  } finally {
    global.fetch = oldFetch
  }
}

testWebdavSyncFilePushesMissingRemote().then(testWebdavSyncAllThrowsConnectionFailure).then(() => {
  console.log(`\n结果：${pass} 通过，${fail} 失败\n`)
  process.exit(fail ? 1 : 0)
}).catch((e) => {
  fail++
  console.log('  ✗ WebDAV 回归测试异常  → ' + (e && e.message || e))
  console.log(`\n结果：${pass} 通过，${fail} 失败\n`)
  process.exit(1)
})
