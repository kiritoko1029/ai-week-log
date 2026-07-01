import { useState, useEffect, useCallback, useMemo } from 'react'
import { RefreshCw, Loader2, Trash2, WandSparkles, CheckCheck, Inbox, GitBranch, Clock3, FolderGit2, Files, ChevronDown, ChevronUp, Plus, Bot } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { useMemoryProjectInference } from '@/hooks/useMemoryProjectInference'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { ProjectSelect, type ProjectOption } from '@/components/ProjectSelect'
import { MemoryProjectHint } from '@/components/MemoryProjectHint'
import type { AiPendingNote } from '@/types/weeklog'

/** 统一池中的一条待处理小记（含 source，前端按来源显示徽标） */
type PendingItem = AiPendingNote

interface PendingPoolApi {
  list: () => Promise<PendingItem[]>
  delete: (ids: string[]) => Promise<{ deleted: number }>
  write: (q: { ids: string[]; project?: string; content?: string }) => Promise<{ written: number; files: string[] }>
  summarize: (ids: string[]) => Promise<{ text?: string; model?: string; error?: string; inputTokens?: number; outputTokens?: number }>
}

/** 来源 agent → 展示名（与后端 source_label 对齐） */
const SOURCE_LABELS: Record<string, string> = {
  codex: 'Codex',
  claude: 'Claude Code',
  zcode: 'ZCode',
}

function sourceLabel(source: string) {
  return SOURCE_LABELS[source] || source || 'AI'
}

