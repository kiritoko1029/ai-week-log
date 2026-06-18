'use strict'
/* Codex hooks.json install/uninstall behavior, isolated from the real ~/.codex. */
const fs = require('fs')
const os = require('os')
const path = require('path')

const hookConfig = require('../src/main/codex-hook-config')

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

function countManaged(config) {
  return (((config.hooks || {}).Stop || [])
    .flatMap((group) => Array.isArray(group.hooks) ? group.hooks : [])
    .filter((hook) => hookConfig.isManagedWeekLogHook(hook))).length
}

function managedHooks(config) {
  return (((config.hooks || {}).Stop || [])
    .flatMap((group) => Array.isArray(group.hooks) ? group.hooks : [])
    .filter((hook) => hookConfig.isManagedWeekLogHook(hook)))
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wl_codex_hook_config_'))
const hooksPath = path.join(dir, 'hooks.json')

console.log('\n[1] path and hook generation')
ok('default hooks path uses CODEX_HOME when provided', hookConfig.defaultHooksPath({ CODEX_HOME: path.join(dir, 'codex-home') }) === path.join(dir, 'codex-home', 'hooks.json'))
const hook = hookConfig.buildCodexPendingNoteHook({
  endpoint: 'http://127.0.0.1:17321/api/codex/pending-notes',
  token: 'token-a',
})
ok('generated hook has stable WeekLog marker', hookConfig.isManagedWeekLogHook(hook))
ok('generated hook does not add custom schema fields', !Object.prototype.hasOwnProperty.call(hook, 'weeklogHookId'))
ok('generated config snippet uses Stop hook', hookConfig.buildCodexHookSnippet({ endpoint: 'http://127.0.0.1:17321/api/codex/pending-notes', token: 'token-a' }).includes('"Stop"'))

console.log('\n[1b] summary extraction')
ok(
  'summary prefers Codex final response fields',
  hookConfig.deriveCodexSummary({
    changedFiles: ['src/main/ipc.js'],
    final_response: '实现了 Codex Hook 小记待处理池，并补充一键安装。'
  }) === '实现了 Codex Hook 小记待处理池，并补充一键安装。'
)
const transcriptPath = path.join(dir, 'transcript.jsonl')
fs.writeFileSync(transcriptPath, [
  JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '帮我修 hook 摘要' }] } }),
  JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '修复了 Stop hook 摘要提取逻辑，候选小记现在会记录任务要点。' }] } }),
].join('\n'), 'utf8')
ok(
  'summary can be read from transcript path',
  hookConfig.deriveCodexSummary({ transcript_path: transcriptPath }) === '修复了 Stop hook 摘要提取逻辑，候选小记现在会记录任务要点。'
)
ok(
  'missing summary returns empty instead of placeholder or changed files',
  hookConfig.deriveCodexSummary({ changedFiles: ['only/file.ts'] }) === ''
)
ok('generated hook skips POST when summary is empty', hookConfig.buildHookScript({ endpoint: 'http://127.0.0.1:17321/api/codex/pending-notes', token: 'token-a' }).includes('if (!summary) process.exit(0)'))
const memoryCitationText = [
  '优化了 Codex Hook 待处理小记池展示，让摘要更醒目。',
  '',
  '<oai-mem-citation>',
  '<citation_entries>',
  'MEMORY.md:123-132|note=[checked ai-week-log repo memory context before UI work]',
  '</citation_entries>',
  '<rollout_ids>',
  '019ed4b6-e8a8-74e3-833a-5957df342b13',
  '</rollout_ids>',
  '</oai-mem-citation>',
].join('\n')
ok(
  'summary strips Codex memory citation metadata',
  hookConfig.deriveCodexSummary({ final_response: memoryCitationText }) === '优化了 Codex Hook 待处理小记池展示，让摘要更醒目。'
)

console.log('\n[2] install preserves user hooks')
fs.writeFileSync(hooksPath, JSON.stringify({
  hooks: {
    Stop: [
      { hooks: [{ type: 'command', command: 'echo keep-stop', timeout: 1 }] },
    ],
    UserPromptSubmit: [
      { hooks: [{ type: 'command', command: 'echo keep-prompt', timeout: 1 }] },
    ],
  },
}, null, 2), 'utf8')
const installA = hookConfig.installCodexHook({
  hooksPath,
  hook,
  now: () => new Date('2026-06-17T08:00:00.000Z'),
})
const afterInstall = readJson(hooksPath)
ok('install succeeds', installA.ok && installA.installed)
ok('install creates backup for existing hooks file', !!installA.backupPath && fs.existsSync(installA.backupPath))
ok('existing Stop hook remains', JSON.stringify(afterInstall).includes('echo keep-stop'))
ok('existing UserPromptSubmit hook remains', JSON.stringify(afterInstall).includes('echo keep-prompt'))
ok('managed hook is installed once', countManaged(afterInstall) === 1)

console.log('\n[3] install is idempotent and refreshes command')
const hookB = hookConfig.buildCodexPendingNoteHook({
  endpoint: 'http://127.0.0.1:17322/api/codex/pending-notes',
  token: 'token-b',
})
const installB = hookConfig.installCodexHook({
  hooksPath,
  hook: hookB,
  now: () => new Date('2026-06-17T08:01:00.000Z'),
})
const afterReinstall = readJson(hooksPath)
ok('reinstall replaces previous managed hook', installB.ok && installB.replaced === 1)
ok('managed hook is still installed once after reinstall', countManaged(afterReinstall) === 1)
ok('installed command is refreshed', managedHooks(afterReinstall)[0]?.command === hookB.command)

console.log('\n[4] uninstall removes only WeekLog hook')
const mixedPath = path.join(dir, 'mixed-hooks.json')
fs.writeFileSync(mixedPath, JSON.stringify({
  hooks: {
    Stop: [
      {
        hooks: [
          { type: 'command', command: 'echo keep-in-same-group', timeout: 1 },
          hookB,
        ],
      },
    ],
  },
}, null, 2), 'utf8')
const uninstallMixed = hookConfig.uninstallCodexHook({
  hooksPath: mixedPath,
  now: () => new Date('2026-06-17T08:02:00.000Z'),
})
const afterMixedUninstall = readJson(mixedPath)
ok('uninstall reports one removed hook', uninstallMixed.ok && uninstallMixed.removed === 1)
ok('uninstall leaves non-WeekLog hook in same group', JSON.stringify(afterMixedUninstall).includes('echo keep-in-same-group'))
ok('uninstall removes managed hook', countManaged(afterMixedUninstall) === 0)

console.log('\n[5] status and invalid files')
const status = hookConfig.getCodexHookInstallStatus({ hooksPath })
ok('status detects installed hook', status.installed && status.hookCount === 1)
const invalidPath = path.join(dir, 'invalid-hooks.json')
fs.writeFileSync(invalidPath, '{bad json', 'utf8')
const invalidStatus = hookConfig.getCodexHookInstallStatus({ hooksPath: invalidPath })
ok('status returns parse error instead of throwing', !invalidStatus.installed && !!invalidStatus.error)
const invalidInstall = hookConfig.installCodexHook({ hooksPath: invalidPath, hook })
ok('install refuses to overwrite invalid hooks file', !invalidInstall.ok && !!invalidInstall.error && fs.readFileSync(invalidPath, 'utf8') === '{bad json')

fs.rmSync(dir, { recursive: true, force: true })

console.log(`\n结果：${pass} 通过，${fail} 失败\n`)
process.exit(fail ? 1 : 0)
