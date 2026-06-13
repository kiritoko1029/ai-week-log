import type { WeeklogAPI } from '@/types/weeklog'

/**
 * 渲染层访问主进程能力的统一入口。
 * window.weeklog 由 preload (contextBridge) 注入；这里只做类型收口。
 */
export const api: WeeklogAPI = window.weeklog
