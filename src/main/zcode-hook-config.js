'use strict'
// @ts-check
/**
 * ZCode 插件包集成 for WeekLog pending notes.
 *
 * 与 Codex 的单一 hooks.json 不同，ZCode 用插件包系统：一个文件夹含
 * .zcode-plugin/plugin.json + .zcode-plugin-seed.json + hooks/hooks.json。
 *
 * 安装目标在用户目录 ~/.zcode（无需管理员权限）：
 *   - 插件包：~/.zcode/cli/plugins/cache/<marketplace>/<plugin>/<version>/
 *   - 注册：~/.zcode/cli/plugins/marketplaces/<marketplace>/marketplace.json
 *   - 启用：~/.zcode/cli/config.json -> plugins.enabledPlugins["<plugin>@<marketplace>"]
 *
 * 本安装器只管理 WeekLog 自己生成的插件包，保留用户其他 ZCode 插件配置；
 * 写入前一律备份原文件，拒绝改写非法 JSON。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const {
  MAX_SUMMARY_CHARS,
  stripZcodeMetadata,
  trimSummary,
} = require('./zcode-summary')
// 复用 Codex 侧的纯函数（文本提取 / transcript 解析），它们与 ZCode payload 兼容
const {
  textFromValue,
  firstText,
  readTranscriptSummary,
} = require('./codex-hook-config')

const WEEKLOG_HOOK_ID = 'weeklog-zcode-pending-note'
const WEEKLOG_STATUS_MESSAGE = `Saving ZCode pending note (${WEEKLOG_HOOK_ID})`

const MARKETPLACE_NAME = 'weeklog-hooks'
const PLUGIN_NAME = 'weeklog-pending-note'
const PLUGIN_VERSION = '1.0.0'
const PLUGIN_DESCRIPTION = 'ZCode 完成任务后把摘要写入 WeekLog 待处理小记池（由 WeekLog 自动安装）。'

function defaultZcodeHome(env = process.env) {
  return env.ZCODE_HOME || path.join(os.homedir(), '.zcode')
}

function pluginCacheRoot(env = process.env) {
  return path.join(defaultZcodeHome(env), 'cli', 'plugins', 'cache', MARKETPLACE_NAME, PLUGIN_NAME, PLUGIN_VERSION)
}

function marketplaceRoot(env = process.env) {
  return path.join(defaultZcodeHome(env), 'cli', 'plugins', 'marketplaces', MARKETPLACE_NAME)
}

function marketplaceFile(env = process.env) {
  return path.join(marketplaceRoot(env), 'marketplace.json')
}

function zcodeConfigFile(env = process.env) {
  return path.join(defaultZcodeHome(env), 'cli', 'config.json')
}

function timestampForFile(now = () => new Date()) {
  return now().toISOString().replace(/[:.]/g, '-')
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true })
  for (const entry of fs.readdirSync(src)) {
    const from = path.join(src, entry)
    const to = path.join(dest, entry)
    if (fs.statSync(from).isDirectory()) copyDir(from, to)
    else fs.copyFileSync(from, to)
  }
}

function backupFile(file, now) {
  if (!fs.existsSync(file)) return ''
  const backupPath = `${file}.weeklog-backup-${timestampForFile(now)}`
  const stat = fs.statSync(file)
  try {
    if (stat.isDirectory()) copyDir(file, backupPath)
    else fs.copyFileSync(file, backupPath)
  } catch {
    return ''
  }
  return backupPath
}

function readJson(file) {
  if (!fs.existsSync(file)) return { value: null, exists: false }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    return { value: parsed, exists: true }
  } catch (e) {
    return { error: e.message || String(e), exists: true }
  }
}

function writeJson(file, value) {
  const dir = path.dirname(file)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8')
}

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * 从 ZCode Stop 事件 payload 派生任务摘要。
 * ZCode/Claude Code 风格 payload 字段：stop_hook_active、transcript_path、
 * session_id、cwd、hook_event_name 等；助手回复通常需从 transcript JSONL 提取。
 */
function deriveZcodeSummary(event, opts = {}) {
  const e = event && typeof event === 'object' ? event : {}
  const direct = firstText(
    e.final_response,
    e.finalResponse,
    e.final_message,
    e.finalMessage,
    e.assistant_response,
    e.assistantResponse,
    e.output_text,
    e.outputText,
    e.summary,
    e.result && e.result.summary,
    e.result && e.result.text,
    e.result && e.result.output_text,
  )
  if (direct) return direct
  const fromTranscript = readTranscriptSummary(
    firstText(e.transcript_path, e.transcriptPath, e.transcript_file, e.transcriptFile, e.transcript),
    opts.fs || fs
  )
  return fromTranscript
}

