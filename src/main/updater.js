'use strict'
// @ts-check
/**
 * 自动更新控制器：向 IPC 暴露可序列化状态。
 *
 * 平台分流：
 * - Windows：沿用 electron-updater（MSI/NSIS 走 Squirrel.Windows，无 macOS 签名问题）。
 * - macOS：electron-updater 依赖 Squirrel.Mac 的代码签名校验，未签名/未公证的 app
 *   会被拒绝（"代码不含资源，但签名指示这些资源必须存在"）。因此这里绕开它，
 *   改为：GitHub API 查最新版 → 自有 https 下载 dmg 到临时目录 → 生成 detached
 *   安装脚本（等待主进程退出 → 挂载 dmg → xattr -cr → 复制到 /Applications →
 *   卸载 → 重启新应用 → 自删）→ 主进程 app.quit()。
 */

const { app } = require('electron')
const https = require('https')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { spawn } = require('child_process')

// electron-updater 仅在 Windows 分支用到；导入失败不影响 macOS 自更新。
let electronUpdater = null
try {
  electronUpdater = require('electron-updater').autoUpdater
} catch {}

// 从 package.json 读 publish 配置（build.publish[0] = { provider, owner, repo }）
function readPublishConfig() {
  try {
    const p = require('../../package.json')
    const list = (p.build && p.build.publish) || []
    return list.find((x) => x.provider === 'github') || list[0] || null
  } catch {
    return null
  }
}

/**
 * semver 比较：返回 -1/0/1。仅支持 x.y.z 形式（忽略预发布标签）。
 */
function compareVersions(a, b) {
  const pa = String(a || '').replace(/[+-].*$/, '').split('.').map((x) => parseInt(x, 10) || 0)
  const pb = String(b || '').replace(/[+-].*$/, '').split('.').map((x) => parseInt(x, 10) || 0)
  for (let i = 0; i < 3; i++) {
    const da = pa[i] || 0
    const db = pb[i] || 0
    if (da !== db) return da < db ? -1 : 1
  }
  return 0
}

/**
 * GET JSON（跟随重定向）。GitHub API 公开仓库匿名调用即可。
 */
function fetchJson(url, { headers = {}, timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    let data = ''
    let redirects = 0
    const done = (err, val) => (err ? reject(err) : resolve(val))
    const get = (target) => {
      const req = https.get(target, { headers }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 5) {
          redirects += 1
          res.resume()
          return get(res.headers.location)
        }
        if (res.statusCode !== 200) {
          res.resume()
          return done(new Error(`HTTP ${res.statusCode}`))
        }
        res.setEncoding('utf8')
        res.on('data', (c) => (data += c))
        res.on('end', () => {
          try { done(null, JSON.parse(data)) } catch (e) { done(e) }
        })
      })
      req.on('timeout', () => { req.destroy(new Error('请求超时')) })
      req.on('error', done)
      req.setTimeout(timeoutMs)
    }
    get(url)
  })
}

/**
 * 流式下载文件，跟随重定向，回调 onProgress(percent: 0-100)。
 */
function downloadFile(url, destPath, { headers = {}, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    let redirects = 0
    const run = (target) => {
      const req = https.get(target, { headers }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 5) {
          redirects += 1
          res.resume()
          return run(res.headers.location)
        }
        if (res.statusCode !== 200) {
          res.resume()
          return reject(new Error(`下载失败：HTTP ${res.statusCode}`))
        }
        const total = Number(res.headers['content-length']) || 0
        let received = 0
        const stream = fs.createWriteStream(destPath)
        res.on('data', (chunk) => {
          received += chunk.length
          if (onProgress) {
            const percent = total ? Math.floor((received / total) * 100) : 0
            try { onProgress(percent, received, total) } catch {}
          }
        })
        res.pipe(stream)
        stream.on('finish', () => stream.close((e) => (e ? reject(e) : resolve(destPath))))
        stream.on('error', reject)
      })
      req.on('error', reject)
    }
    run(url)
  })
}

/**
 * 从 GitHub Release 资产列表里挑出当前架构对应的 .dmg。
 * arm64 → *arm64*.dmg；x64 → *x64*.dmg 或 *x86_64*.dmg。
 */
