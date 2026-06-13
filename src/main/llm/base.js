'use strict'
// @ts-check
/**
 * LLM 抽象层：异常体系 + 统一的指数退避重试。
 * 上层只依赖 summarize(system, user) -> { text, inputTokens, outputTokens, model }。
 * 两个后端（OpenAI Responses / Anthropic Messages）的差异封装在各自子类内。
 */

class LLMError extends Error {}
class LLMTimeout extends LLMError {}
class LLMRateLimited extends LLMError {} // 429，可重试
class LLMServerError extends LLMError {} // 5xx / 网络错误，可重试
class LLMAuthError extends LLMError {} // 401/403，不可重试
class LLMBadRequest extends LLMError {} // 400，不可重试

function snippet(text, n = 200) {
  const s = String(text || '')
  return s.length > n ? s.slice(0, n) + '…' : s
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * 带重试的 POST。429/5xx/超时/网络错误 → 指数退避重试；401/403/400 → 立即失败。
 * @returns {Promise<object>} 解析后的 JSON 响应
 */
async function requestWithRetry(url, headers, body, { timeout = 60, retries = 3 } = {}) {
  let lastErr
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeout * 1000)
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: ctrl.signal,
      })
      const text = await resp.text()
      clearTimeout(timer)
      let data
      try {
        data = JSON.parse(text)
      } catch {
        data = { _raw: text }
      }
      if (resp.ok) return data
      if (resp.status === 401 || resp.status === 403) {
        throw new LLMAuthError(`鉴权失败 ${resp.status}：${snippet(text)}`)
      }
      if (resp.status === 400) {
        throw new LLMBadRequest(`请求错误 400：${snippet(text)}`)
      }
      if (resp.status === 429) {
        lastErr = new LLMRateLimited(`429 限流：${snippet(text)}`)
      } else if (resp.status >= 500) {
        lastErr = new LLMServerError(`${resp.status} 服务端错误：${snippet(text)}`)
      } else {
        throw new LLMError(`未预期状态码 ${resp.status}：${snippet(text)}`)
      }
    } catch (e) {
      clearTimeout(timer)
      if (e instanceof LLMAuthError || e instanceof LLMBadRequest) throw e
      if (e.name === 'AbortError') lastErr = new LLMTimeout('请求超时')
      else if (e instanceof LLMError) lastErr = e
      else lastErr = new LLMServerError(`网络错误：${e.message}`)
    }
    if (attempt < retries) {
      const backoff = Math.min(2 ** attempt, 30) * 1000 + Math.random() * 800
      await sleep(backoff)
    }
  }
  throw lastErr || new LLMError('请求失败')
}

module.exports = {
  LLMError,
  LLMTimeout,
  LLMRateLimited,
  LLMServerError,
  LLMAuthError,
  LLMBadRequest,
  snippet,
  sleep,
  requestWithRetry,
}
