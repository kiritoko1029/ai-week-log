'use strict'
// @ts-check
/**
 * AI 记忆系统：
 * - 存储：memory/index.json（轻量：id/date/project/keywords/digest/embedding）+ memory/entries/{id}.md（全文，按需加载）
 * - embedding：本地优先（Transformers.js ONNX）、可切换 API（OpenAI）；异步队列后台补算
 * - 检索：关键词预筛 + 语义余弦重排（hybrid），仅对 topK 才加载全文 → 渐进式加载，省 token
 * - 生成：报告完成后由 pipeline 触发 buildMemoryEntry → LLM 压缩 → saveEntry（含入队 embedding）
 */

const fs = require('fs')
const path = require('path')
const https = require('https')
const http = require('http')
const { createProvider } = require('./llm')
const { estimateTokens } = require('./utils')

const MEMORY_DIR = 'memory'
const ENTRIES_DIR = 'entries'
const INDEX_FILE = 'index.json'

// ── 路径辅助 ──

function memDir(dir) { return path.join(dir, MEMORY_DIR) }
function entriesDir(dir) { return path.join(memDir(dir), ENTRIES_DIR) }
function indexPath(dir) { return path.join(memDir(dir), INDEX_FILE) }
function entryPath(dir, id) { return path.join(entriesDir(dir), `${id}.md`) }

function newId() {
  return 'm_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
}

// ── index.json 读写 ──

function readIndex(dir) {
  try {
    const p = indexPath(dir)
    if (fs.existsSync(p)) {
      const arr = JSON.parse(fs.readFileSync(p, 'utf8'))
      if (Array.isArray(arr)) return arr
    }
  } catch (e) {
    console.warn('[memory] index 读取失败：', e.message)
  }
  return []
}

function writeIndex(dir, list) {
  fs.mkdirSync(memDir(dir), { recursive: true })
  fs.writeFileSync(indexPath(dir), JSON.stringify(list, null, 2), 'utf8')
}

function listIndex(dir) {
  return readIndex(dir)
}

// ── 简易中文分词（用于关键词预筛）──

function tokenize(text) {
  if (!text) return []
  // 提取英文词组（2+ 字母/数字）与 CJK 片段再 2-gram
  const tokens = new Set()
  const lower = String(text).toLowerCase()
  // 英文/数字词
  const enWords = lower.match(/[a-z][a-z0-9_-]{1,30}/g) || []
  for (const w of enWords) {
    if (w.length >= 2) tokens.add(w)
  }
  // 中文 2-gram
  const cjk = String(text).match(/[\u4e00-\u9fff]+/g) || []
  for (const seg of cjk) {
    for (let i = 0; i < seg.length - 1; i++) tokens.add(seg.slice(i, i + 2))
    if (seg.length === 1) tokens.add(seg)
  }
  return [...tokens]
}

// ── Embedding Provider（本地 / API 切换）──

let _localPipeline = null
let _localModel = ''
let _localLoading = null
let _resolvedCacheDir = null

/** 模型下载进度回调（由外部注入，向渲染进程推送） */
let _progressCallback = null
function setModelProgressCallback(fn) {
  _progressCallback = fn
}

/**
 * 决定模型缓存目录。
 * 模型体积较大，必须放在 userData/models，避免 macOS DMG 重装替换 .app 时丢失缓存。
 * 结果缓存，避免反复探写。
 */
function resolveModelCacheDir(userDataDir) {
  if (_resolvedCacheDir) return _resolvedCacheDir
  const fs2 = require('fs')
  const cacheDir = path.join(userDataDir, 'models')
  try {
    fs2.mkdirSync(cacheDir, { recursive: true })
    const probe = path.join(cacheDir, '.wk_wprobe')
    fs2.writeFileSync(probe, 'ok', 'utf8')
    fs2.unlinkSync(probe)
  } catch {
    // 后续 Transformers.js 会在真实加载时抛出更具体的文件系统错误。
  }
  _resolvedCacheDir = cacheDir
  return _resolvedCacheDir
}

