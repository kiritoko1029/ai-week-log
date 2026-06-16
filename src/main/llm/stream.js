'use strict'
// @ts-check
/**
 * SSE 流式底座：供 OpenAI / Anthropic 的 streamChat 复用。
 * 与 base.js 的 requestWithRetry 平行——但流式「不自动重试」：
 * 中途断流再重发会重复输出，故连接阶段非 2xx 直接抛错，由上层决定是否重发。
 */
const { errorForStatus, LLMServerError, LLMTimeout, LLMAborted } = require('./base')

/**
 * 解析 SSE 文本缓冲为事件帧。纯函数（无副作用），便于单测。
 * 帧以空行分隔；一帧内多行 data: 按 SSE 规范用 \n 连接；忽略注释(:)与心跳。
 * @param {string} buffer 累积的原始文本（可能以半帧结尾）
 * @returns {{ events: {event: string, data: string}[], rest: string }} rest 为尾部不完整帧，留待下次拼接
 */
function parseSSEFrames(buffer) {
  const events = []
  const normalized = buffer.replace(/\r\n/g, '\n')
  const blocks = normalized.split('\n\n')
  const rest = blocks.pop() // 末段可能是半帧，回退给调用方
  for (const block of blocks) {
    if (!block.trim()) continue
    let event = ''
    const dataLines = []
    for (const line of block.split('\n')) {
      if (!line || line.startsWith(':')) continue // 空行 / 注释 / 心跳
      if (line.startsWith('event:')) event = line.slice(6).trim()
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''))
    }
    if (dataLines.length === 0) continue
    events.push({ event, data: dataLines.join('\n') })
  }
  return { events, rest }
}

/**
 * 发起流式 POST 并逐事件回调。
 * @param {string} url
 * @param {object} headers
 * @param {object} body 会自动补 stream:true 由调用方负责
 * @param {object} opts
 * @param {number} [opts.timeout] 空闲超时秒（每收到数据重置）
 * @param {AbortSignal} [opts.signal] 外部取消信号
 * @param {(ev: {event: string, data: string}) => void} opts.onEvent 每帧回调
 */
async function streamSSE(url, headers, body, { timeout = 120, signal, onEvent } = {}) {
  const ctrl = new AbortController()
  const onAbort = () => ctrl.abort()
  if (signal) {
    if (signal.aborted) ctrl.abort()
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  let timer = null
  const resetIdle = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => ctrl.abort(), timeout * 1000)
  }
  const cleanup = () => {
    if (timer) clearTimeout(timer)
    if (signal) signal.removeEventListener('abort', onAbort)
  }
  const asAbortOrTimeout = () =>
    signal && signal.aborted ? new LLMAborted('已取消') : new LLMTimeout('请求超时')

  resetIdle()
  let resp
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...body, stream: true }),
      signal: ctrl.signal,
    })
  } catch (e) {
    cleanup()
    if (e.name === 'AbortError') throw asAbortOrTimeout()
    throw new LLMServerError(`网络错误：${e.message}`)
  }

  if (!resp.ok) {
    cleanup()
    const text = await resp.text().catch(() => '')
    throw errorForStatus(resp.status, text)
  }
  if (!resp.body || typeof resp.body.getReader !== 'function') {
    cleanup()
    throw new LLMServerError('流式响应不支持读取（无 ReadableStream）')
  }

  const reader = resp.body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''
  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      resetIdle()
      buffer += decoder.decode(value, { stream: true })
      const parsed = parseSSEFrames(buffer)
      buffer = parsed.rest
      for (const ev of parsed.events) onEvent(ev)
    }
  } catch (e) {
    if (e.name === 'AbortError') throw asAbortOrTimeout()
    throw e instanceof Error ? e : new LLMServerError(String(e))
  } finally {
    cleanup()
  }

  // flush 尾帧（某些服务端最后一帧不带空行结尾）
  const tail = parseSSEFrames(buffer + '\n\n')
  for (const ev of tail.events) onEvent(ev)
}

module.exports = { parseSSEFrames, streamSSE }
