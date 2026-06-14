'use strict'
// Generate WeekLog app icons without external dependencies.
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

const ROOT = path.resolve(__dirname, '..')
const BUILD_DIR = path.join(ROOT, 'build')
const PUBLIC_DIR = path.join(ROOT, 'src', 'renderer', 'public')

const PALETTE = {
  bg: [15, 23, 42, 255],
  bg2: [30, 41, 59, 255],
  page: [248, 250, 252, 255],
  pageEdge: [203, 213, 225, 255],
  ink: [71, 85, 105, 255],
  cyan: [34, 211, 238, 255],
  cyanDark: [14, 165, 233, 255],
}

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

function encodePng(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride)
  }

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

function mix(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
    Math.round(a[3] + (b[3] - a[3]) * t),
  ]
}

function blend(dst, src) {
  const a = src[3] / 255
  const inv = 1 - a
  return [
    Math.round(src[0] * a + dst[0] * inv),
    Math.round(src[1] * a + dst[1] * inv),
    Math.round(src[2] * a + dst[2] * inv),
    Math.round((src[3] + dst[3] * inv)),
  ]
}

function roundedRectAlpha(x, y, left, top, width, height, radius) {
  const right = left + width
  const bottom = top + height
  if (x < left || x >= right || y < top || y >= bottom) return 0

  const innerLeft = left + radius
  const innerRight = right - radius
  const innerTop = top + radius
  const innerBottom = bottom - radius

  if ((x >= innerLeft && x < innerRight) || (y >= innerTop && y < innerBottom)) return 1

  const cx = x < innerLeft ? innerLeft : innerRight - 1
  const cy = y < innerTop ? innerTop : innerBottom - 1
  const dx = x - cx
  const dy = y - cy
  const dist = Math.sqrt(dx * dx + dy * dy)
  return Math.max(0, Math.min(1, radius + 0.5 - dist))
}

function drawRoundedRect(buf, size, rect, color) {
  const [left, top, width, height, radius] = rect
  const minX = Math.max(0, Math.floor(left - 1))
  const minY = Math.max(0, Math.floor(top - 1))
  const maxX = Math.min(size, Math.ceil(left + width + 1))
  const maxY = Math.min(size, Math.ceil(top + height + 1))
  for (let y = minY; y < maxY; y++) {
    for (let x = minX; x < maxX; x++) {
      const a = roundedRectAlpha(x + 0.5, y + 0.5, left, top, width, height, radius)
      if (a <= 0) continue
      const i = (y * size + x) * 4
      const dst = [buf[i], buf[i + 1], buf[i + 2], buf[i + 3]]
      const out = blend(dst, [color[0], color[1], color[2], Math.round(color[3] * a)])
      buf[i] = out[0]; buf[i + 1] = out[1]; buf[i + 2] = out[2]; buf[i + 3] = out[3]
    }
  }
}

function drawPolygon(buf, size, points, color) {
  const minX = Math.max(0, Math.floor(Math.min(...points.map((p) => p[0]))))
  const minY = Math.max(0, Math.floor(Math.min(...points.map((p) => p[1]))))
  const maxX = Math.min(size, Math.ceil(Math.max(...points.map((p) => p[0]))))
  const maxY = Math.min(size, Math.ceil(Math.max(...points.map((p) => p[1]))))

  function inside(px, py) {
    let hit = false
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
      const xi = points[i][0], yi = points[i][1]
      const xj = points[j][0], yj = points[j][1]
      const intersect = ((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi) + xi)
      if (intersect) hit = !hit
    }
    return hit
  }

  for (let y = minY; y < maxY; y++) {
    for (let x = minX; x < maxX; x++) {
      if (!inside(x + 0.5, y + 0.5)) continue
      const i = (y * size + x) * 4
      const dst = [buf[i], buf[i + 1], buf[i + 2], buf[i + 3]]
      const out = blend(dst, color)
      buf[i] = out[0]; buf[i + 1] = out[1]; buf[i + 2] = out[2]; buf[i + 3] = out[3]
    }
  }
}