/**
 * 配置 Transformers.js 的模型下载源。
 * - huggingface: HF Hub（国外）
 * - modelscope: 魔搭社区（国内更快）
 * - auto: 探测魔搭连通性，通则走魔搭，否则回退 HF
 *
 * ModelScope 的路径结构与 HF 不同：org/model → 用 /resolve/main/ 拉取。
 * Transformers.js 通过 env.remoteHost + remotePathTemplate 控制。
 */

// 进程级缓存：auto 探测结果只算一次
let _resolvedSource = null

/**
 * 轻量连通性探测：对给定 URL 发 HEAD 请求，超时/错误即视为不可达。
 * 用原生 http(s)，避免引入额外依赖；只关心"能否连上"。
 */
function probeReachable(url, timeoutMs = 3000) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (ok) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(ok)
    }
    const lib = url.startsWith('https://') ? https : http
    const req = lib.request(url, { method: 'HEAD', timeout: timeoutMs }, (res) => {
      // 2xx/3xx/4xx 都算"能连上"，只有网络层失败才回退
      finish(res.statusCode != null && res.statusCode < 500)
    })
    const cleanup = () => {
      req.removeAllListeners()
      req.destroy()
    }
    req.on('timeout', () => finish(false))
    req.on('error', () => finish(false))
    req.end()
  })
}

/**
 * 把配置里的 modelSource 解析成实际的下载源。
 * auto 时探测魔搭；modelscope/huggingface 原样返回。
 * 探测结果做进程级缓存。
 */
async function resolveSource(source) {
  if (source !== 'auto') return source
  if (_resolvedSource) return _resolvedSource
  try {
    const ok = await probeReachable('https://modelscope.cn')
    _resolvedSource = ok ? 'modelscope' : 'huggingface'
    console.log(`[memory] auto 模型源探测：魔搭 ${ok ? '可达' : '不可达'} → 选用 ${_resolvedSource}`)
  } catch {
    _resolvedSource = 'huggingface'
    console.log('[memory] auto 模型源探测异常 → 回退 huggingface')
  }
  return _resolvedSource
}

function applySource(transformers, source) {
  const env = transformers.env
  if (source === 'modelscope') {
    // 魔搭：https://modelscope.cn/api/v1/models/{org}/{model}/resolve/main/
    env.remoteHost = 'https://modelscope.cn'
    env.remotePathTemplate = '/api/v1/models/{model}/resolve/main/'
  } else {
    // HuggingFace 默认
    env.remoteHost = 'https://huggingface.co'
    env.remotePathTemplate = '/{model}/resolve/main/'
  }
}

async function configureModelSource(transformers, source) {
  const resolved = await resolveSource(source)
  applySource(transformers, resolved)
  return resolved
}

/**
 * 懒加载本地 Transformers.js pipeline。
 * 首次调用时按 modelSource 下载模型，带进度回调，缓存到 userData/models。
 */
async function getLocalPipeline(modelName, cacheDir, modelSource) {
  if (_localPipeline && _localModel === modelName) return _localPipeline
  if (_localLoading) return _localLoading
  _localLoading = (async () => {
    try {
      // 显式用 node 版本（含 ONNX 运行时的 node 绑定）
      const transformers = require('@huggingface/transformers')
      // 配置缓存目录
      if (cacheDir) {
        try {
          transformers.env.cacheDir = cacheDir
        } catch {}
      }
      // 配置下载源（auto 会探测连通性，可能异步）
      const resolvedSource = await configureModelSource(transformers, modelSource || 'auto')
      // 禁用浏览器缓存（Node 环境不需要）
      try {
        transformers.env.useBrowserCache = false
        transformers.env.useFSCache = true
        transformers.env.allowLocalModels = false // 强制走 remote，避免找不到本地模型报错
      } catch {}

      const { pipeline } = transformers
      // progress_callback：Transformers.js v4 在下载各文件时回调
      // { status: 'progress', file, loaded, progress, total } 或 { status: 'done'/'ready' }
      const progressCb = (info) => {
        if (!_progressCallback) return
        try {
          if (info && info.status === 'progress') {
            _progressCallback({
              phase: 'downloading',
              file: info.file || '',
              loaded: info.loaded || 0,
              total: info.total || 0,
              progress: Math.round((info.progress || 0)),
            })
          } else if (info && (info.status === 'done' || info.status === 'ready')) {
            _progressCallback({
              phase: info.status,
              file: info.file || '',
            })
          }
        } catch {}
      }

      _progressCallback?.({ phase: 'start', model: modelName, source: resolvedSource })
      _localPipeline = await pipeline('feature-extraction', modelName, {
        progress_callback: progressCb,
      })
      _localModel = modelName
      _progressCallback?.({ phase: 'complete', model: modelName })
      return _localPipeline
    } catch (e) {
      console.warn('[memory] 本地 embedding 模型加载失败：', e.message)
      _progressCallback?.({ phase: 'error', model: modelName, error: e.message })
      _localPipeline = null
      _localModel = ''
      throw e
    } finally {
      _localLoading = null
    }
  })()
  return _localLoading
}

