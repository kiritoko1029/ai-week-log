'use strict'
// @ts-check
/**
 * LLM 工厂 + Prompt 工程。
 * 上层通过 createProvider(cfg, apiKey) 得到与厂商无关的 provider，
 * 通过 SYSTEM_PROMPT + buildUserPrompt(bucket) 组装融合 commit 与笔记的输入。
 */
const { OpenAIProvider } = require('./openai')
const { AnthropicProvider } = require('./anthropic')
const { LLMError } = require('./base')
const { formatDateNoZero, estimateTokens } = require('../utils')

const SYSTEM_PROMPT_BASE = `你是一名资深研发周报/日报助手，擅长把零散的 Git 提交记录与人工笔记提炼为客观、专业的工作小结。

写作要求：
1. 使用简体中文，书面、客观陈述，聚焦"做了什么、解决了什么、带来什么价值"。
2. 仅总结指定项目在指定日期当天的工作，控制在 3 到 5 句话，凝练成一段连续文字，不要分点、不要换行。
3. 输入包含两类信息源：【代码提交】与【人工笔记】，二者均为真实工作，请统一归纳，不得因来源不同而割裂或忽略笔记中的非代码工作（如会议、沟通、设计、调研）。
4. 进行归纳与抽象，不要逐条复述 commit 原文，不要罗列提交哈希、分支名、文件路径清单。
5. 只依据提供的信息进行总结，不得杜撰未提及的功能、数据或结论。
6. 直接输出这段总结文字本身，不要输出项目名、不要输出"【】"前缀、不要加日期、不要加任何标题或解释。
7. 语气陈述过去完成的工作（如"完成了""优化了""修复了""参加了""确认了"），避免营销化、夸张或空话套话。`

// 兼容旧引用：无偏好时的纯系统提示词
const SYSTEM_PROMPT = SYSTEM_PROMPT_BASE

/**
 * 构造报告生成系统提示词；若有写作偏好则追加【用户写作偏好】段（严格遵守）。
 * @param {string[]} prefs 启用的写作偏好规则文本数组
 */
function buildSystemPrompt(prefs) {
  const rules = (prefs || []).filter((r) => r && String(r).trim()).map((r) => '- ' + String(r).trim())
  if (!rules.length) return SYSTEM_PROMPT_BASE
  return SYSTEM_PROMPT_BASE + '\n\n8. 【用户写作偏好（请严格遵守）】用户明确要求的写作调整，请在本次总结中严格执行：\n' + rules.join('\n')
}

/** 从配置构造 provider 实例 */
function createProvider(cfg, apiKey) {
  const provider = cfg.ai.provider
  const sub = cfg.ai[provider]
  if (!sub) throw new LLMError(`未配置 provider：${provider}`)
  if (!apiKey) throw new LLMError(`未设置 ${provider} 的 API Key（请配置环境变量）`)
  const merged = {
    baseUrl: sub.baseUrl || '',
    model: sub.model,
    temperature: sub.temperature ?? 0.3,
    maxTokens: sub.maxTokens || 800,
    timeoutSeconds: cfg.ai.timeoutSeconds || 60,
    retries: cfg.ai.retries ?? 3,
  }
  if (provider === 'openai') return new OpenAIProvider(merged, apiKey)
  if (provider === 'anthropic') return new AnthropicProvider(merged, apiKey)
  throw new LLMError(`未知 provider：${provider}`)
}

/** 把 commit 列表渲染为 prompt 中的【代码提交】段 */
function buildCommitsBlock(commits) {
  const lines = []
  commits.forEach((c, i) => {
    const subj = (c.subject || '').trim()
    const body = (c.body || '').trim().replace(/\n+/g, ' ')
    let line = `${i + 1}. ${subj}`
    if (body) line += `（说明：${body}）`
    const files = (c.files || []).slice(0, 8).map((f) => f.path)
    if (files.length) {
      const more = c.files.length > 8 ? ` 等${c.files.length}个文件` : ''
      line += `\n   改动文件：${files.join('、')}${more}；变更量：+${c.insertions || 0}/-${c.deletions || 0}`
    }
    lines.push(line)
  })
  return lines.join('\n')
}

/**
 * 组装 user prompt：注入【代码提交】与【人工笔记】（项目级 + 当日通用）。
 * @param {object} bucket - { project, day(Date), commits, notes(项目级), sharedNotes(当日通用), isNotesOnly }
 */
function buildUserPrompt(bucket) {
  const dateStr = formatDateNoZero(bucket.day)
  const parts = [`请总结以下项目在指定日期的开发工作。`, '', `项目名称：${bucket.displayName || bucket.project}`, `日期：${dateStr}`, '']

  parts.push('【代码提交】')
  if (bucket.commits && bucket.commits.length) {
    parts.push(buildCommitsBlock(bucket.commits))
  } else {
    parts.push('（本日该项目无代码提交记录）')
  }

  parts.push('', '【人工笔记】')
  const projNotes = bucket.notes || []
  const sharedNotes = bucket.sharedNotes || []
  if (projNotes.length) {
    parts.push('项目相关笔记：')
    projNotes.forEach((n, i) => parts.push(`${i + 1}. ${n.content}`))
  }
  if (sharedNotes.length) {
    parts.push('当日通用补充（非特定项目的工作，如会议、沟通、调研）：')
    sharedNotes.forEach((n, i) => parts.push(`${i + 1}. ${n.content}`))
  }
  if (!projNotes.length && !sharedNotes.length) {
    parts.push('（无人工笔记）')
  }

  parts.push('', '请按系统指令，用 3 到 5 句话输出这一段中文工作总结。')
  return parts.join('\n')
}

/** 估算一个桶输入的 token（commit + 笔记合计） */
function estimateBucketTokens(bucket) {
  return estimateTokens(SYSTEM_PROMPT) + estimateTokens(buildUserPrompt(bucket))
}

/**
 * 测试 AI 连接：发起一次最小请求，验证 endpoint / 鉴权 / 模型名 / 网络是否可用。
 * - 用最小 prompt，maxTokens 压到 16，省 token
 * - retries 强制为 0、timeout 压到 15s：鉴权/模型错误要立即反馈，不要重试
 * 返回 { ok, message, model?, latencyMs? }，不抛异常（错误信息进 message）
 */
async function testProvider(cfg, apiKey) {
  const t0 = Date.now()
  try {
    const testCfg = {
      ...cfg,
      ai: {
        ...cfg.ai,
        timeoutSeconds: 15,
        retries: 0,
        // 覆盖当前 provider 的 maxTokens，省 token
        [cfg.ai.provider]: {
          ...cfg.ai[cfg.ai.provider],
          maxTokens: 16,
        },
      },
    }
    const provider = createProvider(testCfg, apiKey)
    const r = await provider.summarize('You are a connection test.', 'Reply with: OK')
    const latencyMs = Date.now() - t0
    return {
      ok: true,
      message: `连接成功 · ${r.model} · ${latencyMs}ms · 回复：${r.text.slice(0, 40)}`,
      model: r.model,
      latencyMs,
    }
  } catch (e) {
    // LLMError 子类带类型信息；统一收敛为友好文案
    const msg = e && e.message ? e.message : String(e)
    return { ok: false, message: msg, latencyMs: Date.now() - t0 }
  }
}

module.exports = {
  SYSTEM_PROMPT,
  SYSTEM_PROMPT_BASE,
  buildSystemPrompt,
  createProvider,
  buildUserPrompt,
  buildCommitsBlock,
  estimateBucketTokens,
  testProvider,
}
