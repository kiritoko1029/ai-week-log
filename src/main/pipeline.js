'use strict'
// @ts-check
/**
 * 编排层：collect（采集+笔记+聚合，dry-run 用）与 generate（完整生成报告）。
 * 采集 → 加载笔记 → 聚合分桶（含笔记融合）→ 并发 AI 总结（失败降级）→ 渲染。
 */
const { resolveRange, isoDate, parseDateInput } = require('./utils')
const { collectRepo } = require('./git')
const { loadNotes } = require('./notes')
const { aggregate } = require('./aggregator')
const { createProvider, buildUserPrompt, buildSystemPrompt, estimateBucketTokens } = require('./llm')
const { render } = require('./render')
const preferences = require('./preferences')

function enabledRepos(cfg, filter) {
  let repos = (cfg.repos || []).filter((r) => r.enabled !== false)
  if (filter && filter.length) {
    repos = repos.filter((r) => filter.includes(r.name) || filter.includes(r.path))
  }
  return repos
}

/**
 * 采集 + 加载笔记 + 聚合（不调用 AI）。
 * @returns {Promise<{range, commits, notes, buckets, stats}>}
 */
async function collect({ cfg, rangeOpts = {}, notesDir, options = {} }) {
  const { from, to } = resolveRange(rangeOpts, options.weekStart || cfg.weekStart)
  const range = { from: isoDate(from), to: isoDate(to) }
  const miscProject = (cfg.notes && cfg.notes.miscProject) || '日常工作'
  const repos = enabledRepos(cfg, options.repos)

  const baseFilters = cfg.filters || {}
  const filters = {
    author: options.author ? (Array.isArray(options.author) ? options.author : [options.author]) : baseFilters.author,
    mergeCommits: options.merge || baseFilters.mergeCommits || 'exclude',
    excludeGrep: baseFilters.excludeGrep,
  }
  const allCommits = []
  const repoErrors = []
  for (const repo of repos) {
    try {
      allCommits.push(...collectRepo(repo, range, filters))
    } catch (e) {
      repoErrors.push({ repo: repo.name || repo.path, error: e.message })
    }
  }

  const notes = options.noNotes ? [] : loadNotes(notesDir, range.from, range.to, miscProject)
  let buckets = aggregate(allCommits, notes, miscProject, repos)

  if (options.projects && options.projects.length) {
    const allow = new Set([...options.projects, miscProject])
    buckets = buckets.filter((b) => allow.has(b.project))
  }

  const estTokens = buckets.reduce((s, b) => s + estimateBucketTokens(b), 0)
  const daySet = new Set(buckets.map((b) => b.dayStr))

  return {
    range,
    commits: allCommits,
    notes,
    buckets,
    stats: {
      commitCount: allCommits.length,
      noteCount: notes.length,
      noteProjectCount: notes.filter((n) => n.project).length,
      noteMiscCount: notes.filter((n) => !n.project).length,
      bucketCount: buckets.length,
      notesOnlyCount: buckets.filter((b) => b.isNotesOnly).length,
      estTokens,
      days: daySet.size,
      repoErrors,
    },
  }
}

function makeParagraph(bucket, text, degraded) {
  return {
    project: bucket.displayName || bucket.project,
    text,
    degraded,
    sourceCommitCount: bucket.commits.length,
    sourceNoteCount: bucket.notes.length + bucket.sharedNotes.length,
    isNotesOnly: bucket.isNotesOnly,
    commits: bucket.commits,
    notes: bucket.notes,
    sharedNotes: bucket.sharedNotes,
  }
}

function stripConvPrefix(s) {
  return (s || '').replace(/^(feat|fix|perf|refactor|docs|test|chore|style|build|ci)(\(.+?\))?:\s*/, '').trim()
}

/** AI 失败时的本地降级摘要（commit subject + 笔记原文） */
function fallbackSummary(bucket) {
  const items = []
  for (const c of (bucket.commits || []).slice(0, 8)) {
    const s = stripConvPrefix(c.subject)
    if (s) items.push(s)
  }
  for (const n of bucket.notes || []) if (n.content) items.push(n.content)
  for (const n of bucket.sharedNotes || []) if (n.content) items.push(n.content)
  const more = (bucket.commits || []).length > 8 ? `，以及其余 ${(bucket.commits || []).length - 8} 项改动` : ''
  const body = items.filter(Boolean).join('；')
  return `本日主要完成：${body}${more}。（注：AI 总结不可用，以上为提交与笔记摘要）`
}

