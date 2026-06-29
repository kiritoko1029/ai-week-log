'use strict'
// @ts-check
/**
 * 配置管理：存储在 Electron userData 目录下的 config.json。
 * API Key 一律从环境变量读取，不落盘。
 */
const fs = require('fs')
const path = require('path')

const CONFIG_FILE = 'config.json'

/** 默认配置（桌面版用 JSON，字段语义与 PRD/PLAN 对齐） */
function defaultConfig() {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai'
  return {
    schemaVersion: 2,
    weekStart: 'monday', // monday | sunday
    timezone: tz,
    dateBasis: 'author', // author | committer
    repos: [], // [{ id, path, name, branch, enabled, author }]
    filters: {
      author: [], // 空=不过滤
      mergeCommits: 'exclude', // exclude | include | only
      excludeGrep: [], // 正则数组
    },
    notes: {
      enabled: true,
      miscProject: '日常工作',
    },
    codexHook: {
      enabled: false,
      port: 17321,
    },
    zcodeHook: {
      enabled: false,
      port: 17322,
    },
    ui: {
      theme: 'auto', // auto | light | dark
      quickNoteShortcut: 'CommandOrControl+Shift+L', // Electron accelerator（全局唤起快速记笔记）
    },
    ai: {
      provider: 'anthropic', // openai | anthropic
      concurrency: 3,
      retries: 3,
      timeoutSeconds: 60,
      anthropic: {
        model: 'claude-sonnet-4-6',
        baseUrl: '', // 留空=官方默认
        temperature: 0.3,
        maxTokens: 800,
      },
      openai: {
        model: 'gpt-4o',
        baseUrl: '',
        temperature: 0.3,
        maxTokens: 800,
      },
      chat: {
        maxTokens: 2048, // 问答回答上限（比周报 800 更长）
        topK: 6, // RAG 注入的相关记录条数
        historyTurns: 12, // 携带的最近对话轮数（控 token）
        thinking: true, // 输出模型思考过程（Anthropic extended thinking / OpenAI reasoning，仅支持的模型生效）
      },
    },
    output: {
      format: 'text', // compact | text | md（json 兼容保留，UI 不暴露）
      newline: process.platform === 'win32' ? 'CRLF' : 'LF',
      withCommits: false,
      showNotes: false,
    },
    webdav: {
      enabled: false,
      url: '', // 如 https://dav.example.com/weeklog/
      username: '',
      autoSync: 'push', // off | push（退出时自动备份）；旧值 pull/both 兼容为启动/退出同步
      backupRetention: 10, // WebDAV 远端压缩备份保留份数
      // password 不落盘，走 secrets.js 加密存储（provider='webdav'）
    },
    memory: {
      enabled: false,
      embeddingSource: 'local', // local | api
      embeddingModel: 'Xenova/multilingual-e5-small',
      modelSource: 'auto', // auto | huggingface | modelscope（auto：探测魔搭可达性，通则魔搭否则回退 HF）
      autoGenerate: false, // 报告生成后自动产出记忆
      topK: 5, // 检索时注入 LLM 的记忆条数上限
    },
    proxy: {
      mode: 'system', // off | system | custom
      url: '', // 自定义模式下的代理 URL，如 http://127.0.0.1:7890 或 http://user:pass@host:port
    },
  }
}

function getConfigPath(dir) {
  return path.join(dir, CONFIG_FILE)
}

/** 深合并用户配置到默认配置（仅一层一层的对象合并，数组整体替换） */
function mergeConfig(base, user) {
  const out = Array.isArray(base) ? [...base] : { ...base }
  if (user && typeof user === 'object' && !Array.isArray(user)) {
    for (const key of Object.keys(user)) {
      if (
        base[key] &&
        typeof base[key] === 'object' &&
        !Array.isArray(base[key]) &&
        user[key] &&
        typeof user[key] === 'object'
      ) {
        out[key] = mergeConfig(base[key], user[key])
      } else {
        out[key] = user[key]
      }
    }
  }
  return out
}

/** 加载配置：缺失则返回默认并自动写出 */
function loadConfig(dir) {
  const file = getConfigPath(dir)
  try {
    if (fs.existsSync(file)) {
      const raw = fs.readFileSync(file, 'utf8')
      const user = JSON.parse(raw)
      return mergeConfig(defaultConfig(), user)
    }
  } catch (err) {
    // 损坏的配置：回退默认，但不静默丢失——由调用方决定是否提示
    console.error('[weeklog] 配置解析失败，使用默认配置：', err.message)
  }
  const cfg = defaultConfig()
  saveConfig(dir, cfg)
  return cfg
}

function saveConfig(dir, cfg) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(getConfigPath(dir), JSON.stringify(cfg, null, 2), 'utf8')
  return cfg
}

/**
 * 读取 API Key（按当前 provider）。优先专用环境变量，其次通用变量。
 * 返回 { key, envName, has } —— 不在日志/前端暴露完整 key。
 */
function resolveApiKey(cfg, getKeyFn) {
  const provider = cfg.ai.provider
  // 1) 优先：软件内填写（加密存储）
  if (getKeyFn) {
    const stored = getKeyFn(provider)
    if (stored) return { key: stored, envName: '（软件内填写）', has: true, source: 'stored' }
  }
  // 2) 回退：环境变量
  const candidates =
    provider === 'openai'
      ? ['WEEKLOG_OPENAI_KEY', 'OPENAI_API_KEY']
      : ['WEEKLOG_ANTHROPIC_KEY', 'ANTHROPIC_API_KEY']
  for (const name of candidates) {
    const v = process.env[name]
    if (v && v.trim()) {
      return { key: v.trim(), envName: name, has: true, source: 'env' }
    }
  }
  return { key: '', envName: candidates[candidates.length - 1], has: false, source: 'none' }
}

/** 仅返回 key 是否就绪（布尔，供前端展示） */
function apiKeyStatus(cfg, getKeyFn) {
  return resolveApiKey(cfg, getKeyFn).has
}

module.exports = {
  CONFIG_FILE,
  getConfigPath,
  defaultConfig,
  mergeConfig,
  loadConfig,
  saveConfig,
  resolveApiKey,
  apiKeyStatus,
}
