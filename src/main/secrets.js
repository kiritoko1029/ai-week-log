'use strict'
// @ts-check
/**
 * API Key 加密存储：用 Electron safeStorage（Windows DPAPI / macOS Keychain）加密，
 * 密文存于 userData/secrets.json，明文不落 config.json。系统不支持加密时回退明文并标记。
 */
const fs = require('fs')
const path = require('path')

const FILE = 'secrets.json'

function filePath(dir) {
  return path.join(dir, FILE)
}

function readAll(dir) {
  try {
    if (fs.existsSync(filePath(dir))) return JSON.parse(fs.readFileSync(filePath(dir), 'utf8')) || {}
  } catch (e) {
    console.error('[weeklog] secrets 读取失败：', e.message)
  }
  return {}
}

function writeAll(dir, obj) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(filePath(dir), JSON.stringify(obj, null, 2), 'utf8')
}

// safeStorage 仅主进程可用；延迟引用以便单测时（无 electron）可注入 mock
function _safe() {
  try {
    return require('electron').safeStorage
  } catch {
    return undefined
  }
}

function isAvailable() {
  const s = _safe()
  return !!(s && s.isEncryptionAvailable && s.isEncryptionAvailable())
}

function setKey(dir, provider, plain) {
  const all = readAll(dir)
  if (!plain) {
    delete all[provider]
    writeAll(dir, all)
    return { encrypted: false }
  }
  const s = _safe()
  if (s && s.isEncryptionAvailable && s.isEncryptionAvailable()) {
    const buf = s.encryptString(plain)
    all[provider] = { enc: buf.toString('base64') }
  } else {
    all[provider] = { plain } // 回退：无系统加密时明文存储
  }
  writeAll(dir, all)
  return { encrypted: isAvailable() }
}

function getKey(dir, provider) {
  const v = readAll(dir)[provider]
  if (!v) return ''
  if (v.enc) {
    const s = _safe()
    if (s && s.decryptString) {
      try {
        return s.decryptString(Buffer.from(v.enc, 'base64'))
      } catch (e) {
        console.error('[weeklog] key 解密失败：', e.message)
        return ''
      }
    }
    return ''
  }
  return v.plain || ''
}

function hasKey(dir, provider) {
  return !!getKey(dir, provider)
}

function clearKey(dir, provider) {
  const all = readAll(dir)
  delete all[provider]
  writeAll(dir, all)
}

module.exports = {
  FILE,
  filePath,
  isAvailable,
  setKey,
  getKey,
  hasKey,
  clearKey,
}
