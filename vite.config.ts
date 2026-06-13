import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'node:path'

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
export default defineConfig(({ mode }) => {
  return {
    plugins: [react(), tailwindcss(), stripCrossorigin()],
    base: './',
    root: resolve(__dirname, 'src/renderer'),
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src/renderer/src'),
      },
    },
    define: {
      __DEV__: JSON.stringify(mode === 'development'),
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
      port: 5173,
      strictPort: true,
    },
  }
})
