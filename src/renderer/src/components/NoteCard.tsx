import { CheckCircle2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { Note } from '@/types/weeklog'

/** 单条笔记卡片：项目级笔记（蓝色边）vs 通用笔记（紫色边） */
export function NoteCard({ note, miscProject }: { note: Note; miscProject: string }) {
  const isProject = !!note.project
  return (
    <div
      className={cn(
        'flex gap-3 rounded-md border bg-card p-4 shadow-xs transition-colors',
        isProject ? 'border-l-4 border-l-blue-500' : 'border-l-4 border-l-violet-500'
      )}
    >
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
