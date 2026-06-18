import { CheckCircle2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { Note } from '@/types/weeklog'

/** 单条笔记卡片：项目级笔记（蓝色边）vs 通用笔记（紫色边）
 * 时间线场景下支持多选精简：selected + onToggle 启用复选框与选中高亮。 */
export function NoteCard({
  note,
  miscProject,
  selected,
  onToggle,
}: {
  note: Note
  miscProject: string
  /** 多选精简模式下的选中态（时间线用） */
  selected?: boolean
  /** 点击卡片/复选框的切换回调；传入则进入可选模式 */
  onToggle?: () => void
}) {
  const isProject = !!note.project
  const selectable = typeof onToggle === 'function'
  return (
    <div
      className={cn(
        'flex gap-3 rounded-md border bg-card p-4 shadow-xs transition-colors',
        isProject ? 'border-l-4 border-l-blue-500' : 'border-l-4 border-l-violet-500',
        selectable && 'cursor-pointer hover:border-violet-300 hover:bg-muted/30',
        selected && 'border-violet-400 bg-violet-50/70 shadow-sm dark:bg-violet-950/20'
      )}
      onClick={selectable ? onToggle : undefined}
    >
      {selectable && (
        <input
          type="checkbox"
          checked={!!selected}
          onChange={onToggle}
          onClick={(e) => e.stopPropagation()}
          className="mt-1 size-4 shrink-0 accent-violet-600"
        />
      )}
      <div
        className={cn(
          'flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md',
          isProject ? 'bg-blue-500/10 text-blue-500' : 'bg-violet-500/10 text-violet-500'
        )}
      >
        <CheckCircle2 className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex items-center gap-1.5">
          <span
            className={cn(
              'rounded-full bg-muted px-2 py-px text-xs font-medium',
              !isProject && 'bg-violet-500/10 text-violet-600 dark:text-violet-400'
            )}
          >
            {note.project || miscProject}
          </span>
        </div>
        <div className="text-sm leading-relaxed text-foreground/80">{note.content}</div>
      </div>
    </div>
  )
}