function drawIconPng(size) {
  const buf = Buffer.alloc(size * size * 4)

  for (let y = 0; y < size; y++) {
    const t = y / Math.max(1, size - 1)
    const row = mix(PALETTE.bg2, PALETTE.bg, t)
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4
      buf[i] = row[0]; buf[i + 1] = row[1]; buf[i + 2] = row[2]; buf[i + 3] = row[3]
    }
  }

  // Keep the app icon itself inside a rounded square silhouette for macOS/Windows.
  const mask = Buffer.from(buf)
  buf.fill(0)
  const bgRadius = size * 0.225
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const a = roundedRectAlpha(x + 0.5, y + 0.5, 0, 0, size, size, bgRadius)
      if (a <= 0) continue
      const i = (y * size + x) * 4
      buf[i] = mask[i]; buf[i + 1] = mask[i + 1]; buf[i + 2] = mask[i + 2]; buf[i + 3] = Math.round(255 * a)
    }
  }

  const pageW = size * 0.48
  const pageH = size * 0.58
  const pageX = size * 0.26
  const pageY = size * 0.21
  const pageR = size * 0.045
  const shadowOffset = Math.max(1, size * 0.018)
  drawRoundedRect(buf, size, [pageX + shadowOffset, pageY + shadowOffset, pageW, pageH, pageR], [2, 6, 23, 70])
  drawRoundedRect(buf, size, [pageX, pageY, pageW, pageH, pageR], PALETTE.page)

  const fold = size * 0.135
  drawPolygon(buf, size, [
    [pageX + pageW - fold, pageY],
    [pageX + pageW, pageY],
    [pageX + pageW, pageY + fold],
  ], [226, 232, 240, 255])
  drawPolygon(buf, size, [
    [pageX + pageW - fold, pageY],
    [pageX + pageW - fold, pageY + fold],
    [pageX + pageW, pageY + fold],
  ], [203, 213, 225, 235])

  const accentX = pageX + size * 0.085
  const accentY = pageY + size * 0.14
  drawRoundedRect(buf, size, [accentX, accentY, size * 0.09, size * 0.09, size * 0.022], PALETTE.cyan)
  drawRoundedRect(buf, size, [accentX + size * 0.025, accentY + size * 0.025, size * 0.04, size * 0.04, size * 0.012], PALETTE.cyanDark)

  const lineX = pageX + size * 0.21
  const lineY = pageY + size * 0.16
  const lineH = Math.max(2, size * 0.032)
  const lineR = lineH / 2
  drawRoundedRect(buf, size, [lineX, lineY, size * 0.19, lineH, lineR], PALETTE.ink)
  drawRoundedRect(buf, size, [pageX + size * 0.09, pageY + size * 0.33, size * 0.3, lineH, lineR], [100, 116, 139, 255])
  drawRoundedRect(buf, size, [pageX + size * 0.09, pageY + size * 0.45, size * 0.24, lineH, lineR], [100, 116, 139, 255])

  return encodePng(size, size, buf)
}

function makeIco(entries) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(entries.length, 4)

  let offset = 6 + entries.length * 16
  const dir = Buffer.alloc(entries.length * 16)
  entries.forEach((entry, index) => {
    const p = index * 16
    dir[p] = entry.size >= 256 ? 0 : entry.size
    dir[p + 1] = entry.size >= 256 ? 0 : entry.size
    dir[p + 2] = 0
    dir[p + 3] = 0
    dir.writeUInt16LE(1, p + 4)
    dir.writeUInt16LE(32, p + 6)
    dir.writeUInt32LE(entry.png.length, p + 8)
    dir.writeUInt32LE(offset, p + 12)
    offset += entry.png.length
  })

  return Buffer.concat([header, dir, ...entries.map((entry) => entry.png)])
}

function icnsChunk(type, png) {
  const header = Buffer.alloc(8)
  header.write(type, 0, 4, 'ascii')
  header.writeUInt32BE(png.length + 8, 4)
  return Buffer.concat([header, png])
}

function makeIcns(entries) {
  const chunks = entries.map((entry) => icnsChunk(entry.type, entry.png))
  const header = Buffer.alloc(8)
  header.write('icns', 0, 4, 'ascii')
  header.writeUInt32BE(8 + chunks.reduce((sum, item) => sum + item.length, 0), 4)
  return Buffer.concat([header, ...chunks])
}

function main() {
  fs.mkdirSync(BUILD_DIR, { recursive: true })
  fs.mkdirSync(PUBLIC_DIR, { recursive: true })

  const pngs = new Map()
  for (const size of [16, 32, 64, 128, 256, 512, 1024]) {
    pngs.set(size, drawIconPng(size))
  }

  fs.writeFileSync(path.join(BUILD_DIR, 'icon.png'), pngs.get(1024))
  fs.writeFileSync(path.join(PUBLIC_DIR, 'icon.png'), pngs.get(512))

  fs.writeFileSync(path.join(BUILD_DIR, 'icon.ico'), makeIco([
    { size: 16, png: pngs.get(16) },
    { size: 32, png: pngs.get(32) },
    { size: 48, png: drawIconPng(48) },
    { size: 64, png: pngs.get(64) },
    { size: 128, png: pngs.get(128) },
    { size: 256, png: pngs.get(256) },
  ]))

  fs.writeFileSync(path.join(BUILD_DIR, 'icon.icns'), makeIcns([
    { type: 'icp4', png: pngs.get(16) },
    { type: 'icp5', png: pngs.get(32) },
    { type: 'icp6', png: pngs.get(64) },
    { type: 'ic07', png: pngs.get(128) },
    { type: 'ic08', png: pngs.get(256) },
    { type: 'ic09', png: pngs.get(512) },
    { type: 'ic10', png: pngs.get(1024) },
  ]))

  console.log('Generated WeekLog icons:')
  console.log('  build/icon.png')
  console.log('  build/icon.ico')
  console.log('  build/icon.icns')
  console.log('  src/renderer/public/icon.png')
}

main()
