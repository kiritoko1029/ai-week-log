import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'

// 读取 package.json 版本号作为单一来源，注入为编译期常量 __APP_VERSION__
const appVersion = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8')).version

/**
 * Electron 通过 file:// 加载打包产物。
 * Vite 会给 module script 与 modulepreload link 注入 crossorigin 属性，
 * 在 file:// 下这会导致脚本加载失败（黑屏）。此插件移除这些属性。
 */
function stripCrossorigin(): Plugin {
  return {
    name: 'strip-crossorigin-for-file',
    enforce: 'post',
    apply: 'build',
    transformIndexHtml(html) {
      return html
        .replace(/ crossorigin=""/g, '')
        .replace(/ crossorigin/g, '')
    },
  }
}

// WeekLog renderer build：主窗口（index）+ 快速记笔记（quicknote）两个入口。
// 输出到 src/renderer/dist，由 electron loadFile 加载（base 用相对路径）。
//
// 双外壳支持：设置环境变量 WEEKLOG_TAURI=1 时，把 @/lib/api 别名指向 Tauri 版
// 桥接（api.tauri.ts）并注入 __TAURI__，使同一份渲染层源码服务 Tauri 2 外壳。
// 不设置时维持 Electron 行为（window.weeklog）。两种构建互不污染。
const isTauri = process.env.WEEKLOG_TAURI === '1'

export default defineConfig(({ mode }) => {
  return {
    plugins: [react(), tailwindcss(), ...(isTauri ? [] : [stripCrossorigin()])],
    base: './',
    root: resolve(__dirname, 'src/renderer'),
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src/renderer/src'),
      },
    },
    define: {
      __DEV__: JSON.stringify(mode === 'development'),
      __APP_VERSION__: JSON.stringify(appVersion),
      ...(isTauri ? { __TAURI__: 'true' } : {}),
    },
    build: {
      outDir: 'dist',
      emptyOutDir: true,
      assetsDir: 'assets',
      sourcemap: false,
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          quicknote: resolve(__dirname, 'src/renderer/quicknote.html'),
        },
      },
    },
    server: {
      // Tauri 构建用 1430（避开本机保留端口区间 5096-5195，也避开易留 TimeWait 的 1420）；
      // Electron 构建保持 5173。strictPort 确保端口被占时直接报错而非静默换端口。
      port: isTauri ? 1430 : 5173,
      strictPort: true,
    },
  }
})
