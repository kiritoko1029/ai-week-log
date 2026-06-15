'use strict'
/* App icon asset smoke test: verifies desktop packaging and renderer entry points. */
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
let pass = 0
let fail = 0

function ok(name, cond, extra) {
  if (cond) {
    pass++
    console.log('  PASS ' + name)
  } else {
    fail++
    console.log('  FAIL ' + name + (extra ? ' -> ' + extra : ''))
  }
}

function read(file) {
  return fs.readFileSync(path.join(root, file))
}

function pngInfo(file) {
  const buf = read(file)
  const sig = '89504e470d0a1a0a'
  if (buf.subarray(0, 8).toString('hex') !== sig) return null
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
    bitDepth: buf[24],
    colorType: buf[25],
  }
}

function icoSizes(file) {
  const buf = read(file)
  if (buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1) return []
  const count = buf.readUInt16LE(4)
  const sizes = []
  for (let i = 0; i < count; i++) {
    const offset = 6 + i * 16
    const width = buf[offset] || 256
    const height = buf[offset + 1] || 256
    const bytes = buf.readUInt32LE(offset + 8)
    const imageOffset = buf.readUInt32LE(offset + 12)
    const isPng = buf.subarray(imageOffset, imageOffset + 8).toString('hex') === '89504e470d0a1a0a'
    sizes.push({ width, height, bytes, isPng })
  }
  return sizes
}

function icnsTypes(file) {
  const buf = read(file)
  if (buf.subarray(0, 4).toString('ascii') !== 'icns') return []
  const totalSize = buf.readUInt32BE(4)
  const types = []
  for (let offset = 8; offset + 8 <= Math.min(totalSize, buf.length);) {
    const type = buf.subarray(offset, offset + 4).toString('ascii')
    const size = buf.readUInt32BE(offset + 4)
    if (size < 8) break
    types.push(type)
    offset += size
  }
  return types
}

function hasIcnsStandardCoverage(types) {
  const groups = [
    ['icp4', 'ic04'],
    ['icp5', 'ic05', 'ic11'],
    ['icp6', 'ic06', 'ic12'],
    ['ic07'],
    ['ic08', 'ic13'],
    ['ic09', 'ic14'],
    ['ic10'],
  ]
  return groups.every((group) => group.some((type) => types.includes(type)))
}

console.log('\n[Icon assets]')
ok('1024 PNG exists', fs.existsSync(path.join(root, 'build/icon.png')))
if (fs.existsSync(path.join(root, 'build/icon.png'))) {
  const info = pngInfo('build/icon.png')
  ok('1024 PNG is RGBA', info && info.width === 1024 && info.height === 1024 && info.colorType === 6, JSON.stringify(info))
}

ok('renderer favicon PNG exists', fs.existsSync(path.join(root, 'src/renderer/public/icon.png')))
if (fs.existsSync(path.join(root, 'src/renderer/public/icon.png'))) {
  const info = pngInfo('src/renderer/public/icon.png')
  ok('renderer favicon is square PNG', info && info.width === info.height && info.width >= 256, JSON.stringify(info))
}

ok('Windows ICO exists', fs.existsSync(path.join(root, 'build/icon.ico')))
if (fs.existsSync(path.join(root, 'build/icon.ico'))) {
  const sizes = icoSizes('build/icon.ico')
  ok('ICO includes small and large PNG entries', [16, 32, 256].every((s) => sizes.some((it) => it.width === s && it.height === s && it.isPng)), JSON.stringify(sizes))
}

ok('macOS ICNS exists', fs.existsSync(path.join(root, 'build/icon.icns')))
if (fs.existsSync(path.join(root, 'build/icon.icns'))) {
  const types = icnsTypes('build/icon.icns')
  ok('ICNS includes macOS standard sizes', hasIcnsStandardCoverage(types), types.join(', '))
}

console.log('\n[Electron integration]')
const pkg = JSON.parse(read('package.json').toString('utf8'))
ok('electron-builder uses build resources', pkg.build && pkg.build.directories && pkg.build.directories.buildResources === 'build', JSON.stringify(pkg.build && pkg.build.directories))
ok('mac build icon configured', pkg.build && pkg.build.mac && pkg.build.mac.icon === 'build/icon.icns')
ok('win build icon configured', pkg.build && pkg.build.win && pkg.build.win.icon === 'build/icon.ico')
ok('runtime PNG is included in packaged app files', Array.isArray(pkg.build && pkg.build.files) && pkg.build.files.includes('build/icon.png'), JSON.stringify(pkg.build && pkg.build.files))

const main = read('src/main/index.js').toString('utf8')
ok('BrowserWindow receives app icon path', main.includes('getAppIconPath') && main.includes('iconPath'))
ok('tray prefers generated app icon asset', main.includes('nativeImage.createFromPath(iconPath)'))

const indexHtml = read('src/renderer/index.html').toString('utf8')
const quicknoteHtml = read('src/renderer/quicknote.html').toString('utf8')
ok('main renderer links favicon', indexHtml.includes('rel="icon"') && indexHtml.includes('./icon.png'))
ok('quick note renderer links favicon', quicknoteHtml.includes('rel="icon"') && quicknoteHtml.includes('./icon.png'))

console.log(`\nResult: ${pass} passed, ${fail} failed\n`)
process.exit(fail ? 1 : 0)