/** 对单条文本生成 embedding 向量 */
async function embed(text, cfg, dir) {
  if (!text || !text.trim()) return null
  const memCfg = (cfg && cfg.memory) || {}
  const source = memCfg.embeddingSource || 'local'
  const model = memCfg.embeddingModel || 'Xenova/multilingual-e5-small'
  const modelSource = memCfg.modelSource || 'auto'

  if (source === 'api') {
    return embedViaApi(text, cfg, model)
  }
  // 本地
  const cacheDir = resolveModelCacheDir(dir)
  try {
    const extractor = await getLocalPipeline(model, cacheDir, modelSource)
    // multilingual-e5 约定：query/passage 前缀
    const input = `query: ${text}`
    const output = await extractor(input, { pooling: 'mean', normalize: true })
    // output.data 是 Float32Array
    const arr = Array.from(output.data)
    return arr
  } catch (e) {
    console.warn('[memory] 本地 embedding 计算失败，回退 null：', e.message)
    return null
  }
}

/** 调用 OpenAI embedding API（复用 openai 配置） */
async function embedViaApi(text, cfg, model) {
  const sub = cfg.ai && cfg.ai.openai
  if (!sub) throw new Error('未配置 OpenAI（API embedding 需要 openai 配置）')
  const baseUrl = (sub.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '')
  const apiKey = cfg.__apiKey // 由调用方临时挂载
  if (!apiKey) throw new Error('API embedding 需要 apiKey')
  const url = `${baseUrl}/embeddings`
  const body = JSON.stringify({ model: model.replace('Xenova/', ''), input: text })
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body,
  })
  if (!res.ok) {
    const t = await res.text().catch(() => '')
    throw new Error(`embedding API ${res.status}: ${t.slice(0, 200)}`)
  }
  const json = await res.json()
  return (json.data && json.data[0] && json.data[0].embedding) || null
}

// ── 余弦相似度 ──

function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

// ── 模型/向量化状态探测（供设置页展示）──

/**
 * 检测本地 embedding 模型文件是否已落盘可用。
 * 以 onnx/model.onnx（或 model_quantized.onnx）+ config.json + tokenizer.json 同时存在为判定。
 * @returns {{ ready: boolean, cacheDir: string|null, modelDir: string|null, sizeMB: number, onnxFile: string|null }}
 */
function probeLocalModel(modelName, userDataDir) {
  const cacheDir = resolveModelCacheDir(userDataDir)
  const modelDir = path.join(cacheDir, modelName)
  const result = { ready: false, cacheDir, modelDir, sizeMB: 0, onnxFile: null }
  try {
    const files = fs.readdirSync(modelDir)
    const onnxDir = files.includes('onnx') ? path.join(modelDir, 'onnx') : modelDir
    const onnxCandidates = ['model.onnx', 'model_quantized.onnx']
    let onnxFile = null
    try {
      const onnxFiles = fs.readdirSync(onnxDir)
      onnxFile = onnxCandidates.find((f) => onnxFiles.includes(f))
    } catch {}
    const hasConfig = files.includes('config.json')
    const hasTokenizer = files.includes('tokenizer.json')
    if (onnxFile && hasConfig && hasTokenizer) {
      result.ready = true
      result.onnxFile = onnxFile
      // 统计整个模型目录大小
      let bytes = 0
      const walk = (d) => {
        for (const name of fs.readdirSync(d)) {
          const p = path.join(d, name)
          const st = fs.statSync(p)
          if (st.isDirectory()) walk(p)
          else bytes += st.size
        }
      }
      try { walk(modelDir) } catch {}
      result.sizeMB = Math.round((bytes / 1024 / 1024) * 10) / 10
    }
  } catch {}
  return result
}

