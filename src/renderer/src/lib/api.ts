import type { WeeklogAPI } from '@/types/weeklog'
import { api as tauriApi } from '@/lib/api.tauri'

/**
 * 渲染层访问主进程能力的统一入口。
 *
 * 运行时自动选择后端：
 *  - Electron：window.weeklog 由 preload (contextBridge) 注入。
 *  - Tauri 2：由 lib/api.tauri.ts 用 invoke()/listen() 实现。
 *
 * 通过检测 window.weeklog 是否存在来切换（Tauri 环境下 preload 不注入，
 * window.weeklog 为 undefined）。这比构建期 alias 更可靠，不依赖 Vite
 * 别名匹配行为。未用到的 tauriApi 分支会被 Electron 构建保留但不执行。
 */
export const api: WeeklogAPI =
  typeof window !== 'undefined' && typeof window.weeklog !== 'undefined'
    ? window.weeklog
    : tauriApi
