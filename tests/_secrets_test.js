'use strict'
/* 验证 secrets 加密存储往返（在 electron 运行时下走 safeStorage 加密；纯 node 走明文回退）。 */
const S = require('../src/main/secrets')
const os = require('os')
const path = require('path')
const fs = require('fs')

const d = path.join(os.tmpdir(), 'wl_secret_test')
fs.rmSync(d, { recursive: true, force: true })

console.log('safeStorage available:', S.isAvailable())
S.setKey(d, 'anthropic', 'sk-test-123')
const k = S.getKey(d, 'anthropic')
console.log('roundtrip:', k === 'sk-test-123' ? 'PASS' : 'FAIL', '(' + k + ')')
const raw = JSON.parse(fs.readFileSync(path.join(d, S.FILE), 'utf8'))
console.log('存储形态:', raw.anthropic.enc ? '加密(base64 密文)' : '明文回退')
S.clearKey(d, 'anthropic')
console.log('清除后:', S.hasKey(d, 'anthropic') ? 'FAIL 仍存在' : 'PASS 已清除')
