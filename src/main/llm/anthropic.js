'use strict'
// @ts-check
/**
 * Anthropic Messages API 适配。
 * 端点 POST {base}/v1/messages（base 默认 https://api.anthropic.com，可指向兼容网关）
 * 认证 x-api-key + anthropic-version: 2023-06-01
 * 请求：model / max_tokens(必填) / system(顶层) / messages / temperature
 * 响应：遍历 content[].type==text 的 text
 */
const { requestWithRetry, LLMError } = require('./base')
const { streamSSE } = require('./stream')

const ANTHROPIC_VERSION = '2023-06-01'

class AnthropicProvider {
  constructor(cfg, apiKey) {
    this.cfg = cfg
    this.apiKey = apiKey
    this.base = (cfg.baseUrl || 'https://api.anthropic.com').replace(/\/+$/, '')
    this.model = cfg.model
  }

  async summarize(system, user) {
    const url = `${this.base}/v1/messages`
    const headers = {
      'x-api-key': this.apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      'Content-Type': 'application/json',
    }
    const body = {
      model: this.model,
      max_tokens: this.cfg.maxTokens, // 必填
      system, // 顶层字段，切勿放进 messages
      messages: [{ role: 'user', content: user }],
      temperature: this.cfg.temperature,
    }
    const data = await requestWithRetry(url, headers, body, {
      timeout: this.cfg.timeoutSeconds,
      retries: this.cfg.retries,
    })
    const parts = []
    for (const b of data.content || []) {
      if (b.type === 'text') parts.push(b.text || '')
    }
    const t = parts.join('').trim()
    if (!t) throw new LLMError('Anthropic 响应未解析到文本')
    const usage = data.usage || {}
    return {
      text: t,
      inputTokens: usage.input_tokens || 0,
      outputTokens: usage.output_tokens || 0,
      model: data.model || this.model,
    }
  }

  /**
   * 流式多轮对话（Messages API，stream:true）。system 顶层、messages 为多轮数组。
   * thinking=true 时开启 extended thinking：API 要求 temperature=1、max_tokens>budget；
   * 思考增量经 thinking_delta 事件，由 onThinking 回调。
   * @param {string} system
   * @param {{role:string, content:string}[]} messages
   * @param {{signal?:AbortSignal, onDelta?:(t:string)=>void, onThinking?:(t:string)=>void, maxTokens?:number, thinking?:boolean, thinkingBudget?:number}} [opts]
   * @returns {Promise<{text:string, inputTokens:number, outputTokens:number, model:string}>}
   */
  async streamChat(system, messages, { signal, onDelta, onThinking, maxTokens, thinking, thinkingBudget } = {}) {
    const url = `${this.base}/v1/messages`
    const headers = {
      'x-api-key': this.apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      'Content-Type': 'application/json',
    }
    const budget = thinkingBudget || 1500
    const maxOut = maxTokens || this.cfg.maxTokens
    const body = {
      model: this.model,
      max_tokens: thinking ? Math.max(maxOut, budget + 1024) : maxOut,
      system,
      messages,
      // extended thinking 要求 temperature 必须为 1
      temperature: thinking ? 1 : this.cfg.temperature,
    }
    if (thinking) body.thinking = { type: 'enabled', budget_tokens: budget }
    let text = ''
    let inputTokens = 0
    let outputTokens = 0
    let model = this.model
    await streamSSE(url, headers, body, {
      timeout: this.cfg.timeoutSeconds,
      signal,
      onEvent: ({ event, data }) => {
        let d
        try {
          d = JSON.parse(data)
        } catch {
          return
        }
        const type = event || d.type || ''
        if (type === 'message_start') {
          const u = (d.message && d.message.usage) || {}
          inputTokens = u.input_tokens || inputTokens
          if (d.message && d.message.model) model = d.message.model
        } else if (type === 'content_block_delta') {
          const delta = d.delta || {}
          if (delta.type === 'text_delta' && delta.text) {
            text += delta.text
            if (onDelta) onDelta(delta.text)
          } else if (delta.type === 'thinking_delta' && delta.thinking) {
            if (onThinking) onThinking(delta.thinking)
          }
        } else if (type === 'message_delta') {
          const u = d.usage || {}
          if (u.output_tokens) outputTokens = u.output_tokens
        } else if (type === 'error') {
          const msg = (d.error && d.error.message) || 'Anthropic 流式错误'
          throw new LLMError(msg)
        }
      },
    })
    if (!text.trim()) throw new LLMError('Anthropic 流式未返回文本')
    return { text: text.trim(), inputTokens, outputTokens, model }
  }
}

module.exports = { AnthropicProvider, ANTHROPIC_VERSION }
