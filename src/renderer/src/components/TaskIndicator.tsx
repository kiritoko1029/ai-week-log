import { useState, useRef, useEffect } from 'react'
import { Activity, Loader2, CheckCircle2, XCircle, X, Trash2 } from 'lucide-react'
import { useTasks } from '@/hooks/useTasks'
import { cn } from '@/lib/utils'
import type { BackgroundTask } from '@/types/weeklog'

const KIND_ICON: Record<string, string> = {
  generate: '📝',
  memory: '🧠',
  model_dl: '📦',
  webdav: '☁️',
  custom: '⚙️',
}

/** 格式化相对时间 */
function relTime(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60000) return `${Math.floor(diff / 1000)}秒前`
  if (diff < 3600000) return `${Math.floor(diff / 60000)}分钟前`
  return `${Math.floor(diff / 3600000)}小时前`
}

export function TaskIndicator() {
  const { tasks, running, clearFinished, remove } = useTasks()
  const [open, setOpen] = useState(false)
  const popRef = useRef<HTMLDivElement>(null)

  // 点击外部关闭
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (popRef.current && !popRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const hasRunning = running.length > 0

  return (
    <div className="relative" ref={popRef}>
      <button
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'flex items-center gap-1 rounded px-1.5 py-0.5 transition-colors',
          hasRunning ? 'text-primary hover:bg-primary/10' : 'hover:bg-muted'
        )}
        title={hasRunning ? `${running.length} 个后台任务进行中` : '后台任务'}
      >
        {hasRunning ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Activity className="h-3.5 w-3.5" />
        )}
        <span>
          {hasRunning ? `任务 ${running.length}` : '任务'}
        </span>
      </button>

      {open && (
        <div className="absolute bottom-full right-0 mb-2 z-50 w-[360px] rounded-lg border bg-popover p-0 shadow-lg">
          <div className="flex items-center justify-between border-b px-3 py-2">
            <span className="text-sm font-semibold">后台任务</span>
            <div className="flex items-center gap-1">
              {tasks.some((t) => t.status !== 'running') && (
                <button
                  onClick={() => clearFinished()}
                  className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                  title="清除已完成"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              )}
              <button
                onClick={() => setOpen(false)}
                className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
          <div className="max-h-[320px] overflow-y-auto">
            {tasks.length === 0 ? (
              <div className="py-8 text-center text-sm text-muted-foreground">暂无任务</div>
            ) : (
              tasks.map((task) => (
                <TaskRow key={task.id} task={task} onRemove={remove} />
              ))
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function TaskRow({ task, onRemove }: { task: BackgroundTask; onRemove: (id: string) => void }) {
  const pct = task.progress && task.progress.total > 0
    ? Math.min(100, Math.round((task.progress.done / task.progress.total) * 100))
    : 0
  const isRunning = task.status === 'running'
  const isError = task.status === 'error'

  return (
    <div className="border-b px-3 py-2 last:border-b-0 hover:bg-muted/40">
      <div className="flex items-start gap-2">
        <span className="mt-0.5 shrink-0 text-sm">{KIND_ICON[task.kind] || '⚙️'}</span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-sm font-medium">{task.title}</span>
            {isRunning && <Loader2 className="h-3 w-3 shrink-0 animate-spin text-primary" />}
            {task.status === 'done' && <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-500" />}
            {isError && <XCircle className="h-3.5 w-3.5 shrink-0 text-red-500" />}
          </div>
          {task.detail && (
            <p className="truncate text-xs text-muted-foreground">{task.detail}</p>
          )}
          {/* 进度条 */}
          {isRunning && task.progress && task.progress.total > 0 && (
            <div className="mt-1">
              <div className="h-1 w-full overflow-hidden rounded bg-muted">
                <div
                  className="h-full bg-primary transition-all duration-300"
                  style={{ width: `${pct}%` }}
                />
              </div>
              <span className="font-mono text-[10px] text-muted-foreground">
                {task.progress.done}/{task.progress.total}
                {task.progress.label && ` · ${task.progress.label}`}
              </span>
            </div>
          )}
          {/* 模型下载进度（total 可能 0 但 label 有百分比） */}
          {isRunning && task.progress && task.progress.total === 100 && (
            <div className="mt-1">
              <div className="h-1 w-full overflow-hidden rounded bg-muted">
                <div
                  className="h-full bg-primary transition-all duration-300"
                  style={{ width: `${task.progress.done}%` }}
                />
              </div>
              <span className="font-mono text-[10px] text-muted-foreground">
                {task.progress.done}%{task.progress.label && ` · ${task.progress.label}`}
              </span>
            </div>
          )}
          {isError && task.error && (
            <p className="mt-0.5 truncate text-xs text-red-500">{task.error}</p>
          )}
          {!isRunning && (
            <span className="font-mono text-[10px] text-muted-foreground">{relTime(task.updatedAt)}</span>
          )}
        </div>
        {!isRunning && (
          <button
            onClick={() => onRemove(task.id)}
            className="shrink-0 rounded p-0.5 text-muted-foreground/50 hover:bg-muted hover:text-foreground"
          >
            <X className="h-3 w-3" />
          </button>
        )}
      </div>
    </div>
  )
}
