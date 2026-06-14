import { useState, useEffect, useCallback, createContext, useContext, useRef } from 'react'
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
  const initialized = useRef(false)

  const refresh = useCallback(async () => {
    try {
      const list = await api.tasks.list()
      setTasks(list)
    } catch {
      // 静默
    }
  }, [])

  // 首次挂载：拉取全部 + 订阅更新
  useEffect(() => {
    if (initialized.current) return
    initialized.current = true
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