/**
 * 生成插件包内 hooks/hooks.json 引用的 post-stop.js 脚本内容。
 * 该脚本由 ZCode 在 Stop 事件触发时执行，stdin 收到事件 JSON，采集 git 上下文后 POST 到 WeekLog。
 */
function buildPostStopScript({ endpoint, token }) {
  return `'use strict'
const fs = require('fs')
const http = require('http')
const cp = require('child_process')
const endpoint = ${JSON.stringify(endpoint)}
const token = ${JSON.stringify(token)}
const MAX_SUMMARY_CHARS = ${MAX_SUMMARY_CHARS}
${stripZcodeMetadata.toString()}
${trimSummary.toString()}
${textFromValue.toString()}
${firstText.toString()}
${readTranscriptSummary.toString()}
${deriveZcodeSummary.toString()}
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
const event = parseInput()
const summary = deriveZcodeSummary(event, { fs })
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
  source: 'zcode',
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

function buildPluginJson() {
  return {
    name: PLUGIN_NAME,
    version: PLUGIN_VERSION,
    description: PLUGIN_DESCRIPTION,
    author: { name: 'WeekLog' },
    license: 'MIT',
  }
}

function buildSeedJson() {
  return {
    hash: sha256(PLUGIN_NAME + '@' + PLUGIN_VERSION),
    marketplace: MARKETPLACE_NAME,
    plugin: PLUGIN_NAME,
    pluginVersion: PLUGIN_VERSION,
    source: 'filesystem',
    version: 1,
  }
}

function buildHooksJson() {
  // ZCode 插件 hook 命令可用 ${CLAUDE_PLUGIN_ROOT} 变量定位插件根
  return {
    hooks: {
      Stop: [
        {
          hooks: [
            {
              type: 'command',
              command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/post-stop.js"',
              timeout: 30,
              statusMessage: WEEKLOG_STATUS_MESSAGE,
            },
          ],
        },
      ],
    },
  }
}

function buildPackageJson() {
  return {
    name: `@weeklog/${PLUGIN_NAME}`,
    version: PLUGIN_VERSION,
    private: true,
    license: 'MIT',
    description: PLUGIN_DESCRIPTION,
  }
}

function buildZcodeHookSnippet({ endpoint, token }) {
  // 供「复制配置片段」使用：展示插件包结构与注册步骤
  const pluginJson = JSON.stringify(buildPluginJson(), null, 2)
  const hooksJson = JSON.stringify(buildHooksJson(), null, 2)
  return [
    `# WeekLog ZCode Hook 安装说明`,
    ``,
    `1) 在 ZCode 用户目录创建插件包：`,
    `   ~/.zcode/cli/plugins/cache/${MARKETPLACE_NAME}/${PLUGIN_NAME}/${PLUGIN_VERSION}/`,
    `   ├─ .zcode-plugin/plugin.json`,
    `   ├─ hooks/hooks.json`,
    `   └─ hooks/post-stop.js`,
    ``,
    `2) plugin.json：`,
    pluginJson,
    ``,
    `3) hooks/hooks.json（Stop 事件触发 post-stop.js）：`,
    hooksJson,
    ``,
    `4) post-stop.js 内的 endpoint 与 token（由 WeekLog 一键安装自动写入）：`,
    `   endpoint = ${endpoint}`,
    `   token    = ${token}`,
    ``,
    `5) 注册到 marketplace.json 并在 config.json 启用：`,
    `   enabledPlugins: { "${PLUGIN_NAME}@${MARKETPLACE_NAME}": true }`,
  ].join('\n')
}

function isManagedWeekLogPlugin(hook) {
  return !!(
    hook &&
    typeof hook === 'object' &&
    (
      hook.weeklogHookId === WEEKLOG_HOOK_ID ||
      (typeof hook.statusMessage === 'string' && hook.statusMessage.includes(WEEKLOG_HOOK_ID))
    )
  )
}

function emptyDir(dir) {
  if (!fs.existsSync(dir)) return
  for (const entry of fs.readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (fs.statSync(full).isDirectory()) {
      emptyDir(full)
      try { fs.rmdirSync(full) } catch {}
    } else {
      try { fs.unlinkSync(full) } catch {}
    }
  }
}