/**
 * 聚合记忆系统的整体状态，供设置页一次性展示。
 * @param {string} dir userData 目录
 * @param {object} cfg 完整配置
 * @returns {{ source:string, model:string, modelSource:string, modelReady:boolean, modelSizeMB:number,
 *            total:number, embedded:number, dim:number, dimModel:string }}
 */
function getStatus(dir, cfg) {
  const memCfg = (cfg && cfg.memory) || {}
  const source = memCfg.embeddingSource || 'local'
  const model = memCfg.embeddingModel || 'Xenova/multilingual-e5-small'
  const modelSource = memCfg.modelSource || 'auto'

  const list = readIndex(dir)
  const total = list.length
  const embedded = list.filter((x) => x.embeddingReady && x.embedding && x.embedding.length).length

  // 向量维度：取第一条非空 embedding 的长度
  let dim = 0
  const withVec = list.find((x) => x.embedding && x.embedding.length)
  if (withVec) dim = withVec.embedding.length

  // 模型状态：仅 local 时才有意义探测文件
  let modelReady = false
  let modelSizeMB = 0
  if (source === 'local') {
    const probe = probeLocalModel(model, dir)
    modelReady = probe.ready
    modelSizeMB = probe.sizeMB
  }

  return {
    source,       // 'local' | 'api'
    model,        // 模型名
    modelSource,  // 下载源
    modelReady,   // 本地模型文件是否就绪
    modelSizeMB,  // 模型占用 MB（就绪时 >0）
    total,        // 记忆总条数
    embedded,     // 已向量化条数
    dim,          // 向量维度（0 表示尚无任何向量）
  }
}

// ── Embedding 异步队列 ──

let _queue = []          // 待处理 entry id 队列
let _workerRunning = false
let _currentDir = null
let _currentCfg = null

function enqueueEmbedding(dir, cfg, entryId) {
  _currentDir = dir
  _currentCfg = cfg
  _queue.push(entryId)
  startWorker()
}

function queueStatus() {
  return { pending: _queue.length, total: _queue.length, running: _workerRunning }
}

async function startWorker() {
  if (_workerRunning) return
  _workerRunning = true
  try {
    while (_queue.length) {
      const id = _queue.shift()
      const dir = _currentDir
      const cfg = _currentCfg
      if (!dir || !cfg) continue
      try {
        await processEmbedding(dir, cfg, id)
      } catch (e) {
        console.warn(`[memory] embedding 队列处理 ${id} 失败：`, e.message)
      }
    }
  } finally {
    _workerRunning = false
  }
}

/** 为指定 entry 计算 embedding 并回写 index */
async function processEmbedding(dir, cfg, id) {
  const list = readIndex(dir)
  const item = list.find((x) => x.id === id)
  if (!item) return
  if (item.embedding && item.embedding.length) return // 已有
  // 用 project + digest + keywords 作为 embedding 输入
  const text = [item.project, item.digest, ...(item.keywords || [])].join(' ')
  const vec = await embed(text, cfg, dir)
  if (vec && vec.length) {
    item.embedding = vec
    item.embeddingReady = true
    writeIndex(dir, list)
  }
}

// ── LLM 压缩：从报告生成一条结构化记忆 ──

const MEMORY_SYSTEM_PROMPT = `你是一个工作记忆整理助手。用户会提供一份日报/周报及相关的代码提交信息。
请把这份内容压缩成一条结构化的长期记忆，便于将来在用户写简短笔记时推断项目与工作内容。

你必须严格输出 JSON（不要 markdown 代码块、不要额外解释），格式：
{"project":"项目名","date":"YYYY-MM-DD 或日期范围","keywords":["关键概念词"],"digest":"一句话摘要（≤40字）","full":"完整记忆（2-4句，描述做了什么、用了什么技术/功能、产出）"}

keywords 要包含：项目名、功能名、技术栈、业务概念（中英文均可），便于检索匹配。
digest 要高度概括，full 要保留具体细节（如功能名、模块名）。`

