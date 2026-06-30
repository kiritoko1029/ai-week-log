'use strict'
/*
 * weeklog-ai-note skill 的 record-note.mjs transcript 抽取测试。
 * 校验：只保留 user + assistant 正文，剔除 thinking/reasoning/tool_use/tool_result、
 * meta/sidechain 行，以及内联包裹标签（<thinking> / <system-reminder> 等）。
 * 运行：node tests/_skill_record_note_test.js
 */
const path = require('path')
const { pathToFileURL } = require('url')

const root = path.resolve(__dirname, '..')
const MODULE_URL = pathToFileURL(
  path.join(root, 'src-tauri/resources/skill/record-note.mjs'),
).href

let pass = 0
let fail = 0

function ok(name, cond, extra) {
  if (cond) {
    pass++
    console.log('  PASS ' + name)
  } else {
    fail++
    console.log('  FAIL ' + name + (extra ? ' -> ' + extra : ''))
  }
}

function jsonl(lines) {
  return lines.map((o) => JSON.stringify(o)).join('\n') + '\n'
}

async function main() {
  const m = await import(MODULE_URL)

  console.log('\n[stripWrappers]')
  ok(
    'removes <thinking> block',
    m.stripWrappers('<thinking>内部推理</thinking>真正回复') === '真正回复',
  )
  ok(
    'removes <system-reminder> block',
    m.stripWrappers('<system-reminder>注入</system-reminder>正文内容') === '正文内容',
  )
  ok(
    'removes claude command wrappers',
    m.stripWrappers('<command-name>/foo</command-name>实际提问') === '实际提问',
  )

  console.log('\n[textFromContent allowlist]')
  ok(
    'keeps text / input_text / output_text',
    m.textFromContent([
      { type: 'text', text: 'A' },
      { type: 'input_text', text: 'B' },
      { type: 'output_text', text: 'C' },
    ]) === 'A\nB\nC',
  )
  ok(
    'drops thinking / reasoning_text / summary_text',
    m.textFromContent([
      { type: 'thinking', thinking: '思考' },
      { type: 'reasoning_text', text: '推理' },
      { type: 'summary_text', text: '摘要' },
      { type: 'text', text: '正文' },
    ]) === '正文',
  )
  ok(
    'drops tool_use / tool_result / image blocks',
    m.textFromContent([
      { type: 'tool_use', name: 'Edit', input: {} },
      { type: 'tool_result', content: 'done' },
      { type: 'image', source: {} },
      { type: 'text', text: '只剩这句' },
    ]) === '只剩这句',
  )
  ok('plain string content passes through', m.textFromContent('  你好  ') === '你好')

  console.log('\n[extractMessages - codex rollout]')
  const codex = jsonl([
    { type: 'session_meta', payload: { cwd: '/Users/me/proj' } },
    {
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '帮我修复登录态丢失的问题' }] },
    },
    { type: 'response_item', payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: '用户想修复登录' }] } },
    { type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: '{"cmd":"ls"}' } },
    {
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '已定位并修复 token 过期逻辑' }] },
    },
  ])
  const codexMsgs = m.extractMessages(codex)
  ok('codex keeps exactly 2 messages', codexMsgs.length === 2, JSON.stringify(codexMsgs))
  ok('codex msg0 is user question', codexMsgs[0] && codexMsgs[0].role === 'user' && codexMsgs[0].text === '帮我修复登录态丢失的问题')
  ok('codex msg1 is assistant reply', codexMsgs[1] && codexMsgs[1].role === 'assistant' && codexMsgs[1].text === '已定位并修复 token 过期逻辑')
  ok('codex drops reasoning summary', !JSON.stringify(codexMsgs).includes('用户想修复登录'))
  ok('codex drops function_call', !JSON.stringify(codexMsgs).includes('shell') && !JSON.stringify(codexMsgs).includes('cmd'))

  console.log('\n[extractMessages - claude transcript]')
  const claude = jsonl([
    { type: 'summary', cwd: '/Users/me/proj', summary: '一次会话' },
    { type: 'user', message: { role: 'user', content: '再帮我加单元测试' } },
    {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '内部思考不应保留' },
          { type: 'text', text: '好的，我来加测试' },
          { type: 'tool_use', name: 'Edit', input: { file: 'a.js' } },
        ],
      },
    },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'file edited' }] } },
    { isMeta: true, type: 'user', message: { role: 'user', content: 'meta 噪声' } },
    {
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: '<thinking>隐藏推理</thinking>测试已添加并通过' }] },
    },
  ])
  const claudeMsgs = m.extractMessages(claude)
  ok('claude keeps 3 messages', claudeMsgs.length === 3, JSON.stringify(claudeMsgs))
  ok('claude keeps user string content', claudeMsgs[0] && claudeMsgs[0].text === '再帮我加单元测试')
  ok('claude drops thinking block', !JSON.stringify(claudeMsgs).includes('内部思考不应保留'))
  ok('claude drops tool_use + tool_result', !JSON.stringify(claudeMsgs).includes('tool_use') && !JSON.stringify(claudeMsgs).includes('file edited'))
  ok('claude drops isMeta line', !JSON.stringify(claudeMsgs).includes('meta 噪声'))
  ok('claude strips inline wrapper', !JSON.stringify(claudeMsgs).includes('隐藏推理') && claudeMsgs[2] && claudeMsgs[2].text === '测试已添加并通过')

  console.log('\n[capMessages]')
  const capped = m.capMessages([{ role: 'user', text: 'x'.repeat(100) }], 1000, 10)
  ok('caps overlong single message', capped[0].text.length === 10 && capped[0].text.endsWith('…'))
  const many = m.capMessages(
    [
      { role: 'user', text: 'a'.repeat(40) },
      { role: 'assistant', text: 'b'.repeat(40) },
      { role: 'user', text: 'c'.repeat(40) },
    ],
    50,
  )
  ok('drops oldest when over total budget', many.length < 3 && many[many.length - 1].text.startsWith('c'))

  console.log('\n[claudeSlug]')
  ok('slug replaces non-alnum with dash', m.claudeSlug('/Users/me/proj') === '-Users-me-proj')

  console.log(`\nResult: ${pass} passed, ${fail} failed\n`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
