import { Loader2, Lightbulb } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { MemoryInferResult } from '@/types/weeklog'

export function MemoryProjectHint({
  inferring,
  result,
  currentProject,
  onApply,
  compact = false,
}: {
  inferring: boolean
  result: MemoryInferResult | null
  currentProject: string
  onApply: (project: string) => void
  compact?: boolean
}) {
  const shouldShow = inferring || !!(result?.project && (result.confidence || 0) > 0.3)
  if (!shouldShow) return null
  const canApply = !!result?.project && result.project !== currentProject
  const applyLabel = currentProject ? '改为该项目' : '归入该项目'

  if (compact) {
    if (inferring) {
      return (
        <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
          <Loader2 className="size-3 animate-spin" />
          记忆检索中
        </span>
      )
    }
    if (!result?.project) return null
    return !canApply ? (
      <span className="truncate text-[11px] text-muted-foreground">记忆匹配：{result.project}</span>
    ) : (
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => onApply(result.project)}
        className="h-7 max-w-[150px] px-2 text-xs"
      >
        <Lightbulb className="size-3.5" />
        <span className="truncate">归入 {result.project}</span>
      </Button>
    )
  }

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-md border border-amber-300/60 bg-amber-50/80 p-3 dark:border-amber-700/50 dark:bg-amber-950/30">
      <Lightbulb className="size-4 shrink-0 text-amber-600 dark:text-amber-400" />
      {inferring ? (
        <span className="text-sm text-muted-foreground">
          <Loader2 className="mr-1 inline size-3 animate-spin" />
          正在检索历史记忆，推断相关项目…
        </span>
      ) : result?.project ? (
        <>
          <span className="text-sm">
            根据历史记忆，这可能与
            <strong className="mx-1 text-amber-700 dark:text-amber-300">【{result.project}】</strong>
            相关（置信度 {Math.round((result.confidence || 0) * 100)}%）
            {result.suggestedSummary && (
              <span className="text-muted-foreground"> · {result.suggestedSummary}</span>
            )}
          </span>
          {canApply && (
            <Button
              size="sm"
              variant="outline"
              type="button"
              onClick={() => onApply(result.project)}
            >
              {applyLabel}
            </Button>
          )}
        </>
      ) : null}
    </div>
  )
}
