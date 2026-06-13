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
}

module.exports = { AnthropicProvider, ANTHROPIC_VERSION }