function writePluginPackage(root, { endpoint, token }) {
  fs.mkdirSync(path.join(root, '.zcode-plugin'), { recursive: true })
  fs.mkdirSync(path.join(root, 'hooks'), { recursive: true })
  writeJson(path.join(root, '.zcode-plugin', 'plugin.json'), buildPluginJson())
  writeJson(path.join(root, '.zcode-plugin-seed.json'), buildSeedJson())
  writeJson(path.join(root, 'package.json'), buildPackageJson())
  writeJson(path.join(root, 'hooks', 'hooks.json'), buildHooksJson())
  fs.writeFileSync(
    path.join(root, 'hooks', 'post-stop.js'),
    buildPostStopScript({ endpoint, token }),
    'utf8'
  )
}

function upsertMarketplace(env, now) {
  const file = marketplaceFile(env)
  const read = readJson(file)
  if (read.error) return { error: `ZCode marketplace.json 不是有效 JSON：${read.error}` }
  const data = read.value && typeof read.value === 'object' && !Array.isArray(read.value)
    ? read.value
    : { name: MARKETPLACE_NAME, plugins: [], version: 1 }
  if (!Array.isArray(data.plugins)) data.plugins = []
  // 去重：移除同名旧条目
  const before = data.plugins.length
  data.plugins = data.plugins.filter((p) => !p || p.name !== PLUGIN_NAME)
  const removedCount = before - data.plugins.length
  data.plugins.push({
    cachePath: pluginCacheRoot(env),
    name: PLUGIN_NAME,
    source: 'filesystem',
    version: PLUGIN_VERSION,
  })
  const backupPath = read.exists ? backupFile(file, now) : ''
  writeJson(file, data)
  return { ok: true, backupPath, removedCount }
}

function removeFromMarketplace(env, now) {
  const file = marketplaceFile(env)
  const read = readJson(file)
  if (read.error) return { error: `ZCode marketplace.json 不是有效 JSON：${read.error}` }
  if (!read.exists || !read.value || !Array.isArray(read.value.plugins)) {
    return { ok: true, removed: 0 }
  }
  const before = read.value.plugins.length
  read.value.plugins = read.value.plugins.filter((p) => !p || p.name !== PLUGIN_NAME)
  const removed = before - read.value.plugins.length
  if (!removed) return { ok: true, removed: 0 }
  const backupPath = backupFile(file, now)
  writeJson(file, read.value)
  return { ok: true, removed, backupPath }
}

function upsertEnabledFlag(env, now) {
  const file = zcodeConfigFile(env)
  const read = readJson(file)
  if (read.error) return { error: `ZCode config.json 不是有效 JSON：${read.error}` }
  const data = read.value && typeof read.value === 'object' && !Array.isArray(read.value)
    ? read.value
    : {}
  if (!data.plugins || typeof data.plugins !== 'object') data.plugins = {}
  if (!data.plugins.enabledPlugins || typeof data.plugins.enabledPlugins !== 'object') {
    data.plugins.enabledPlugins = {}
  }
  const key = `${PLUGIN_NAME}@${MARKETPLACE_NAME}`
  const wasEnabled = !!data.plugins.enabledPlugins[key]
  data.plugins.enabledPlugins[key] = true
  const backupPath = read.exists ? backupFile(file, now) : ''
  writeJson(file, data)
  return { ok: true, backupPath, wasEnabled }
}

function removeFromEnabledFlag(env, now) {
  const file = zcodeConfigFile(env)
  const read = readJson(file)
  if (read.error) return { error: `ZCode config.json 不是有效 JSON：${read.error}` }
  if (!read.exists || !read.value || !read.value.plugins || !read.value.plugins.enabledPlugins) {
    return { ok: true, removed: 0 }
  }
  const key = `${PLUGIN_NAME}@${MARKETPLACE_NAME}`
  const had = key in read.value.plugins.enabledPlugins
  if (!had) return { ok: true, removed: 0 }
  delete read.value.plugins.enabledPlugins[key]
  const backupPath = backupFile(file, now)
  writeJson(file, read.value)
  return { ok: true, removed: 1, backupPath }
}

