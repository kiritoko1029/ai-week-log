'use strict'
/* AI 对话问答测试：SSE 分帧 / provider 流式（mock fetch）/ 会话存储 / RAG 兜底检索。不依赖 electron。 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { parseSSEFrames } = require('../src/main/llm/stream')
const { createProvider } = require('../src/main/llm')
const chat = require('../src/main/chat')

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

// 用真实样例帧（取自 Anthropic / OpenAI 官方流式文档）
const ANTHROPIC_SSE = `event: message_start
data: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"claude-opus-4","usage":{"input_tokens":11,"output_tokens":1}}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

event: ping
data: {"type": "ping"}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" there!"}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":6}}

event: message_stop
data: {"type":"message_stop"}

`

const OPENAI_SSE = `event: response.created
data: {"type":"response.created","response":{"id":"resp_1","model":"gpt-4o"}}

event: response.output_text.delta
data: {"type":"response.output_text.delta","delta":"Hello"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","delta":", world"}

event: response.completed
data: {"type":"response.completed","response":{"model":"gpt-4o","usage":{"input_tokens":12,"output_tokens":3}}}

`

const ANTHROPIC_THINKING_SSE = `event: message_start
data: {"type":"message_start","message":{"id":"msg_1","model":"claude-opus-4","usage":{"input_tokens":20,"output_tokens":1}}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"让我想想"}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"……"}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"abc"}}

event: content_block_delta
data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"答案"}}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":10}}

event: message_stop
data: {"type":"message_stop"}

`

const OPENAI_REASONING_SSE = `event: response.created
data: {"type":"response.created","response":{"id":"r1","model":"o3"}}

event: response.reasoning_summary_text.delta
data: {"type":"response.reasoning_summary_text.delta","delta":"先分析"}

event: response.reasoning_summary_text.delta
data: {"type":"response.reasoning_summary_text.delta","delta":"问题"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","delta":"结论"}

event: response.completed
data: {"type":"response.completed","response":{"model":"o3","usage":{"input_tokens":15,"output_tokens":8}}}

`

function sseResponse(text) {
  const enc = new TextEncoder()
  const stream = new ReadableStream({
    start(c) {
      c.enqueue(enc.encode(text))
      c.close()
    },
  })
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

async function main() {
  console.log('\n[1] SSE 分帧 parseSSEFrames')
  {
    const { events, rest } = parseSSEFrames(ANTHROPIC_SSE)
    ok('解析出全部 8 帧', events.length === 8, 'got ' + events.length)
    ok('event 名解析正确', events[0].event === 'message_start')
    ok('保留 ping 心跳帧', events.some((e) => e.event === 'ping'))
    ok('末尾无残留 rest', rest === '', JSON.stringify(rest))
  }
  {
    const partial = 'event: a\ndata: {"x":1}\n\nevent: b\ndata: {"y"'
    const { events, rest } = parseSSEFrames(partial)
    ok('半帧：仅 1 帧完整', events.length === 1 && events[0].event === 'a')
    ok('半帧：rest 保留未完成部分', rest.includes('event: b'))
    const next = parseSSEFrames(rest + ':2}\n\n')
    ok('续传拼接出第二帧', next.events.length === 1 && JSON.parse(next.events[0].data).y === 2)
  }

  console.log('\n[2] provider 流式 streamChat（mock fetch）')
  if (typeof fetch === 'undefined' || typeof ReadableStream === 'undefined') {
    ok('跳过：当前 Node 无全局 fetch/ReadableStream', true)
  } else {
    const origFetch = global.fetch
    const mkCfg = (provider) => ({
      ai: {
        provider,
        retries: 0,
        timeoutSeconds: 30,
        anthropic: { model: 'claude-x', baseUrl: '', temperature: 0.3, maxTokens: 800 },
        openai: { model: 'gpt-4o', baseUrl: '', temperature: 0.3, maxTokens: 800 },
      },
    })
    try {
      global.fetch = async () => sseResponse(ANTHROPIC_SSE)
      {
        const p = createProvider(mkCfg('anthropic'), 'sk-test')
        let acc = ''
        const res = await p.streamChat('sys', [{ role: 'user', content: 'hi' }], {
          onDelta: (t) => (acc += t),
        })
        ok('anthropic 文本累积', res.text === 'Hello there!', JSON.stringify(res.text))
        ok('anthropic onDelta 与返回一致', acc === 'Hello there!')
        ok('anthropic input tokens=11', res.inputTokens === 11, '' + res.inputTokens)
        ok('anthropic output tokens=6', res.outputTokens === 6, '' + res.outputTokens)
      }
      global.fetch = async () => sseResponse(OPENAI_SSE)
      {
        const p = createProvider(mkCfg('openai'), 'sk-test')
        let acc = ''
        const res = await p.streamChat('sys', [{ role: 'user', content: 'hi' }], {
          onDelta: (t) => (acc += t),
        })
        ok('openai 文本累积', res.text === 'Hello, world', JSON.stringify(res.text))
        ok('openai onDelta 与返回一致', acc === 'Hello, world')
        ok('openai input tokens=12', res.inputTokens === 12, '' + res.inputTokens)
        ok('openai output tokens=3', res.outputTokens === 3, '' + res.outputTokens)
      }

      // thinking：Anthropic extended thinking（thinking_delta，忽略 signature_delta）
      global.fetch = async () => sseResponse(ANTHROPIC_THINKING_SSE)
      {
        const p = createProvider(mkCfg('anthropic'), 'sk-test')
        let body = ''
        let think = ''
        const res = await p.streamChat('sys', [{ role: 'user', content: 'hi' }], {
          thinking: true,
          onDelta: (t) => (body += t),
          onThinking: (t) => (think += t),
        })
        ok('anthropic thinking 正文', res.text === '答案', JSON.stringify(res.text))
        ok('anthropic thinking 累积', think === '让我想想……', JSON.stringify(think))
        ok('anthropic thinking 忽略 signature', !think.includes('abc'))
      }

      // thinking：OpenAI reasoning summary
      global.fetch = async () => sseResponse(OPENAI_REASONING_SSE)
      {
        const p = createProvider(mkCfg('openai'), 'sk-test')
        let think = ''
        const res = await p.streamChat('sys', [{ role: 'user', content: 'hi' }], {
          thinking: true,
          onThinking: (t) => (think += t),
        })
        ok('openai reasoning 正文', res.text === '结论', JSON.stringify(res.text))
        ok('openai reasoning 累积', think === '先分析问题', JSON.stringify(think))
      }

      // thinking 降级：模型不支持 reasoning（400）→ 去掉 reasoning 重试一次
      {
        let calls = 0
        global.fetch = async (_url, opts) => {
          calls++
          const sent = JSON.parse(opts.body)
          if (sent.reasoning) return new Response('{"error":{"message":"unsupported"}}', { status: 400 })
          return sseResponse(OPENAI_SSE)
        }
        const p = createProvider(mkCfg('openai'), 'sk-test')
        const res = await p.streamChat('sys', [{ role: 'user', content: 'hi' }], { thinking: true })
        ok('openai 不支持 reasoning 时降级成功', res.text === 'Hello, world')
        ok('openai 降级共两次请求', calls === 2, 'calls=' + calls)
      }
    } finally {
      global.fetch = origFetch
    }
  }

  console.log('\n[3] 会话存储 CRUD')
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weeklog-chat-'))
    try {
      const s = chat.createSession(dir)
      ok('createSession 返回 id', !!s.id && s.title === '新对话')
      const um = chat.appendMessage(dir, s.id, { role: 'user', content: '上周做了什么登录相关的事' })
      ok('appendMessage 返回 id', !!um.id)
      const got = chat.getSession(dir, s.id)
      ok('getSession 含消息', got.messages.length === 1 && got.messages[0].content.includes('登录'))
      ok('首条 user 自动作标题', got.title.startsWith('上周做了什么'))
      chat.appendMessage(dir, s.id, {
        role: 'assistant',
        content: '回答',
        usage: { inputTokens: 1, outputTokens: 2, model: 'm' },
      })
      const list = chat.listSessions(dir)
      ok('listSessions 计数=2', list.length === 1 && list[0].messageCount === 2)
      const rn = chat.renameSession(dir, s.id, '登录相关')
      ok('renameSession 生效', rn.ok && chat.getSession(dir, s.id).title === '登录相关')
      const del = chat.deleteSession(dir, s.id)
      ok('deleteSession 生效', del.ok && chat.listSessions(dir).length === 0)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }

  console.log('\n[4] RAG 兜底检索 retrieveContext')
  {
    const cfg = { memory: { enabled: true, topK: 5 }, notes: { miscProject: '日常工作' } }
    const history = [
      { type: 'weekly', rangeStart: '2026-06-01', rangeEnd: '2026-06-07', text: '本周完成了登录模块重构，修复了 token 刷新问题' },
      { type: 'weekly', rangeStart: '2026-05-25', rangeEnd: '2026-05-31', text: '搭建了报表导出功能' },
    ]
    const r1 = await chat.retrieveContext({
      query: '登录相关做了什么',
      cfg,
      history,
      searchMemory: async () => [],
    })
    ok('记忆为空时回退报告', r1.refs.some((x) => x.kind === 'report'))
    ok('兜底命中关键词报告', r1.contextText.includes('登录模块重构'), r1.contextText.slice(0, 40))

    const r2 = await chat.retrieveContext({
      query: '登录',
      cfg,
      history,
      searchMemory: async () => [
        { full: '记忆A：登录重构', project: 'P', date: '2026-06-01' },
        { full: '记忆B：token 刷新', project: 'P', date: '2026-06-02' },
      ],
    })
    ok('记忆充足时全为 memory', r2.refs.length >= 2 && r2.refs.every((x) => x.kind === 'memory'))
    ok('记忆充足时不走报告兜底', !r2.refs.some((x) => x.kind === 'report'))

    ok('buildChatSystem 注入上下文', chat.buildChatSystem('XYZ').includes('XYZ'))
    ok('keyTerms 提取中文 2-gram', chat.keyTerms('登录模块').includes('登录'))
  }

  console.log('\n[5] 报告生成意图')
  {
    ok('预筛正样本：帮我生成本周周报', chat.looksLikeReportRequest('帮我生成本周周报'))
    ok('预筛正样本：写今天日报', chat.looksLikeReportRequest('写今天日报'))
    ok('预筛负样本：今天天气如何', !chat.looksLikeReportRequest('今天天气如何'))
    ok('预筛负样本：纯问句无动词', !chat.looksLikeReportRequest('登录模块怎么实现的'))
    ok('when today', JSON.stringify(chat.whenToRangeOpts('daily', 'today')) === JSON.stringify({ mode: 'daily', date: 'today' }))
    ok('when yesterday', JSON.stringify(chat.whenToRangeOpts('daily', 'yesterday')) === JSON.stringify({ mode: 'daily', date: 'yesterday' }))
    ok('when this_week', JSON.stringify(chat.whenToRangeOpts('weekly', 'this_week')) === '{}')
    ok('when last_week', JSON.stringify(chat.whenToRangeOpts('weekly', 'last_week')) === JSON.stringify({ week: 'last' }))
  }
  if (typeof fetch !== 'undefined' && typeof Response !== 'undefined') {
    const origFetch = global.fetch
    const cfg = {
      weekStart: 'monday',
      ai: {
        provider: 'anthropic',
        retries: 0,
        timeoutSeconds: 30,
        anthropic: { model: 'm', baseUrl: '', temperature: 0.3, maxTokens: 800 },
        openai: { model: 'm', baseUrl: '', temperature: 0.3, maxTokens: 800 },
      },
    }
    // mock summarize：返回 Anthropic Messages 风格响应，content 文本为给定字符串
    const mockReply = (text) => async () =>
      new Response(JSON.stringify({ content: [{ type: 'text', text }], usage: { input_tokens: 1, output_tokens: 1 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    try {
      global.fetch = mockReply('{"action":"generate","reportType":"weekly","rangeOpts":{}}')
      const i1 = await chat.detectReportIntent({ cfg, apiKey: 'k', text: '帮我写本周周报', now: new Date(2026, 5, 16) })
      ok('解析 generate/weekly', i1.action === 'generate' && i1.reportType === 'weekly' && JSON.stringify(i1.rangeOpts) === '{}', JSON.stringify(i1))

      global.fetch = mockReply('{"action":"chat","reportType":null,"rangeOpts":null}')
      const i2 = await chat.detectReportIntent({ cfg, apiKey: 'k', text: '上周周报里我说了啥', now: new Date(2026, 5, 16) })
      ok('解析 chat（引用已有报告）', i2.action === 'chat')

      global.fetch = mockReply('这不是 JSON')
      const i3 = await chat.detectReportIntent({ cfg, apiKey: 'k', text: '生成日报', now: new Date(2026, 5, 16) })
      ok('脏输出降级 chat', i3.action === 'chat')
    } finally {
      global.fetch = origFetch
    }
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