function formatPendingNoteTime(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value || '未知时间'
  return date.toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

function summarizeChangedFiles(files: string[]) {
  if (!files.length) return '无文件变更记录'
  const shown = files.slice(0, 3).join(' · ')
  return files.length > 3 ? `${shown} · 等 ${files.length} 个文件` : shown
}

function formatTokenK(value?: number) {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0
  return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`
}

interface PendingNotePoolProps {
  title: string
  sourceName: string // 'Codex' / 'ZCode'
  miscProject: string
  api: PendingPoolApi
  projects?: ProjectOption[]
  memoryEnabled?: boolean
  /** 写入正式笔记后回调（用于刷新时间线/原始视图） */
  onWritten?: () => void
  /** 暴露刷新方法给外部（可选） */
  registerRefresh?: (fn: () => void) => void
}

export function PendingNotePool({ title, sourceName, miscProject, api, projects = [], memoryEnabled = false, onWritten, registerRefresh }: PendingNotePoolProps) {
  const [pendingNotes, setPendingNotes] = useState<PendingItem[]>([])
  const [selectedPendingIds, setSelectedPendingIds] = useState<string[]>([])
  const [loadingPendingNotes, setLoadingPendingNotes] = useState(true)
  const [pendingBusy, setPendingBusy] = useState(false)
  const [pendingSummaryDraft, setPendingSummaryDraft] = useState('')
  const [pendingSummaryProject, setPendingSummaryProject] = useState('')
  const [pendingSummaryUsageText, setPendingSummaryUsageText] = useState('')
  const [expandedPendingNoteIds, setExpandedPendingNoteIds] = useState<string[]>([])
  const memoryInfer = useMemoryProjectInference({
    text: pendingSummaryDraft,
    memoryEnabled,
  })

  const loadPendingNotes = useCallback(async () => {
    setLoadingPendingNotes(true)
    try {
      const list = await api.list()
      setPendingNotes(list)
      setSelectedPendingIds((prev) => prev.filter((id) => list.some((item) => item.id === id)))
      setExpandedPendingNoteIds((prev) => prev.filter((id) => list.some((item) => item.id === id)))
    } catch (e) {
      toast.error('加载待处理小记失败', { description: (e as Error).message })
    } finally {
      setLoadingPendingNotes(false)
    }
  }, [api])

  useEffect(() => {
    loadPendingNotes()
  }, [loadPendingNotes])

  useEffect(() => {
    if (registerRefresh) registerRefresh(loadPendingNotes)
  }, [registerRefresh, loadPendingNotes])

  const selectedPendingSet = useMemo(() => new Set(selectedPendingIds), [selectedPendingIds])
  const allPendingSelected = pendingNotes.length > 0 && selectedPendingIds.length === pendingNotes.length
  const selectedPendingCount = selectedPendingIds.length

  const togglePendingNote = useCallback((id: string) => {
    setSelectedPendingIds((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id])
  }, [])

  const toggleAllPendingNotes = useCallback(() => {
    setSelectedPendingIds((prev) => prev.length === pendingNotes.length ? [] : pendingNotes.map((item) => item.id))
  }, [pendingNotes])

  const togglePendingNoteSummary = useCallback((id: string) => {
    setExpandedPendingNoteIds((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id])
  }, [])

  const deleteSelectedPendingNotes = useCallback(async () => {
    if (!selectedPendingIds.length) return
    setPendingBusy(true)
    try {
      const r = await api.delete(selectedPendingIds)
      toast.success(`已移除 ${r.deleted} 条待处理小记`)
      setSelectedPendingIds([])
      setExpandedPendingNoteIds((prev) => prev.filter((id) => !selectedPendingIds.includes(id)))
      setPendingSummaryDraft('')
      setPendingSummaryProject('')
      setPendingSummaryUsageText('')
      await loadPendingNotes()
    } catch (e) {
      toast.error('移除失败', { description: (e as Error).message })
    } finally {
      setPendingBusy(false)
    }
  }, [selectedPendingIds, loadPendingNotes, api])

  const writeSelectedPendingNotes = useCallback(async () => {
    if (!selectedPendingIds.length) return
    setPendingBusy(true)
    try {
      const r = await api.write({ ids: selectedPendingIds })
      toast.success(`已写入 ${r.written} 条小记`)
      setSelectedPendingIds([])
      setPendingSummaryDraft('')
      setPendingSummaryProject('')
      setPendingSummaryUsageText('')
      await loadPendingNotes()
      onWritten?.()
    } catch (e) {
      toast.error('写入失败', { description: (e as Error).message })
    } finally {
      setPendingBusy(false)
    }
  }, [selectedPendingIds, loadPendingNotes, api, onWritten])

  const summarizeSelectedPendingNotes = useCallback(async () => {
    if (!selectedPendingIds.length) return
    setPendingBusy(true)
    setPendingSummaryUsageText('')
    try {
      const r = await api.summarize(selectedPendingIds)
      if (r.error) {
        toast.error('AI 总结失败', { description: r.error })
        return
      }
      if (r.text) {
        const usageText =
          r.inputTokens !== undefined || r.outputTokens !== undefined
            ? `输入 ${formatTokenK(r.inputTokens)} / 输出 ${formatTokenK(r.outputTokens)} token`
            : ''
        setPendingSummaryDraft(r.text)
        const first = pendingNotes.find((item) => selectedPendingIds.includes(item.id))
        setPendingSummaryProject(first?.project || '')
        setPendingSummaryUsageText(usageText)
        toast.success('AI 总结已生成，可编辑后写入', usageText ? { description: usageText } : undefined)
      }
    } catch (e) {
      toast.error('AI 总结失败', { description: (e as Error).message })
    } finally {
      setPendingBusy(false)
    }
  }, [selectedPendingIds, api])

  const writePendingSummaryDraft = useCallback(async () => {
    const content = pendingSummaryDraft.trim()
    if (!selectedPendingIds.length || !content) return
    setPendingBusy(true)
    try {
      const first = pendingNotes.find((item) => selectedPendingIds.includes(item.id))
      const r = await api.write({
        ids: selectedPendingIds,
        project: pendingSummaryProject || first?.project || '',
        content,
      })
      toast.success(`已写入总结小记，处理 ${r.written} 条候选`)
      setSelectedPendingIds([])
      setPendingSummaryDraft('')
      setPendingSummaryProject('')
      setPendingSummaryUsageText('')
      await loadPendingNotes()
      onWritten?.()
    } catch (e) {
      toast.error('写入总结失败', { description: (e as Error).message })
    } finally {
      setPendingBusy(false)
    }
  }, [pendingSummaryDraft, pendingSummaryProject, selectedPendingIds, pendingNotes, loadPendingNotes, api, onWritten])

  return (
    <Card>
      <CardHeader className="gap-3 md:flex-row md:items-center md:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle>{title}</CardTitle>
            <Badge variant={pendingNotes.length ? 'secondary' : 'muted'} className="font-mono">{pendingNotes.length} 条</Badge>
            {selectedPendingCount > 0 && (
              <Badge variant="success" className="font-mono">已选择 {selectedPendingCount}</Badge>
            )}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">{sourceName} 完成任务后先进入这里，确认后再写入正式笔记。</p>
        </div>
        {pendingNotes.length > 0 && (
          <div className="text-xs text-muted-foreground">
            {selectedPendingCount > 0 ? '可批量写入、总结或移除' : '先勾选需要处理的小记'}
          </div>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/30 p-2">
          <Button variant="outline" size="sm" onClick={toggleAllPendingNotes} disabled={!pendingNotes.length || pendingBusy}>
            <CheckCheck />
            {allPendingSelected ? '取消全选' : '全选'}
          </Button>
          <Button variant="outline" size="sm" onClick={summarizeSelectedPendingNotes} disabled={!selectedPendingIds.length || pendingBusy}>
            {pendingBusy ? <Loader2 className="animate-spin" /> : <WandSparkles />}
            AI 总结
          </Button>
          <Button size="sm" onClick={writeSelectedPendingNotes} disabled={!selectedPendingIds.length || pendingBusy} className="bg-violet-600 text-white hover:bg-violet-600/90">
            <Plus />
            写入小记
          </Button>
          <Button variant="outline" size="sm" onClick={deleteSelectedPendingNotes} disabled={!selectedPendingIds.length || pendingBusy}>
            <Trash2 />
            移除
          </Button>
          <Button variant="ghost" size="sm" onClick={loadPendingNotes} disabled={loadingPendingNotes || pendingBusy}>
            <RefreshCw className={loadingPendingNotes ? 'animate-spin' : ''} />
            刷新
          </Button>
        </div>

        {loadingPendingNotes ? (
          <div className="py-6 text-center text-sm text-muted-foreground">
            <Loader2 className="mx-auto mb-2 size-4 animate-spin" />
            加载待处理小记…
          </div>
        ) : pendingNotes.length === 0 ? (
          <div className="rounded-md border border-dashed bg-muted/20 p-8 text-center">
            <Inbox className="mx-auto mb-3 size-8 text-muted-foreground/60" />
            <div className="text-sm font-medium">暂无待处理小记</div>
            <div className="mt-1 text-xs text-muted-foreground">完成 {sourceName} 任务后会出现在这里</div>
          </div>
        ) : (
          <div className="space-y-2">
            {pendingNotes.map((item) => {
              const summaryExpanded = expandedPendingNoteIds.includes(item.id)
              return (
                <div
                  key={item.id}
                  className={cn(
                    'group flex gap-3 rounded-md border bg-card p-3 transition-colors hover:border-violet-300 hover:bg-muted/30',
                    selectedPendingSet.has(item.id) && 'border-violet-400 bg-violet-50/70 shadow-sm dark:bg-violet-950/20'
                  )}
                >
                  <input
                    type="checkbox"
                    checked={selectedPendingSet.has(item.id)}
                    onChange={() => togglePendingNote(item.id)}
                    className="mt-1 size-4 shrink-0 accent-violet-600"
                  />
                  <div className="min-w-0 flex-1 space-y-3">
                    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <Badge variant="outline" className="gap-1">
                        <Bot className="size-3" />
                        {sourceLabel(item.source)}
                      </Badge>
                      <Badge variant="secondary" className="gap-1">
                        <FolderGit2 className="size-3" />
                        {item.project || miscProject}
                      </Badge>
                      {item.branch && (
                        <Badge variant="outline" className="max-w-[220px] gap-1 truncate font-mono">
                          <GitBranch className="size-3 shrink-0" />
                          <span className="truncate">{item.branch}</span>
                        </Badge>
                      )}
                      <span className="inline-flex items-center gap-1 font-mono">
                        <Clock3 className="size-3" />
                        {formatPendingNoteTime(item.createdAt)}
                      </span>
                    </div>
                    <div className="pending-note-summary rounded-md bg-background/80 p-3 ring-1 ring-border/70">
                      <div className="mb-1 flex items-center justify-between gap-2">
                        <span className="text-xs font-medium text-muted-foreground">任务摘要</span>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          aria-expanded={summaryExpanded}
                          onClick={(e) => {
                            e.preventDefault()
                            togglePendingNoteSummary(item.id)
                          }}
                          className="h-7 px-2 text-xs"
                        >
                          {summaryExpanded ? <ChevronUp /> : <ChevronDown />}
                          {summaryExpanded ? '收起全文' : '展开全文'}
                        </Button>
                      </div>
                      <p className={cn('whitespace-pre-wrap break-words text-sm leading-6 text-foreground', !summaryExpanded && 'line-clamp-3')}>
                        {item.summary}
                      </p>
                    </div>
                    <div className="flex min-w-0 items-start gap-2 rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                      <Files className="mt-0.5 size-3.5 shrink-0" />
                      <div className="min-w-0">
                        <div className="mb-0.5 font-medium text-foreground/70">变更文件</div>
                        <div className="truncate font-mono">{summarizeChangedFiles(item.changedFiles)}</div>
                      </div>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {pendingSummaryDraft && (
          <div className="space-y-2 rounded-md border border-violet-300/70 bg-violet-50/60 p-3 dark:border-violet-800/70 dark:bg-violet-950/20">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Label>AI 总结草稿</Label>
              {pendingSummaryUsageText && (
                <Badge variant="secondary" className="font-mono">
                  {pendingSummaryUsageText}
                </Badge>
              )}
            </div>
            <Textarea
              value={pendingSummaryDraft}
              onChange={(e) => setPendingSummaryDraft(e.target.value)}
              className="min-h-[96px]"
            />
            <div className="flex flex-wrap items-end gap-2">
              <div className="min-w-[180px] space-y-1">
                <Label className="text-xs">写入项目</Label>
                <ProjectSelect
                  value={pendingSummaryProject}
                  onChange={setPendingSummaryProject}
                  options={projects}
                  miscLabel={miscProject}
                />
              </div>
              <Button size="sm" onClick={writePendingSummaryDraft} disabled={pendingBusy || !selectedPendingIds.length || !pendingSummaryDraft.trim()} className="bg-violet-600 text-white hover:bg-violet-600/90">
                <Plus />
                写入总结小记
              </Button>
              <Button size="sm" variant="outline" onClick={() => {
                setPendingSummaryDraft('')
                setPendingSummaryProject('')
                setPendingSummaryUsageText('')
              }} disabled={pendingBusy}>
                清空草稿
              </Button>
            </div>
            <MemoryProjectHint
              inferring={memoryInfer.inferring}
              result={memoryInfer.result}
              currentProject={pendingSummaryProject}
              onApply={setPendingSummaryProject}
            />
          </div>
        )}
      </CardContent>
    </Card>
  )
}
