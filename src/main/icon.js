'use strict'
// @ts-check
/**
 * 运行时生成托盘图标（PNG Buffer），避免在仓库中维护二进制资源。
 * 设计：圆角蓝底 + 三根上升白色柱状条，呼应「周报 / 增长」主题。
 */
const zlib = require('zlib')

// CRC32 查表实现（PNG chunk 校验需要）
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([len, typeBuf, data, crc])
}

/** 把 RGBA 像素缓冲编码为 PNG Buffer */
function encodePng(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // 位深
  ihdr[9] = 6 // 颜色类型 RGBA
  ihdr[10] = 0 // 压缩
  ihdr[11] = 0 // 滤波
  ihdr[12] = 0 // 隔行
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0 // 滤波器：none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride)
  }
  const idat = zlib.deflateSync(raw, { level: 9 })
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))])
}

/**
 * 生成托盘图标 PNG Buffer。
 * @param {number} size 边长（像素），默认 32
 * @returns {Buffer} PNG 数据
 */
function trayIconBuffer(size = 32) {
  const buf = Buffer.alloc(size * size * 4)
  const r = Math.max(1, Math.round(size * 0.22)) // 圆角半径
  const set = (x, y, [cr, cg, cb, ca]) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return
    const i = (y * size + x) * 4
    buf[i] = cr; buf[i + 1] = cg; buf[i + 2] = cb; buf[i + 3] = ca
  }
  const blue = [37, 99, 235, 255]
  // 圆角蓝底
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const cx = Math.min(x, size - 1 - x)
      const cy = Math.min(y, size - 1 - y)
      let inside = true
      if (cx < r && cy < r) {
        const dx = r - cx
        const dy = r - cy
        if (dx * dx + dy * dy > r * r) inside = false
      }
      if (inside) set(x, y, blue)
    }
  }
  // 三根上升白色柱状条
  const margin = Math.round(size * 0.14)
  const baseY = size - margin
  const barW = Math.max(2, Math.round(size * 0.13))
  const gap = Math.max(2, Math.round(size * 0.06))
  const totalW = barW * 3 + gap * 2
  let bx = Math.round((size - totalW) / 2)
  const heights = [Math.round(size * 0.22), Math.round(size * 0.36), Math.round(size * 0.5)]
  for (const h of heights) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < barW; x++) set(bx + x, baseY - 1 - y, [255, 255, 255, 255])
    }
    bx += barW + gap
  }
  return encodePng(size, size, buf)
}

module.exports = { trayIconBuffer }
