'use strict'
// @ts-check
/**
 * OpenAI Responses API 适配。
 * 端点 POST {base}/responses（base 默认 https://api.openai.com/v1，可指向兼容网关）
 * 认证 Authorization: Bearer <key>
 * 请求：model / instructions(系统) / input(用户) / max_output_tokens / temperature
 * 响应：优先聚合 output_text，否则遍历 output[].message.content[].output_text
 */
const { requestWithRetry, LLMError } = require('./base')

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
