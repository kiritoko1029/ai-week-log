'use strict'
// @ts-check
/**
 * 网络代理应用：把 cfg.proxy 落地为 Node 的全局代理。
 *
 * 覆盖两条出站路径：
 *  1. 全局 fetch（undici）：setGlobalDispatcher —— 覆盖 LLM（base.js/stream.js）、
 *     WebDAV（webdav.js）、embeddings（memory.js）等所有用 fetch 的主进程请求。
 *  2. node http(s) 模块：https.globalAgent / http.globalAgent —— 覆盖 updater.js
 *     的 https.get（更新检查/下载）与 memory.js 的 probeReachable。
 *
 * 「跟随系统代理」模式读取进程环境变量 HTTPS_PROXY / https_proxy / HTTP_PROXY / http_proxy
 * （Node 无法可靠读取各 OS 的系统代理设置，env 变量是跨平台标准约定，Clash/V2Ray 等通常会设置）。
 */
const http = require('http')
const https = require('https')
const { Agent, ProxyAgent, setGlobalDispatcher, getGlobalDispatcher } = require('undici')
const { HttpsProxyAgent } = require('https-proxy-agent')
const { HttpProxyAgent } = require('http-proxy-agent')

/** 缓存上一次应用的代理 URL，避免重复 setGlobalDispatcher（每次都会创建新实例） */
let lastAppliedUrl = null

/**
 * 读取系统环境变量中的代理地址。
 * @returns {string}
 */
function readSystemProxy() {
  return (
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    ''
  )
}

/**
 * 根据 cfg.proxy 计算最终生效的代理 URL（空串=直连）。
 * @param {object} cfg
 * @returns {string}
 */
function getEffectiveProxyUrl(cfg) {
  const proxy = (cfg && cfg.proxy) || {}
  if (!proxy || proxy.mode === 'off') return ''
  if (proxy.mode === 'system') return readSystemProxy()
  if (proxy.mode === 'custom') {
    const url = (proxy.url || '').trim()
    if (!url) return ''
    try {
      // 校验可解析
      // eslint-disable-next-line no-new
      new URL(url)
      return url
    } catch {
      return ''
    }
  }
  return ''
}

/** 把含凭证的代理 URL 脱敏为日志安全的形态 */
function maskUrl(url) {
  if (!url) return ''
  try {
    const u = new URL(url)
    if (u.username || u.password) {
      return `${u.protocol}//***@${u.host}`
    }
    return u.origin
  } catch {
    return '(invalid)'
  }
}

/**
 * 应用代理到全局 fetch（undici）+ http(s) 全局 agent。
 * 幂等：相同 url 不会重复应用；url 变化时才重新设置。
 * @param {object} cfg
 * @param {{ info?: Function, warn?: Function } | null} [logger]
 */
function applyProxy(cfg, logger) {
  const url = getEffectiveProxyUrl(cfg)
  // 幂等：url 未变则跳过
  if (url === lastAppliedUrl) return

  const log = logger || null
  if (!url) {
    // 切回直连：undici 用默认 Agent；http(s) 还原默认 globalAgent
    setGlobalDispatcher(new Agent())
    http.globalAgent = new http.Agent()
    https.globalAgent = new https.Agent()
    lastAppliedUrl = ''
    if (log && log.info) log.info('proxy', '已切换为直连（不使用代理）')
    return
  }

  try {
    // 1. 全局 fetch → undici ProxyAgent
    setGlobalDispatcher(new ProxyAgent(url))
    // 2. node https/http 模块 → globalAgent（updater 的 https.get / memory 的 probeReachable）
    https.globalAgent = new HttpsProxyAgent(url)
    http.globalAgent = new HttpProxyAgent(url)
    lastAppliedUrl = url
    if (log && log.info) {
      log.info('proxy', '代理已生效', { mode: cfg.proxy.mode, url: maskUrl(url) })
    }
  } catch (e) {
    lastAppliedUrl = ''
    if (log && log.warn) log.warn('proxy', '应用代理失败，回退直连', { error: e.message })
  }
}

module.exports = { applyProxy, getEffectiveProxyUrl, readSystemProxy }
