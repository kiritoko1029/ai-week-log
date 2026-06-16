'use strict'
// @ts-check
/**
 * OpenAI Responses API 适配。
 * 端点 POST {base}/responses（base 默认 https://api.openai.com/v1，可指向兼容网关）
 * 认证 Authorization: Bearer <key>
 * 请求：model / instructions(系统) / input(用户) / max_output_tokens / temperature
 * 响应：优先聚合 output_text，否则遍历 output[].message.content[].output_text
 */
const { requestWithRetry, LLMError, LLMBadRequest } = require('./base')
const { streamSSE } = require('./stream')

class OpenAIProvider {
  /**
   * @param {object} cfg - { baseUrl, model, temperature, maxTokens, timeoutSeconds, retries }
   * @param {string} apiKey
   */
  constructor(cfg, apiKey) {
    this.cfg = cfg
    this.apiKey = apiKey
    this.base = (cfg.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '')
    this.model = cfg.model
  }

  async summarize(system, user) {
    const url = `${this.base}/responses`
    const headers = {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
    }
    const body = {
      model: this.model,
      instructions: system,
      input: user,
      max_output_tokens: this.cfg.maxTokens,
      temperature: this.cfg.temperature,
    }
    const data = await requestWithRetry(url, headers, body, {
      timeout: this.cfg.timeoutSeconds,
      retries: this.cfg.retries,
    })
    const text = parseOpenAI(data)
    const usage = data.usage || {}
    return {
      text,
      inputTokens: usage.input_tokens || 0,
      outputTokens: usage.output_tokens || 0,
      model: data.model || this.model,
    }
  }

  /**
   * 流式多轮对话（Responses API，stream:true）。input 接受 [{role,content}] 数组。
   * thinking=true 时请求推理摘要（reasoning.summary），仅 gpt-5/o 系列模型支持；
   * 非推理模型会返回 400，自动降级为普通流式重试一次。
   * @param {string} system
   * @param {{role:string, content:string}[]} messages
   * @param {{signal?:AbortSignal, onDelta?:(t:string)=>void, onThinking?:(t:string)=>void, maxTokens?:number, thinking?:boolean}} [opts]
   * @returns {Promise<{text:string, inputTokens:number, outputTokens:number, model:string}>}
   */
  async streamChat(system, messages, { signal, onDelta, onThinking, maxTokens, thinking } = {}) {
    const url = `${this.base}/responses`
    const headers = {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
    }
    const baseBody = {
      model: this.model,
      instructions: system,
      input: messages,
      max_output_tokens: maxTokens || this.cfg.maxTokens,
      temperature: this.cfg.temperature,
    }
    const run = async (withReasoning) => {
      const body = { ...baseBody }
      if (withReasoning) body.reasoning = { summary: 'auto' }
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
          if (type === 'response.output_text.delta') {
            const piece = typeof d.delta === 'string' ? d.delta : ''
            if (piece) {
              text += piece
              if (onDelta) onDelta(piece)
            }
          } else if (type === 'response.reasoning_summary_text.delta') {
            const piece = typeof d.delta === 'string' ? d.delta : ''
            if (piece && onThinking) onThinking(piece)
          } else if (type === 'response.completed' || type === 'response.incomplete') {
            const u = (d.response && d.response.usage) || {}
            inputTokens = u.input_tokens || inputTokens
            outputTokens = u.output_tokens || outputTokens
            if (d.response && d.response.model) model = d.response.model
          } else if (type === 'response.failed' || type === 'error') {
            const msg =
              (d.response && d.response.error && d.response.error.message) ||
              d.message ||
              'OpenAI 流式错误'
            throw new LLMError(msg)
          }
        },
      })
      if (!text.trim()) throw new LLMError('OpenAI 流式未返回文本')
      return { text: text.trim(), inputTokens, outputTokens, model }
    }
    if (thinking) {
      try {
        return await run(true)
      } catch (e) {
        // 非推理模型（如 gpt-4o）不支持 reasoning 参数 → 降级为普通流式
        if (e instanceof LLMBadRequest) return run(false)
        throw e
      }
    }
    return run(false)
  }
}

function parseOpenAI(data) {
  const agg = data.output_text
  if (typeof agg === 'string' && agg.trim()) return agg.trim()
  const parts = []
  for (const item of data.output || []) {
    if (item.type !== 'message') continue // 跳过 reasoning 等非消息块
    for (const b of item.content || []) {
      if (b.type === 'output_text') parts.push(b.text || '')
    }
  }
  const t = parts.join('').trim()
  if (!t) throw new LLMError('OpenAI 响应未解析到文本')
  return t
}

module.exports = { OpenAIProvider, parseOpenAI }
