'use strict'
/**
 * 启动器：在干净的环境中运行 Electron（清除 ELECTRON_RUN_AS_NODE）。
 *
 * 背景：部分开发者环境全局设置了 ELECTRON_RUN_AS_NODE=1，
 * 这会让 Electron 以纯 Node.js 模式启动，app / BrowserWindow 等 API 全部不可用。
 * 此脚本在 spawn electron 进程前，从环境对象中 delete 掉该变量，
 * 确保 Electron 以正常 GUI 模式运行。
 */
const { spawn } = require('child_process')
const path = require('path')

// 从环境副本中彻底删除该变量（而非设为空字符串）
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

// 定位 electron 可执行文件
const electronPath = require('electron') // node_modules/electron 的 index.js 返回二进制路径

const args = process.argv.slice(2) // 透传参数，如 "." / "."

const child = spawn(electronPath, args, {
  stdio: 'inherit',
  env,
  cwd: process.cwd(),
})

child.on('error', (e) => {
  console.error('[run-electron] 启动失败：', e.message)
  process.exit(1)
})

child.on('exit', (code) => {
  process.exit(code ?? 0)
})
