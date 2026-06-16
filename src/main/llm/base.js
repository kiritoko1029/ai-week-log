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
class LLMAborted extends LLMError {} // 用户主动取消（AbortController），上层应静默处理

function snippet(text, n = 200) {
  const s = String(text || '')
  return s.length > n ? s.slice(0, n) + '…' : s
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * 把 HTTP 状态码映射为统一异常实例（OpenAI / Anthropic / 流式共用）。
 * 429 / 5xx 可重试，其余不可重试。
 */
function errorForStatus(status, text) {
  const msg = snippet(text)
  if (status === 401 || status === 403) return new LLMAuthError(`鉴权失败 ${status}：${msg}`)
  if (status === 400) return new LLMBadRequest(`请求错误 400：${msg}`)
  if (status === 429) return new LLMRateLimited(`429 限流：${msg}`)
  if (status >= 500) return new LLMServerError(`${status} 服务端错误：${msg}`)
  return new LLMError(`未预期状态码 ${status}：${msg}`)
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
      const err = errorForStatus(resp.status, text)
      // 429 / 5xx 可重试，记录后进入退避；其余（401/403/400/未预期）立即失败
      if (err instanceof LLMRateLimited || err instanceof LLMServerError) {
        lastErr = err
      } else {
        throw err
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
  LLMAborted,
  snippet,
  sleep,
  errorForStatus,
  requestWithRetry,
}
