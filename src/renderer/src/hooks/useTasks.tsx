import { useState, useEffect, useCallback, createContext, useContext } from 'react'
import { api } from '@/lib/api'
import type { BackgroundTask, TaskUpdatePayload } from '@/types/weeklog'

/**
 * 全局后台任务状态。
 * - 任务在主进程维护，跨页面持久（切换页面不丢失）
 * - 通过 IPC 实时推送增量更新
 * - 任何组件都能 useTasks() 拿到当前任务列表
 */

interface TasksCtx {
  tasks: BackgroundTask[]
  running: BackgroundTask[]
  refresh: () => Promise<void>
  remove: (id: string) => Promise<void>
  clearFinished: () => Promise<void>
}

const Ctx = createContext<TasksCtx | null>(null)

export function TasksProvider({ children }: { children: React.ReactNode }) {
  const [tasks, setTasks] = useState<BackgroundTask[]>([])

  const refresh = useCallback(async () => {
    try {
      const list = await api.tasks.list()
      setTasks(list)
    } catch {
      // 静默
    }
  }, [])

  // 挂载：拉取全部 + 订阅更新。
  // 注意：不要加 initialized ref 守卫——StrictMode 下「卸载→重挂载」会先 off() 退订，
  // 守卫又会阻止重挂载时重新订阅，导致订阅被自己拆掉、再也收不到 task:update。
  // 裸订阅本身幂等且 StrictMode 安全（卸载退订、重挂载重订），多跑一次 refresh 无害。
  useEffect(() => {
    refresh()
    const off = api.tasks.onUpdate((payload: TaskUpdatePayload) => {
      if (payload.type === 'update' && payload.task) {
        const updated = payload.task
        setTasks((prev) => {
          const idx = prev.findIndex((t) => t.id === updated.id)
          if (idx >= 0) {
            const next = [...prev]
            next[idx] = updated
            return next
          }
          return [updated, ...prev]
        })
      } else if (payload.type === 'remove' && payload.id) {
        setTasks((prev) => prev.filter((t) => t.id !== payload.id))
      } else if (payload.type === 'clear') {
        setTasks((prev) => prev.filter((t) => t.status === 'running'))
      }
    })
    return off
  }, [refresh])

  const remove = useCallback(async (id: string) => {
    await api.tasks.remove(id)
    setTasks((prev) => prev.filter((t) => t.id !== id))
  }, [])

  const clearFinished = useCallback(async () => {
    await api.tasks.clearFinished()
    setTasks((prev) => prev.filter((t) => t.status === 'running'))
  }, [])

  const running = tasks.filter((t) => t.status === 'running')

  return (
    <Ctx.Provider value={{ tasks, running, refresh, remove, clearFinished }}>
      {children}
    </Ctx.Provider>
  )
}

export function useTasks() {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useTasks must be used within TasksProvider')
  return ctx
}