/**
 * 完整生成报告（采集→笔记→聚合→AI 总结→渲染）。
 * @param {object} args - { cfg, apiKey, rangeOpts, notesDir, options, onProgress }
 */
async function generate({ cfg, apiKey, rangeOpts = {}, notesDir, options = {}, onProgress }) {
  const t0 = Date.now()
  const collected = await collect({ cfg, rangeOpts, notesDir, options })
  const { buckets, range } = collected

  if (!buckets.length) {
    return {
      rangeStart: parseDateInput(range.from),
      rangeEnd: parseDateInput(range.to),
      days: [],
      failedUnits: [],
      meta: { empty: true, durationMs: Date.now() - t0 },
      text: '指定范围内无工作记录（无 commit 且无笔记）。请检查时间范围、作者过滤或笔记。',
    }
  }

  const provider = createProvider(cfg, apiKey)

  // 读取写作偏好（启用项），构造含偏好注入的系统提示词；无偏好时等价于纯 SYSTEM_PROMPT
  const userDataDir = options.userDataDir
  const prefs = userDataDir ? preferences.enabledRules(userDataDir) : []
  const systemPrompt = buildSystemPrompt(prefs)

  const limit = cfg.ai.concurrency || 3
  const paragraphs = new Array(buckets.length)
  const failedUnits = []
  let inputTokens = 0
  let outputTokens = 0
  let done = 0

  const summarizeOne = async (i) => {
    const b = buckets[i]
    try {
      const user = buildUserPrompt(b)
      const res = await provider.summarize(systemPrompt, user)
      inputTokens += res.inputTokens || 0
      outputTokens += res.outputTokens || 0
      paragraphs[i] = makeParagraph(b, res.text, false)
    } catch (e) {
      failedUnits.push(`${b.dayStr} ${b.project}`)
      paragraphs[i] = makeParagraph(b, fallbackSummary(b), true)
    } finally {
      done++
      if (onProgress) {
        try {
          onProgress({ done, total: buckets.length, project: b.project, dayStr: b.dayStr })
        } catch {}
      }
    }
  }

  let cursor = 0
  const workerCount = Math.min(limit, buckets.length) || 1
  const workers = Array.from({ length: workerCount }, async () => {
    while (cursor < buckets.length) {
      const i = cursor++
      await summarizeOne(i)
    }
  })
  await Promise.all(workers)

  // 按天分组
  const daysMap = new Map()
  for (let i = 0; i < buckets.length; i++) {
    const b = buckets[i]
    if (!daysMap.has(b.dayStr)) {
      daysMap.set(b.dayStr, { day: b.day, dayStr: b.dayStr, paragraphs: [] })
    }
    daysMap.get(b.dayStr).paragraphs.push(paragraphs[i])
  }
  const days = [...daysMap.values()].sort((a, b) => (a.dayStr < b.dayStr ? -1 : 1))

  const report = {
    rangeStart: parseDateInput(range.from),
    rangeEnd: parseDateInput(range.to),
    days,
    failedUnits,
    meta: {
      provider: cfg.ai.provider,
      model: provider.model,
      commitCount: collected.stats.commitCount,
      noteCount: collected.stats.noteCount,
      bucketCount: buckets.length,
      notesOnlyCount: collected.stats.notesOnlyCount,
      inputTokens,
      outputTokens,
      durationMs: Date.now() - t0,
      repoErrors: collected.stats.repoErrors,
    },
  }
  report.text = render(report, {
    format: options.format || (cfg.output && cfg.output.format) || 'text',
    withCommits: options.withCommits ?? (cfg.output && cfg.output.withCommits) ?? false,
    showNotes: options.showNotes ?? (cfg.output && cfg.output.showNotes) ?? false,
    newline: options.newline || (cfg.output && cfg.output.newline),
  })

  // ── AI 记忆：报告成功后异步生成一条记忆（不阻塞返回）──
  try {
    const memCfg = cfg.memory
    const userDataDir = options.userDataDir
    if (memCfg && memCfg.enabled && memCfg.autoGenerate && report.days.length && userDataDir && apiKey) {
      const memory = require('./memory')
      // fire-and-forget；失败只 warn
      memory.buildMemoryEntry({ report, cfg, apiKey }).then((entry) => {
        if (entry) {
          memory.saveEntry(userDataDir, entry)
          memory.enqueueEmbedding(userDataDir, cfg, entry.id)
        }
      }).catch((e) => console.warn('[weeklog] 记忆生成失败：', e.message))
    }
  } catch (e) {
    console.warn('[weeklog] 记忆模块加载失败：', e.message)
  }

  return report
}

module.exports = { collect, generate, fallbackSummary, stripConvPrefix }