function buildMemoryUserPrompt(report) {
  const parts = ['请把以下报告整理成一条长期记忆：', '']
  parts.push('【报告时间范围】')
  parts.push(`${report.rangeStart ? formatDate(report.rangeStart) : ''} ~ ${report.rangeEnd ? formatDate(report.rangeEnd) : ''}`)
  parts.push('')
  parts.push('【报告正文】')
  parts.push(report.text || '')
  parts.push('')
  // 带上分天明细（项目级）
  if (report.days && report.days.length) {
    parts.push('【分天明细】')
    for (const d of report.days) {
      if (d.paragraphs && d.paragraphs.length) {
        parts.push(`${d.dayStr}:`)
        for (const p of d.paragraphs) {
          parts.push(`  ${typeof p === 'string' ? p : (p.text || '')}`)
        }
      }
    }
  }
  parts.push('')
  parts.push('请输出 JSON。')
  return parts.join('\n')
}

function formatDate(d) {
  if (!d) return ''
  const dt = d instanceof Date ? d : new Date(d)
  if (isNaN(dt.getTime())) return String(d)
  const y = dt.getFullYear()
  const m = String(dt.getMonth() + 1).padStart(2, '0')
  const day = String(dt.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** 尝试从 LLM 返回里解析 JSON（容错：去 markdown 包裹） */
function parseMemoryJson(text) {
  if (!text) return null
  let s = text.trim()
  // 去 markdown 代码块
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  // 截取第一个 { 到最后一个 }
  const i = s.indexOf('{')
  const j = s.lastIndexOf('}')
  if (i >= 0 && j > i) s = s.slice(i, j + 1)
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}

/**
 * 从报告构建一条记忆 entry（不落盘，返回结构）。
 * @param {object} param0 { report, cfg, apiKey }
 */
async function buildMemoryEntry({ report, cfg, apiKey }) {
  if (!report || (!report.text && !report.days)) return null
  const provider = createProvider(cfg, apiKey)
  const user = buildMemoryUserPrompt(report)
  let res
  try {
    res = await provider.summarize(MEMORY_SYSTEM_PROMPT, user)
  } catch (e) {
    console.warn('[memory] 记忆压缩 LLM 调用失败：', e.message)
    return null
  }
  const parsed = parseMemoryJson(res.text)
  if (!parsed || !parsed.project) {
    // LLM 没返回合法 JSON，用报告第一段兜底
    return fallbackEntry(report)
  }
  const keywords = Array.isArray(parsed.keywords) ? parsed.keywords : []
  return {
    id: newId(),
    date: parsed.date || (report.rangeStart ? formatDate(report.rangeStart) : ''),
    project: parsed.project || '',
    keywords: keywords.map((k) => String(k)).slice(0, 20),
    digest: parsed.digest || '',
    full: parsed.full || parsed.digest || '',
    embedding: null,
    embeddingReady: false,
    model: res.model,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
}

/** LLM 失败时的兜底 entry */
function fallbackEntry(report) {
  const firstProject = (report.days && report.days[0] && report.days[0].paragraphs && report.days[0].paragraphs[0]) || ''
  const firstText = typeof firstProject === 'string' ? firstProject : (firstProject.text || '')
  const project = (firstText.match(/项目[：:]\s*(\S+)/) || [])[1] || ''
  const date = report.rangeStart ? formatDate(report.rangeStart) : ''
  return {
    id: newId(),
    date,
    project: project || '未分类',
    keywords: tokenize(firstText).slice(0, 10),
    digest: firstText.slice(0, 40),
    full: firstText,
    embedding: null,
    embeddingReady: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
}

/** 保存 entry：写 entries/{id}.md + 更新 index.json + 入队 embedding */
function saveEntry(dir, entry) {
  if (!entry || !entry.id) return null
  fs.mkdirSync(entriesDir(dir), { recursive: true })
  // 写全文
  const fullContent = [
    `# ${entry.project || '未分类'}`,
    '',
    `- 日期：${entry.date || ''}`,
    `- 摘要：${entry.digest || ''}`,
    `- 关键词：${(entry.keywords || []).join('、')}`,
    '',
    entry.full || '',
    '',
  ].join('\n')
  fs.writeFileSync(entryPath(dir, entry.id), fullContent, 'utf8')
  // 更新 index（去掉 embedding 不写进 md）
  const list = readIndex(dir)
  const idxItem = {
    id: entry.id,
    date: entry.date,
    project: entry.project,
    keywords: entry.keywords || [],
    digest: entry.digest || '',
    embedding: entry.embedding || null,
    embeddingReady: !!entry.embeddingReady,
    updatedAt: entry.updatedAt || new Date().toISOString(),
    createdAt: entry.createdAt || new Date().toISOString(),
  }
  const existIdx = list.findIndex((x) => x.id === entry.id)
  if (existIdx >= 0) list[existIdx] = idxItem
  else list.unshift(idxItem)
  // 限制条数（最近 1000 条）
  const trimmed = list.slice(0, 1000)
  writeIndex(dir, trimmed)

  // 入队 embedding 异步计算（需要 cfg —— 但 saveEntry 不持有 cfg，改由 pipeline 调用后单独入队）
  return idxItem
}

/** 删除一条记忆 */
function deleteEntry(dir, id) {
  const list = readIndex(dir)
  const next = list.filter((x) => x.id !== id)
  writeIndex(dir, next)
  try {
    const p = entryPath(dir, id)
    if (fs.existsSync(p)) fs.unlinkSync(p)
  } catch {}
  return { ok: true }
}

// ── 混合检索：关键词预筛 + 语义重排 ──

/**
 * 检索与 query 相关的记忆，仅对 topK 条加载全文。
 * @returns {Promise<Array<{id,date,project,digest,full,keywords,score}>>}
 */
async function search(dir, query, { topK = 5, cfg = null } = {}) {
  if (!query || !query.trim()) return []
  const list = readIndex(dir)
  if (!list.length) return []

  const qTokens = new Set(tokenize(query))

  // 1) 关键词预筛：计算每条与 query 的关键词命中数
  const scored = list.map((item) => {
    const itemTokens = new Set([
      ...(item.keywords || []),
      ...tokenize(item.project || ''),
      ...tokenize(item.digest || ''),
    ])
    let hits = 0
    for (const t of qTokens) if (itemTokens.has(t)) hits++
    return { item, hits }
  })

  // 取有命中 + 其余降级全量（保证总能返回结果）
  let candidates = scored.filter((s) => s.hits > 0)
  if (candidates.length === 0) candidates = scored

  // 2) 语义重排：若有 embedding，按余弦相似度；否则用关键词得分
  let qVec = null
  if (cfg) {
    try {
      qVec = await embed(query, cfg, dir)
    } catch {
      qVec = null
    }
  }

  candidates.sort((a, b) => {
    if (qVec && a.item.embedding && b.item.embedding) {
      return cosine(qVec, b.item.embedding) - cosine(qVec, a.item.embedding)
    }
    if (qVec && a.item.embedding && !b.item.embedding) return -1
    if (qVec && !a.item.embedding && b.item.embedding) return 1
    return b.hits - a.hits
  })

  const top = candidates.slice(0, topK || 5)

  // 3) 仅对 topK 加载全文（渐进式）
  return top.map(({ item, hits }) => {
    let full = item.digest || ''
    try {
      const p = entryPath(dir, item.id)
      if (fs.existsSync(p)) {
        const raw = fs.readFileSync(p, 'utf8')
        // 去掉 markdown 标题与元信息行，取正文
        const lines = raw.split('\n').filter((l) => !l.startsWith('#') && !l.startsWith('- '))
        full = lines.join('\n').trim() || full
      }
    } catch {}
    const score = qVec && item.embedding ? cosine(qVec, item.embedding) : hits
    return {
      id: item.id,
      date: item.date,
      project: item.project,
      digest: item.digest,
      keywords: item.keywords || [],
      full,
      score,
    }
  })
}

// ── 用记忆辅助推断项目（NotesPage 写笔记时调用）──

const INFER_SYSTEM_PROMPT = `你是一个项目推断助手。用户正在写一段简短、可能信息不全的工作笔记。
我会提供一些历史记忆条目（项目、摘要、关键词）。请根据用户笔记内容，判断它最可能属于哪个项目、以及在做什么工作。

你必须严格输出 JSON（不要 markdown 代码块）：
{"project":"推断的项目名（若无法判断则空字符串）","confidence":0到1的数字,"reason":"推断理由（≤30字）","suggestedSummary":"基于记忆补全的一句话工作描述"}

如果没有任何记忆能匹配，project 返回空字符串、confidence 返回 0。`

async function inferProject(dir, noteText, { cfg, apiKey }) {
  if (!noteText || noteText.trim().length < 3) return { project: '', confidence: 0 }
  const memCfg = cfg.memory || {}
  const topK = memCfg.topK || 5
  const hits = await search(dir, noteText, { topK, cfg })
  if (!hits.length) return { project: '', confidence: 0, reason: '无匹配记忆' }

  const provider = createProvider(cfg, apiKey)
  const memoryBlock = hits.map((h, i) =>
    `${i + 1}. 项目【${h.project}】（${h.date}）：${h.digest}\n   关键词：${(h.keywords || []).join('、')}\n   详情：${h.full}`
  ).join('\n')

  const user = [
    '用户当前笔记：',
    noteText,
    '',
    '相关历史记忆：',
    memoryBlock,
    '',
    '请输出 JSON。',
  ].join('\n')

  let res
  try {
    res = await provider.summarize(INFER_SYSTEM_PROMPT, user)
  } catch (e) {
    return { project: hits[0].project, confidence: hits[0].score || 0, reason: 'LLM 失败，取最相似记忆', matches: hits }
  }
  const parsed = parseMemoryJson(res.text)
  if (!parsed) {
    return { project: hits[0].project, confidence: hits[0].score || 0, reason: 'LLM 返回不可解析', matches: hits }
  }
  return {
    project: parsed.project || '',
    confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0,
    reason: parsed.reason || '',
    suggestedSummary: parsed.suggestedSummary || '',
    matches: hits.map((h) => ({ project: h.project, date: h.date, digest: h.digest, score: h.score })),
  }
}

// ── 全量重建（遍历 history.json 重新生成记忆）──

async function rebuild(dir, { cfg, apiKey, history, onProgress } = {}) {
  // history 由 ipc.js 传入或这里读取
  const list = history || (() => {
    try {
      const p = path.join(dir, 'history.json')
      if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8')) || []
    } catch {}
    return []
  })()

  const results = { generated: 0, failed: 0 }
  // 清空旧索引与条目
  try {
    writeIndex(dir, [])
    const ed = entriesDir(dir)
    if (fs.existsSync(ed)) {
      for (const f of fs.readdirSync(ed)) fs.unlinkSync(path.join(ed, f))
    }
  } catch {}

  for (let i = 0; i < list.length; i++) {
    const h = list[i]
    try {
      const entry = await buildMemoryEntry({ report: { text: h.text || '', rangeStart: h.rangeStart, rangeEnd: h.rangeEnd, days: h.days }, cfg, apiKey })
      if (entry) {
        saveEntry(dir, entry)
        // 入队 embedding
        enqueueEmbedding(dir, cfg, entry.id)
        results.generated++
      }
    } catch {
      results.failed++
    }
    if (onProgress) try { onProgress({ done: i + 1, total: list.length }) } catch {}
  }
  return results
}

module.exports = {
  buildMemoryEntry,
  saveEntry,
  deleteEntry,
  listIndex,
  readIndex,
  writeIndex,
  search,
  inferProject,
  rebuild,
  enqueueEmbedding,
  queueStatus,
  getStatus,
  probeLocalModel,
  resolveModelCacheDir,
  tokenize,
  cosine,
  setModelProgressCallback,
  // 路径导出（供 webdav / 测试用）
  memDir,
  entriesDir,
  indexPath,
  entryPath,
}
