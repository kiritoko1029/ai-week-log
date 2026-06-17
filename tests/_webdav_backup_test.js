'use strict'
/* WebDAV backup/restore regression tests. */
const fs = require('fs')
const path = require('path')
const os = require('os')
const zlib = require('zlib')
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

function backupXml(names) {
  const responses = names.map((item) => `
<D:response>
  <D:href>/weeklog/backups/${encodeURIComponent(item.name)}</D:href>
  <D:propstat><D:prop>
    <D:displayname>${item.name}</D:displayname>
    <D:getcontentlength>${item.size || 100}</D:getcontentlength>
    <D:getlastmodified>${item.lastModified || 'Wed, 17 Jun 2026 10:00:00 GMT'}</D:getlastmodified>
  </D:prop></D:propstat>
</D:response>`).join('')
  return `<?xml version="1.0"?><D:multistatus xmlns:D="DAV:">
<D:response><D:href>/weeklog/backups/</D:href><D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop></D:propstat></D:response>
${responses}
</D:multistatus>`
}

function makeTempFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-backup-'))
  const notesDir = path.join(dir, 'custom-notes')
  fs.mkdirSync(notesDir, { recursive: true })
  fs.mkdirSync(path.join(dir, 'memory', 'entries'), { recursive: true })
  fs.writeFileSync(path.join(notesDir, '2026-06-17.md'), '今天修复 WebDAV 备份', 'utf8')
  fs.writeFileSync(path.join(dir, 'memory', 'entries', 'm1.md'), '记忆内容', 'utf8')
  fs.writeFileSync(path.join(dir, 'memory', 'index.json'), JSON.stringify([{ id: 'm1', updatedAt: '2026-06-17T00:00:00.000Z' }]), 'utf8')
  fs.writeFileSync(path.join(dir, 'history.json'), JSON.stringify([{ id: 'h1', text: '日报' }]), 'utf8')
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    schemaVersion: 2,
    weekStart: 'monday',
    timezone: 'Asia/Shanghai',
    repos: [{ id: 'local', path: '/Users/me/project', name: 'project' }],
    notes: { enabled: true, miscProject: '日常工作', dir: notesDir },
    ui: { theme: 'dark', quickNoteShortcut: 'CommandOrControl+Shift+L' },
    webdav: { enabled: true, url: 'https://dav.example.com/weeklog/', username: 'u', autoSync: 'push' },
  }, null, 2), 'utf8')
  return { dir, notesDir }
}

