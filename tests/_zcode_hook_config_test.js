'use strict'
/* ZCode engine plugin install/uninstall behavior, isolated via ZCODE_HOME. */
const fs = require('fs')
const os = require('os')
const path = require('path')

const hookConfig = require('../src/main/zcode-hook-config')

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

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wl_zcode_hook_config_'))
// 模拟 ~/.zcode（通过 ZCODE_HOME 覆盖），隔离真实插件目录
const env = { ZCODE_HOME: dir }
const endpoint = 'http://127.0.0.1:17322/api/zcode/pending-notes'
const token = 'token-zcode-a'
const MP = hookConfig.OFFICIAL_MARKETPLACE

console.log('\n[1] path and plugin package generation')
ok('plugins root under ZCODE_HOME/cli/plugins', hookConfig.pluginsRoot(env) === path.join(dir, 'cli', 'plugins'))
ok('plugin cache root uses official marketplace', hookConfig.pluginCacheRoot(env) === path.join(dir, 'cli', 'plugins', 'cache', MP, hookConfig.PLUGIN_NAME, hookConfig.PLUGIN_VERSION))
ok('config.json under ZCODE_HOME/cli', hookConfig.zcodeConfigFile(env) === path.join(dir, 'cli', 'config.json'))

const pluginJson = hookConfig.buildPluginJson()
ok('plugin.json has name/version', pluginJson.name === hookConfig.PLUGIN_NAME && pluginJson.version === hookConfig.PLUGIN_VERSION)
const hooksJson = hookConfig.buildHooksJson()
ok('hooks.json uses Stop event', JSON.stringify(hooksJson).includes('"Stop"'))
ok('hooks.json command references CLAUDE_PLUGIN_ROOT', JSON.stringify(hooksJson).includes('${CLAUDE_PLUGIN_ROOT}'))
const managedHook = hooksJson.hooks.Stop[0].hooks[0]
ok('generated hook has stable WeekLog marker', hookConfig.isManagedWeekLogPlugin(managedHook))
const seed = hookConfig.buildSeedJson()
ok('seed marketplace is the official one', seed.marketplace === MP)
ok('snippet includes endpoint and token', hookConfig.buildZcodeHookSnippet({ endpoint, token }).includes(endpoint) && hookConfig.buildZcodeHookSnippet({ endpoint, token }).includes(token))

console.log('\n[1b] summary extraction')
ok(
  'summary prefers ZCode final response fields',
  hookConfig.deriveZcodeSummary({
    changedFiles: ['src/main/ipc.js'],
    final_response: '实现了 ZCode Hook 小记待处理池，并补充一键安装。'
  }) === '实现了 ZCode Hook 小记待处理池，并补充一键安装。'
)
const transcriptPath = path.join(dir, 'transcript.jsonl')
fs.writeFileSync(transcriptPath, [
  JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '帮我修 hook 摘要' }] } }),
  JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '修复了 Stop hook 摘要提取逻辑，候选小记现在会记录任务要点。' }] } }),
].join('\n'), 'utf8')
ok(
  'summary can be read from transcript path',
  hookConfig.deriveZcodeSummary({ transcript_path: transcriptPath }) === '修复了 Stop hook 摘要提取逻辑，候选小记现在会记录任务要点。'
)
ok(
  'summary reads GLM/ZCode responsePreview field (camelCase Stop payload, no transcript)',
  hookConfig.deriveZcodeSummary({
    cwd: '/repo',
    hookEventName: 'Stop',
    mode: 'normal',
    responsePreview: '已修复 ZCode hook 的 summary 提取，现在能识别 responsePreview 字段。',
    sessionId: 'sess_x',
    timestamp: '2026-06-23T08:50:00Z',
    toolCallCount: 2,
    traceId: 't1',
    turnId: 'u1',
  }) === '已修复 ZCode hook 的 summary 提取，现在能识别 responsePreview 字段。'
)
ok(
  'missing summary returns empty',
  hookConfig.deriveZcodeSummary({ changedFiles: ['only/file.ts'] }) === ''
)
ok('post-stop script skips POST when summary is empty', hookConfig.buildPostStopScript({ endpoint, token }).includes('if (!summary) process.exit(0)'))