function installZcodeHook({ env = process.env, endpoint, token, now = () => new Date() } = {}) {
  if (!endpoint || !token) return { ok: false, installed: false, error: '缺少 endpoint 或 token' }
  const pluginRoot = pluginCacheRoot(env)

  // 备份旧插件包（目录递归复制）后清空重写（幂等：覆盖即替换）
  const pluginBackup = backupFile(pluginRoot, now)
  if (fs.existsSync(pluginRoot)) emptyDir(pluginRoot)
  try {
    writePluginPackage(pluginRoot, { endpoint, token })
  } catch (e) {
    return { ok: false, installed: false, error: `写入插件包失败：${e.message || e}` }
  }

  const market = upsertMarketplace(env, now)
  if (market.error) return { ok: false, installed: false, error: market.error }
  const flag = upsertEnabledFlag(env, now)
  if (flag.error) return { ok: false, installed: false, error: flag.error }

  return {
    ok: true,
    installed: true,
    pluginPath: pluginRoot,
    marketplacePath: marketplaceFile(env),
    configPath: zcodeConfigFile(env),
    backups: [pluginBackup, market.backupPath, flag.backupPath].filter(Boolean),
  }
}

function uninstallZcodeHook({ env = process.env, now = () => new Date() } = {}) {
  const pluginRoot = pluginCacheRoot(env)
  const backups = []
  let removedFiles = 0
  if (fs.existsSync(pluginRoot)) {
    emptyDir(pluginRoot)
    try { fs.rmSync(pluginRoot, { recursive: true, force: true }); removedFiles++ } catch {}
  }
  const market = removeFromMarketplace(env, now)
  if (market.error) return { ok: false, removed: removedFiles, error: market.error }
  if (market.backupPath) backups.push(market.backupPath)
  const flag = removeFromEnabledFlag(env, now)
  if (flag.error) return { ok: false, removed: removedFiles, error: flag.error }
  if (flag.backupPath) backups.push(flag.backupPath)
  return {
    ok: true,
    removed: removedFiles + (market.removed || 0) + (flag.removed || 0),
    pluginPath: pluginRoot,
    marketplacePath: marketplaceFile(env),
    configPath: zcodeConfigFile(env),
    backups,
  }
}

function getZcodeHookInstallStatus({ env = process.env } = {}) {
  const pluginRoot = pluginCacheRoot(env)
  const hooksJsonPath = path.join(pluginRoot, 'hooks', 'hooks.json')
  let installed = false
  let hookCount = 0
  let hookError = ''
  if (fs.existsSync(hooksJsonPath)) {
    const read = readJson(hooksJsonPath)
    if (read.error) {
      hookError = `ZCode 插件 hooks.json 不是有效 JSON：${read.error}`
    } else {
      const groups = read.value && read.value.hooks && Array.isArray(read.value.hooks.Stop) ? read.value.hooks.Stop : []
      for (const group of groups) {
        const hooks = group && Array.isArray(group.hooks) ? group.hooks : []
        hookCount += hooks.filter(isManagedWeekLogPlugin).length
      }
      installed = hookCount > 0
    }
  }
  // 检查 marketplace 注册与启用状态
  let registered = false
  const marketRead = readJson(marketplaceFile(env))
  if (!marketRead.error && marketRead.value && Array.isArray(marketRead.value.plugins)) {
    registered = marketRead.value.plugins.some((p) => p && p.name === PLUGIN_NAME)
  }
  let enabled = false
  const cfgRead = readJson(zcodeConfigFile(env))
  if (!cfgRead.error && cfgRead.value && cfgRead.value.plugins && cfgRead.value.plugins.enabledPlugins) {
    enabled = !!cfgRead.value.plugins.enabledPlugins[`${PLUGIN_NAME}@${MARKETPLACE_NAME}`]
  }
  return {
    pluginPath: pluginRoot,
    marketplacePath: marketplaceFile(env),
    configPath: zcodeConfigFile(env),
    exists: fs.existsSync(pluginRoot),
    installed,
    registered,
    enabled,
    hookCount,
    error: hookError,
  }
}

module.exports = {
  WEEKLOG_HOOK_ID,
  WEEKLOG_STATUS_MESSAGE,
  MARKETPLACE_NAME,
  PLUGIN_NAME,
  PLUGIN_VERSION,
  defaultZcodeHome,
  pluginCacheRoot,
  marketplaceFile,
  zcodeConfigFile,
  deriveZcodeSummary,
  buildPostStopScript,
  buildPluginJson,
  buildSeedJson,
  buildHooksJson,
  buildPackageJson,
  buildZcodeHookSnippet,
  isManagedWeekLogPlugin,
  installZcodeHook,
  uninstallZcodeHook,
  getZcodeHookInstallStatus,
}