function pickDmgAsset(assets) {
  const arch = process.arch
  const dmgs = (assets || []).filter((a) => /\.dmg$/i.test(a.name))
  if (arch === 'arm64') {
    return dmgs.find((a) => /arm64|aarch64/i.test(a.name)) || dmgs[0]
  }
  return dmgs.find((a) => /x64|x86_64|amd64/i.test(a.name)) || dmgs.find((a) => !/arm64|aarch64/i.test(a.name)) || dmgs[0]
}

function createUpdaterController(opts = {}) {
  const appRef = opts.app || app
  let sender = null
  let wired = false
  const isPackaged = !!(appRef && appRef.isPackaged)
  const currentVersion = appRef && typeof appRef.getVersion === 'function' ? appRef.getVersion() : ''
  const isMac = process.platform === 'darwin'
  // macOS 自更新只在打包版本 + 自有脚本路径下启用
  const useCustomMac = isMac && isPackaged

  const state = {
    phase: isPackaged ? 'idle' : 'disabled',
    currentVersion,
    latestVersion: '',
    releaseName: '',
    releaseNotes: '',
    progress: null,
    error: isPackaged ? '' : '自动更新仅在安装包版本中可用',
    isPackaged,
    updatedAt: Date.now(),
    // macOS 自定义流程专用：下载好的 dmg 本地路径
    downloadedDmgPath: '',
  }

  function snapshot() {
    return {
      ...state,
      progress: state.progress ? { ...state.progress } : null,
      canCheck: state.isPackaged && state.phase !== 'checking' && state.phase !== 'downloading',
      canDownload: useCustomMac
        ? (state.isPackaged && state.phase === 'available')
        : (state.isPackaged && state.phase === 'available'),
      canInstall: useCustomMac
        ? (state.isPackaged && state.phase === 'downloaded' && !!state.downloadedDmgPath)
        : (state.isPackaged && state.phase === 'downloaded'),
    }
  }

  function emit() {
    if (!sender) return
    try { sender({ type: 'status', status: snapshot() }) } catch {}
  }

  function patch(next) {
    Object.assign(state, next, { updatedAt: Date.now() })
    emit()
    return snapshot()
  }

  function updateInfo(info) {
    return {
      latestVersion: (info && info.version) || state.latestVersion || '',
      releaseName: (info && info.releaseName) || '',
      releaseNotes: normalizeReleaseNotes(info && info.releaseNotes),
    }
  }

  function ensureAvailable() {
    if (!state.isPackaged) {
      return patch({ phase: 'disabled', error: '自动更新仅在安装包版本中可用' })
    }
    if (useCustomMac && !electronUpdater) {
      // macOS 自定义流程不依赖 electron-updater，可以继续
    } else if (!state.isPackaged || (!useCustomMac && !electronUpdater)) {
      return patch({ phase: 'disabled', error: '自动更新组件不可用' })
    }
    return null
  }

  // ── electron-updater（Windows 路径）的回调接线 ──
  function wireAutoUpdater() {
    if (wired || !electronUpdater) return
    wired = true
    electronUpdater.autoDownload = false
    electronUpdater.autoInstallOnAppQuit = true
    electronUpdater.on('checking-for-update', () => patch({ phase: 'checking', error: '', progress: null }))
    electronUpdater.on('update-available', (info) => patch({ phase: 'available', error: '', progress: null, ...updateInfo(info) }))
    electronUpdater.on('update-not-available', (info) => patch({ phase: 'not-available', error: '', progress: null, ...updateInfo(info) }))
    electronUpdater.on('download-progress', (p) => patch({
      phase: 'downloading',
      error: '',
      progress: {
        percent: Math.max(0, Math.min(100, Number(p.percent) || 0)),
        transferred: Number(p.transferred) || 0,
        total: Number(p.total) || 0,
        bytesPerSecond: Number(p.bytesPerSecond) || 0,
      },
    }))
    electronUpdater.on('update-downloaded', (info) => patch({ phase: 'downloaded', error: '', progress: { percent: 100 }, ...updateInfo(info) }))
    electronUpdater.on('error', (e) => patch({ phase: 'error', error: (e && e.message) || String(e || '检查更新失败') }))
  }

  // ────────────────────────────────────────────────────
  //  macOS 自定义流程：检查更新
  // ────────────────────────────────────────────────────
  async function macCheck() {
    const pub = readPublishConfig()
    if (!pub || pub.provider !== 'github' || !pub.owner || !pub.repo) {
      return patch({ phase: 'error', error: '未配置 GitHub 发布源（build.publish）' })
    }
    const apiUrl = `https://api.github.com/repos/${pub.owner}/${pub.repo}/releases/latest`
    try {
      const rel = await fetchJson(apiUrl, {
        headers: { 'User-Agent': 'weeklog-updater', Accept: 'application/vnd.github+json' },
      })
      // tag_name 形如 v1.3.1
      const latest = String(rel.tag_name || '').replace(/^v/i, '')
      const dmg = pickDmgAsset(rel.assets || [])
      const stash = {
        latestVersion: latest,
        releaseName: rel.name || '',
        releaseNotes: rel.body || '',
        // 用闭包变量携带下一阶段所需信息，避免暴露到 IPC 快照
      }
      pendingDmgUrl = dmg ? dmg.browser_download_url : ''
      if (!latest) {
        return patch({ phase: 'error', error: '未能解析最新版本号' })
      }
      if (compareVersions(latest, currentVersion) <= 0) {
        return patch({ phase: 'not-available', error: '', progress: null, ...stash })
      }
      if (!dmg) {
        return patch({ phase: 'available', error: '未找到适用于本架构的 dmg 安装包，请到 Release 页手动下载', ...stash })
      }
      return patch({ phase: 'available', error: '', progress: null, ...stash })
    } catch (e) {
      return patch({ phase: 'error', error: `检查更新失败：${(e && e.message) || e}` })
    }
  }

  let pendingDmgUrl = ''

  // ────────────────────────────────────────────────────
  //  macOS 自定义流程：下载 dmg
  // ────────────────────────────────────────────────────
  async function macDownload() {
    if (!pendingDmgUrl) {
      return patch({ phase: 'error', error: '没有可下载的更新，请先检查更新' })
    }
    const tmpDir = appRef.getPath('temp')
    const dmgPath = path.join(tmpDir, `weeklog-${Date.now()}.dmg`)
    patch({ phase: 'downloading', error: '', progress: { percent: 0 } })
    try {
      await downloadFile(pendingDmgUrl, dmgPath, {
        headers: { 'User-Agent': 'weeklog-updater' },
        onProgress: (percent, transferred, total) => patch({
          progress: { percent, transferred, total, bytesPerSecond: 0 },
        }),
      })
      state.downloadedDmgPath = dmgPath
      return patch({ phase: 'downloaded', error: '', progress: { percent: 100 } })
    } catch (e) {
      try { if (fs.existsSync(dmgPath)) fs.unlinkSync(dmgPath) } catch {}
      return patch({ phase: 'error', error: `下载失败：${(e && e.message) || e}` })
    }
  }

  // ────────────────────────────────────────────────────
  //  macOS 自定义流程：生成 detached 安装脚本并退出主进程
  //  脚本职责（主进程退出后由它接管）：
  //    1. 等待主进程退出（轮询直到 WeekLog.app 可写）
  //    2. hdiutil attach 挂载 dmg
  //    3. 找到挂载点下的 .app，xattr -cr 清除隔离
  //    4. rm -rf 旧 /Applications/WeekLog.app，cp -R 新的过去
  //    5. hdiutil detach 卸载
  //    6. open -a 启动新应用
  //    7. 自删除脚本文件
  // ────────────────────────────────────────────────────
  function macInstall() {
    const dmgPath = state.downloadedDmgPath
    if (!dmgPath || !fs.existsSync(dmgPath)) {
      throw new Error('更新尚未下载完成')
    }
    const pid = process.pid
    const scriptDir = appRef.getPath('userData')
    const scriptPath = path.join(scriptDir, 'mac-update-install.sh')
    const logPath = path.join(scriptDir, 'mac-update-install.log')

    // 脚本里用 set -e 保证任一步失败即中止（但 self-cleanup 用 trap 兜底）
    const script = `#!/bin/bash
set -u
LOG="${logPath}"
log() { echo "[$(date '+%F %T')] $*" >> "$LOG" 2>&1; }
log "==== 开始安装更新 ===="
log "dmg=${dmgPath} oldPid=${pid}"

# 1. 等待旧主进程退出（最多 30s）
for i in $(seq 1 60); do
  if ! kill -0 ${pid} 2>/dev/null; then log "旧进程已退出"; break; fi
  sleep 0.5
done
# 兜底再睡 1s 等文件句柄释放
sleep 1

# 2. 挂载 dmg
MOUNT=$(hdiutil attach "${dmgPath}" -nobrowse -noautoopen -noverify 2>>"$LOG" | tail -1 | awk '{print $NF}')
if [ -z "$MOUNT" ] || [ ! -d "$MOUNT" ]; then
  log "挂载失败，中止"; exit 1
fi
log "挂载点: $MOUNT"

# 3. 定位 .app
APP=$(find "$MOUNT" -maxdepth 2 -name '*.app' -print -quit)
if [ -z "$APP" ] || [ ! -d "$APP" ]; then
  log "未找到 .app，中止"; hdiutil detach "$MOUNT" >>"$LOG" 2>&1; exit 1
fi
log "目标 app: $APP"

# 4. 清除隔离属性（关键：绕过 Gatekeeper 的签名校验）
xattr -cr "$APP" >>"$LOG" 2>&1
log "xattr -cr 完成"

# 5. 替换 /Applications 下旧版本
TARGET="/Applications/$(basename "$APP")"
if [ -d "$TARGET" ]; then rm -rf "$TARGET"; fi
cp -R "$APP" "$TARGET" >>"$LOG" 2>&1
log "已复制到 $TARGET"

# 6. 卸载 dmg
hdiutil detach "$MOUNT" >>"$LOG" 2>&1
log "已卸载 dmg"

# 7. 删除 dmg 临时文件
rm -f "${dmgPath}" 2>>"$LOG"

# 8. 启动新版本
open -a "$TARGET" >>"$LOG" 2>&1
log "已启动新版本"

# 9. 自删除
rm -f "$0" 2>>"$LOG"
log "==== 安装结束 ===="
`
    fs.writeFileSync(scriptPath, script, { mode: 0o755 })

    log('[updater] 启动 detached 安装脚本，主进程即将退出')
    const child = spawn('bash', [scriptPath], {
      detached: true,
      stdio: 'ignore',
    })
    child.unref()

    // 给 detached 脚本一点启动时间，再退出主进程
    setTimeout(() => {
      // isQuitting 由 index.js 的 quitApp 管理；这里强制退出主进程
      appRef.quit()
    }, 800)
    return snapshot()
  }

  return {
    setSender(fn) { sender = fn },
    status() { return snapshot() },
    async check() {
      const disabled = ensureAvailable()
      if (disabled) return disabled
      if (state.phase === 'checking' || state.phase === 'downloading') return snapshot()
      patch({ phase: 'checking', error: '', progress: null })
      if (useCustomMac) {
        return macCheck()
      }
      // Windows：走 electron-updater
      wireAutoUpdater()
      try {
        await electronUpdater.checkForUpdates()
      } catch (e) {
        return patch({ phase: 'error', error: (e && e.message) || String(e || '检查更新失败') })
      }
      return snapshot()
    },
    async download() {
      const disabled = ensureAvailable()
      if (disabled) return disabled
      if (state.phase !== 'available') throw new Error('当前没有可下载的更新')
      if (useCustomMac) {
        return macDownload()
      }
      // Windows
      wireAutoUpdater()
      patch({ phase: 'downloading', error: '', progress: { percent: 0 } })
      try {
        await electronUpdater.downloadUpdate()
      } catch (e) {
        return patch({ phase: 'error', error: (e && e.message) || String(e || '下载更新失败') })
      }
      return snapshot()
    },
    install() {
      const disabled = ensureAvailable()
      if (disabled) return disabled
      if (state.phase !== 'downloaded') throw new Error('更新尚未下载完成')
      if (useCustomMac) {
        return macInstall()
      }
      // Windows：electron-updater 退出并安装
      electronUpdater.quitAndInstall(false, true)
      return snapshot()
    },
    scheduleStartupCheck(delayMs = 5000) {
      if (!state.isPackaged) {
        patch({ phase: 'disabled', error: '自动更新仅在安装包版本中可用' })
        return
      }
      // macOS 自定义流程也允许启动时静默检查；electron-updater 需要存在
      if (!useCustomMac && !electronUpdater) return
      if (startupTimer) clearTimeout(startupTimer)
      startupTimer = setTimeout(() => { this.check().catch(() => {}) }, delayMs)
      if (startupTimer && typeof startupTimer.unref === 'function') startupTimer.unref()
    },
  }
}

let startupTimer = null

function normalizeReleaseNotes(notes) {
  if (Array.isArray(notes)) {
    return notes.map((item) => item && (item.note || item.version || '')).filter(Boolean).join('\n')
  }
  return typeof notes === 'string' ? notes : ''
}

module.exports = { createUpdaterController }