async function testCreateBackupUploadsCompressedSnapshotAndPrunesOldFiles() {
  console.log('\n[1] 创建 WebDAV 压缩备份并保留 10 份')
  ok('导出 createBackup', typeof W.createBackup === 'function')
  ok('导出 listBackups', typeof W.listBackups === 'function')
  if (typeof W.createBackup !== 'function') return

  const { dir } = makeTempFixture()
  const oldNames = Array.from({ length: 12 }, (_, i) => ({
    name: `weeklog-old-device-20260617-12${String(i).padStart(2, '0')}00.json.gz`,
    lastModified: `Wed, 17 Jun 2026 10:${String(i).padStart(2, '0')}:00 GMT`,
  }))
  const calls = []
  const oldFetch = global.fetch
  global.fetch = async (url, opts = {}) => {
    const method = opts.method || 'GET'
    calls.push({ url: String(url), method, body: opts.body || null })
    if (method === 'PROPFIND') {
      const body = String(url).endsWith('/backups/') ? backupXml(oldNames) : backupXml([])
      return { status: 207, text: async () => body }
    }
    if (method === 'PUT') return { status: 201, text: async () => '' }
    if (method === 'DELETE') return { status: 204, text: async () => '' }
    if (method === 'MKCOL') return { status: 201, text: async () => '' }
    return { status: 500, text: async () => 'unexpected' }
  }

  try {
    const result = await W.createBackup({
      cfg: {
        webdav: { url: 'https://dav.example.com/weeklog/', username: 'u', backupRetention: 10 },
        notes: { dir: path.join(dir, 'custom-notes'), enabled: true, miscProject: '日常工作' },
      },
      dir,
      password: 'p',
      deviceName: 'MacBook Pro',
      appVersion: '1.3.3',
      now: new Date(2026, 5, 17, 12, 15, 30),
    })
    const put = calls.find((c) => c.method === 'PUT' && c.url.endsWith('/backups/weeklog-MacBook-Pro-20260617-121530.json.gz'))
    const deletes = calls.filter((c) => c.method === 'DELETE')
    const payload = JSON.parse(zlib.gunzipSync(Buffer.from(put.body)).toString('utf8'))
    ok('备份文件名包含设备名和时间', result.name === 'weeklog-MacBook-Pro-20260617-121530.json.gz', result.name)
    ok('备份上传到 backups 目录', !!put, JSON.stringify(calls.map((c) => ({ method: c.method, url: c.url }))))
    ok('备份内容为 gzip 压缩 JSON', payload.manifest.deviceName === 'MacBook Pro' && payload.manifest.appVersion === '1.3.3')
    ok('备份包含自定义笔记目录内容', payload.files['notes/2026-06-17.md'] === '今天修复 WebDAV 备份')
    ok('备份配置不包含本机仓库路径', !payload.files['config.json'].includes('/Users/me/project'))
    ok('超过保留数会删除旧备份', deletes.length === 3, 'delete=' + deletes.length)
  } finally {
    global.fetch = oldFetch
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

async function testRestoreBackupWritesSnapshotAndPreservesLocalRepos() {
  console.log('\n[2] 从 WebDAV 压缩备份恢复')
  ok('导出 restoreBackup', typeof W.restoreBackup === 'function')
  if (typeof W.restoreBackup !== 'function') return

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-restore-'))
  const notesDir = path.join(dir, 'notes-current')
  fs.mkdirSync(notesDir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    schemaVersion: 2,
    repos: [{ id: 'local', path: '/keep/local/repo', name: 'repo' }],
    notes: { enabled: true, miscProject: '旧日常', dir: notesDir },
    ui: { theme: 'light', quickNoteShortcut: 'CommandOrControl+Shift+L' },
    webdav: { enabled: true, url: 'https://dav.example.com/weeklog/', username: 'u', autoSync: 'push' },
  }, null, 2), 'utf8')

  const backup = {
    manifest: { schemaVersion: 1, createdAt: '2026-06-17T12:15:30.000Z', deviceName: 'MacBook Pro' },
    files: {
      'notes/2026-06-17.md': '恢复后的笔记',
      'memory/entries/m2.md': '恢复后的记忆',
      'memory/index.json': JSON.stringify([{ id: 'm2' }]),
      'history.json': JSON.stringify([{ id: 'h2', text: '恢复后的历史' }]),
      'config.json': JSON.stringify({ schemaVersion: 2, notes: { enabled: true, miscProject: '新日常' }, ui: { theme: 'dark' } }),
    },
  }
  const gz = zlib.gzipSync(Buffer.from(JSON.stringify(backup), 'utf8'))
  const calls = []
  const oldFetch = global.fetch
  global.fetch = async (url, opts = {}) => {
    const method = opts.method || 'GET'
    calls.push({ url: String(url), method })
    if (method === 'GET') {
      return { status: 200, arrayBuffer: async () => gz.buffer.slice(gz.byteOffset, gz.byteOffset + gz.byteLength) }
    }
    if (method === 'PROPFIND') return { status: 207, text: async () => backupXml([]) }
    return { status: 500, text: async () => 'unexpected' }
  }

  try {
    const result = await W.restoreBackup({
      cfg: { webdav: { url: 'https://dav.example.com/weeklog/', username: 'u' }, notes: { dir: notesDir } },
      dir,
      password: 'p',
      name: 'weeklog-MacBook-Pro-20260617-121530.json.gz',
    })
    const restoredConfig = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'))
    ok('恢复会下载选中的备份文件', calls.some((c) => c.method === 'GET' && c.url.endsWith('/backups/weeklog-MacBook-Pro-20260617-121530.json.gz')))
    ok('恢复写回当前笔记目录', fs.readFileSync(path.join(notesDir, '2026-06-17.md'), 'utf8') === '恢复后的笔记')
    ok('恢复写回 memory 和 history', fs.existsSync(path.join(dir, 'memory', 'entries', 'm2.md')) && fs.readFileSync(path.join(dir, 'history.json'), 'utf8').includes('恢复后的历史'))
    ok('恢复配置会保留本机仓库路径', restoredConfig.repos[0].path === '/keep/local/repo')
    ok('恢复配置会应用备份偏好字段', restoredConfig.ui.theme === 'dark' && restoredConfig.notes.miscProject === '新日常')
    ok('恢复结果返回文件数量', result.restoredFiles >= 5, 'restoredFiles=' + result.restoredFiles)
  } finally {
    global.fetch = oldFetch
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

testCreateBackupUploadsCompressedSnapshotAndPrunesOldFiles()
  .then(testRestoreBackupWritesSnapshotAndPreservesLocalRepos)
  .then(() => {
    console.log(`\n结果：${pass} 通过，${fail} 失败\n`)
    process.exit(fail ? 1 : 0)
  })
  .catch((e) => {
    fail++
    console.log('  ✗ WebDAV 备份测试异常  → ' + (e && e.stack || e))
    console.log(`\n结果：${pass} 通过，${fail} 失败\n`)
    process.exit(1)
  })