console.log('\n[2] install writes plugin package under official marketplace + enables in config.json')
const installA = hookConfig.installZcodeHook({ env, endpoint, token, now: () => new Date('2026-06-23T08:00:00.000Z') })
ok('install succeeds', installA.ok && installA.installed)
ok('plugin package .zcode-plugin/plugin.json exists', fs.existsSync(path.join(hookConfig.pluginCacheRoot(env), '.zcode-plugin', 'plugin.json')))
ok('plugin sits under cache/zcode-plugins-official/', hookConfig.pluginCacheRoot(env).includes(path.join('cache', MP, hookConfig.PLUGIN_NAME)))
ok('seed.json written', fs.existsSync(path.join(hookConfig.pluginCacheRoot(env), '.zcode-plugin-seed.json')))
ok('hooks.json written', fs.existsSync(path.join(hookConfig.pluginCacheRoot(env), 'hooks', 'hooks.json')))
ok('post-stop.js embeds endpoint', fs.readFileSync(path.join(hookConfig.pluginCacheRoot(env), 'hooks', 'post-stop.js'), 'utf8').includes(endpoint))
const cfg = readJson(hookConfig.zcodeConfigFile(env))
ok('enabledPlugins key uses official marketplace', cfg.plugins.enabledPlugins[`${hookConfig.PLUGIN_NAME}@${MP}`] === true)
const marketFile = path.join(hookConfig.pluginsRoot(env), 'marketplaces', MP, 'marketplace.json')
ok('marketplace.json records the plugin', readJson(marketFile).plugins.some((p) => p.name === hookConfig.PLUGIN_NAME))

console.log('\n[3] install is idempotent and refreshes token/endpoint')
const installB = hookConfig.installZcodeHook({ env, endpoint: 'http://127.0.0.1:17399/api/zcode/pending-notes', token: 'token-zcode-b', now: () => new Date('2026-06-23T08:01:00.000Z') })
ok('reinstall succeeds', installB.ok && installB.installed)
ok('marketplace.json has exactly one entry after reinstall', readJson(marketFile).plugins.filter((p) => p.name === hookConfig.PLUGIN_NAME).length === 1)
ok('post-stop.js refreshed to new endpoint', fs.readFileSync(path.join(hookConfig.pluginCacheRoot(env), 'hooks', 'post-stop.js'), 'utf8').includes('17399'))

console.log('\n[4] status detects install')
const status = hookConfig.getZcodeHookInstallStatus({ env })
ok('status detects installed hook', status.installed && status.hookCount === 1)
ok('status detects registration', status.registered)
ok('status detects enabled', status.enabled)

console.log('\n[5] install preserves existing user plugins/config')
// 预置一个用户其他已启用插件 + 其他官方 marketplace 条目
const cfgFile = hookConfig.zcodeConfigFile(env)
// 同时预置一个与插件无关的顶层字段（如 mcp.servers），验证不会被擦除
const userCfg = readJson(cfgFile)
userCfg.plugins.enabledPlugins['some-other-plugin@zcode-plugins-official'] = true
userCfg.mcp = { servers: { 'my-mcp': { type: 'stdio', command: 'foo' } } }
fs.writeFileSync(cfgFile, JSON.stringify(userCfg), 'utf8')
const userMarket = readJson(marketFile)
userMarket.plugins.push({ cachePath: '/x', name: 'user-other-plugin', source: 'filesystem', version: '1.0.0' })
fs.writeFileSync(marketFile, JSON.stringify(userMarket), 'utf8')
hookConfig.installZcodeHook({ env, endpoint, token, now: () => new Date('2026-06-23T08:02:00.000Z') })
ok('preserves other enabled plugin', readJson(cfgFile).plugins.enabledPlugins['some-other-plugin@zcode-plugins-official'] === true)
ok('preserves unrelated config.json fields (mcp.servers)', readJson(cfgFile).mcp.servers['my-mcp'].command === 'foo')
ok('preserves other marketplace plugin', readJson(marketFile).plugins.some((p) => p.name === 'user-other-plugin'))

console.log('\n[6] uninstall removes WeekLog plugin only')
const uninstall = hookConfig.uninstallZcodeHook({ env, now: () => new Date('2026-06-23T08:03:00.000Z') })
ok('uninstall succeeds', uninstall.ok)
ok('uninstall reports removed entries', uninstall.removed >= 1)
ok('plugin package removed', !fs.existsSync(path.join(hookConfig.pluginCacheRoot(env), '.zcode-plugin', 'plugin.json')))
ok('marketplace entry removed', !readJson(marketFile).plugins.some((p) => p.name === hookConfig.PLUGIN_NAME))
ok('enabledPlugins entry removed', !(`${hookConfig.PLUGIN_NAME}@${MP}` in readJson(cfgFile).plugins.enabledPlugins))
ok('preserves other enabled plugin after uninstall', readJson(cfgFile).plugins.enabledPlugins['some-other-plugin@zcode-plugins-official'] === true)
ok('preserves other marketplace plugin after uninstall', readJson(marketFile).plugins.some((p) => p.name === 'user-other-plugin'))

console.log('\n[7] status on clean state')
const cleanStatus = hookConfig.getZcodeHookInstallStatus({ env })
ok('clean status reports not installed', !cleanStatus.installed)
ok('clean status reports not registered', !cleanStatus.registered)

fs.rmSync(dir, { recursive: true, force: true })

console.log(`\n结果：${pass} 通过，${fail} 失败\n`)
process.exit(fail ? 1 : 0)
