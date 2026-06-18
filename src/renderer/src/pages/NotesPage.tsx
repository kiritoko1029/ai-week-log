import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { Plus, Pencil, RefreshCw, Loader2, Lightbulb, Trash2, WandSparkles, CheckCheck, Inbox, GitBranch, Clock3, FolderGit2, Files, ChevronDown, ChevronUp } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { useConfig } from '@/hooks/useConfig'
import { todayISO, daysAgoISO, fmtDateNoZero } from '@/lib/dates'
import { cn, codeSurface } from '@/lib/utils'
import { NoteCard } from '@/components/NoteCard'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Textarea } from '@/components/ui/textarea'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { ProjectSelect } from '@/components/ProjectSelect'
import type { Note, MemoryInferResult, CodexPendingNote } from '@/types/weeklog'

type Filter = 'all' | 'project' | 'misc'

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

export function NotesPage() {
  const { config } = useConfig()
  const miscProject = config?.notes.miscProject || '日常工作'

  const [notes, setNotes] = useState<Note[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<Filter>('all')
  const [from, setFrom] = useState(daysAgoISO(13))
  const [to, setTo] = useState(todayISO())

  // 快速添加
  const [noteText, setNoteText] = useState('')
  const [noteProject, setNoteProject] = useState('')
  const [noteDate, setNoteDate] = useState(todayISO())

  // 编辑器弹窗
  const [editorOpen, setEditorOpen] = useState(false)
  const [editorDate, setEditorDate] = useState(todayISO())
  const [editorText, setEditorText] = useState('')

  // 原始预览
  const [rawText, setRawText] = useState('')
  const [rawDate, setRawDate] = useState(todayISO())

  // Codex hook 待处理小记池
  const [pendingNotes, setPendingNotes] = useState<CodexPendingNote[]>([])
  const [selectedPendingIds, setSelectedPendingIds] = useState<string[]>([])
  const [loadingPendingNotes, setLoadingPendingNotes] = useState(true)
  const [pendingBusy, setPendingBusy] = useState(false)
  const [pendingSummaryDraft, setPendingSummaryDraft] = useState('')
  const [pendingSummaryUsageText, setPendingSummaryUsageText] = useState('')
  const [expandedPendingNoteIds, setExpandedPendingNoteIds] = useState<string[]>([])

  // AI 记忆推断（写笔记时辅助）
  const [inferResult, setInferResult] = useState<MemoryInferResult | null>(null)
  const [inferring, setInferring] = useState(false)
  const inferTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const loadNotes = useCallback(async () => {
    setLoading(true)
    try {
      const list = await api.notes.list({ from, to })
      setNotes(list)
    } catch (e) {
      toast.error('加载笔记失败', { description: (e as Error).message })
    } finally {
      setLoading(false)
    }
  }, [from, to])

  const loadPendingNotes = useCallback(async () => {
    setLoadingPendingNotes(true)
    try {
      const list = await api.codexNotes.list()
      setPendingNotes(list)
      setSelectedPendingIds((prev) => prev.filter((id) => list.some((item) => item.id === id)))
      setExpandedPendingNoteIds((prev) => prev.filter((id) => list.some((item) => item.id === id)))
    } catch (e) {
      toast.error('加载待处理小记失败', { description: (e as Error).message })
    } finally {
      setLoadingPendingNotes(false)
    }
  }, [])

  useEffect(() => {
    loadNotes()
  }, [loadNotes])

  useEffect(() => {
    loadPendingNotes()
  }, [loadPendingNotes])

  // AI 记忆推断：用户输入笔记时（debounce 800ms），调记忆推断项目
  useEffect(() => {
    if (inferTimer.current) clearTimeout(inferTimer.current)
    const text = noteText.trim()
    // 记忆未启用或输入太短：清空提示
    if (!config?.memory?.enabled || text.length < 4) {
      setInferResult(null)
      return
    }
    inferTimer.current = setTimeout(async () => {
      setInferring(true)
      try {
        const r = await api.memory.inferProject(text)
        setInferResult(r)
      } catch {
        setInferResult(null)
      } finally {
        setInferring(false)
      }
    }, 800)
    return () => {
      if (inferTimer.current) clearTimeout(inferTimer.current)
    }
  }, [noteText, config?.memory?.enabled])

  const refreshRaw = useCallback(async (d: string) => {
    try {
      const text = await api.notes.getText(d)
      setRawText(text || '（当天无笔记）')
      setRawDate(d)
    } catch {
      setRawText('（读取失败）')
    }
  }, [])

  useEffect(() => {
    refreshRaw(noteDate)
  }, [noteDate, refreshRaw])

  const addNote = useCallback(async () => {
    const content = noteText.trim()
    if (!content) return
    try {
      await api.notes.add({ date: noteDate, project: noteProject, content })
      toast.success('笔记已添加')
      setNoteText('')
      await loadNotes()
      await refreshRaw(noteDate)
    } catch (e) {
      toast.error('添加失败', { description: (e as Error).message })
    }
  }, [noteText, noteProject, noteDate, loadNotes, refreshRaw])

  const openEditor = useCallback(async (d: string) => {
    setEditorDate(d)
    try {
      const text = await api.notes.getText(d)
      setEditorText(text || `## ${miscProject}\n`)
    } catch {
      setEditorText(`## ${miscProject}\n`)
    }
    setEditorOpen(true)
  }, [miscProject])

  const saveEditor = useCallback(async () => {
    try {
      await api.notes.saveText({ date: editorDate, text: editorText })
      toast.success('笔记已保存')
      setEditorOpen(false)
      await loadNotes()
      await refreshRaw(editorDate)
    } catch (e) {
      toast.error('保存失败', { description: (e as Error).message })
    }
  }, [editorDate, editorText, loadNotes, refreshRaw])

  const filtered = useMemo(
    () => notes.filter((n) => filter === 'all' || (filter === 'project' ? n.project : !n.project)),
    [notes, filter]
  )

  // 按日期分组（倒序）
  const byDay = useMemo(() => {
    const map = new Map<string, Note[]>()
    filtered.forEach((n) => {
      if (!map.has(n.date)) map.set(n.date, [])
      map.get(n.date)!.push(n)
    })
    return [...map.keys()].sort().reverse().map((date) => ({ date, items: map.get(date)! }))
  }, [filtered])

  const projects = config?.repos.map((r) => ({ value: r.name, label: r.alias || r.name })) ?? []
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
      const r = await api.codexNotes.delete(selectedPendingIds)
      toast.success(`已移除 ${r.deleted} 条待处理小记`)
      setSelectedPendingIds([])
      setExpandedPendingNoteIds((prev) => prev.filter((id) => !selectedPendingIds.includes(id)))
      setPendingSummaryDraft('')
      setPendingSummaryUsageText('')
      await loadPendingNotes()
    } catch (e) {
      toast.error('移除失败', { description: (e as Error).message })
    } finally {
      setPendingBusy(false)
    }
  }, [selectedPendingIds, loadPendingNotes])

  const writeSelectedPendingNotes = useCallback(async () => {
    if (!selectedPendingIds.length) return
    setPendingBusy(true)
    try {
      const r = await api.codexNotes.write({ ids: selectedPendingIds })
      toast.success(`已写入 ${r.written} 条小记`)
      setSelectedPendingIds([])
      setPendingSummaryDraft('')
      setPendingSummaryUsageText('')
      await Promise.all([loadPendingNotes(), loadNotes(), refreshRaw(todayISO())])
    } catch (e) {
      toast.error('写入失败', { description: (e as Error).message })
    } finally {
      setPendingBusy(false)
    }
  }, [selectedPendingIds, loadPendingNotes, loadNotes, refreshRaw])

  const summarizeSelectedPendingNotes = useCallback(async () => {
    if (!selectedPendingIds.length) return
    setPendingBusy(true)
    setPendingSummaryUsageText('')
    try {
      const r = await api.codexNotes.summarize(selectedPendingIds)
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
        setPendingSummaryUsageText(usageText)
        toast.success('AI 总结已生成，可编辑后写入', usageText ? { description: usageText } : undefined)
      }
    } catch (e) {
      toast.error('AI 总结失败', { description: (e as Error).message })
    } finally {
      setPendingBusy(false)
    }
  }, [selectedPendingIds, pendingNotes])

  const writePendingSummaryDraft = useCallback(async () => {
    const content = pendingSummaryDraft.trim()
    if (!selectedPendingIds.length || !content) return
    setPendingBusy(true)
    try {
      const first = pendingNotes.find((item) => selectedPendingIds.includes(item.id))
      const r = await api.codexNotes.write({
        ids: selectedPendingIds,
        project: first?.project || '',
        content,
      })
      toast.success(`已写入总结小记，处理 ${r.written} 条候选`)
      setSelectedPendingIds([])
      setPendingSummaryDraft('')
      setPendingSummaryUsageText('')
      await Promise.all([loadPendingNotes(), loadNotes(), refreshRaw(todayISO())])
    } catch (e) {
      toast.error('写入总结失败', { description: (e as Error).message })
    } finally {
      setPendingBusy(false)
    }
  }, [pendingSummaryDraft, selectedPendingIds, pendingNotes, loadPendingNotes, loadNotes, refreshRaw])

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">笔记管理</h2>
        <p className="text-sm text-muted-foreground">补充会议、沟通、设计、调研等非代码工作 · notes/YYYY-MM-DD.md</p>
      </div>

      {/* 快速添加 */}
      <Card>
        <CardContent className="pt-6">
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-[200px] flex-1 space-y-1.5">
              <Label>添加笔记</Label>
              <Input
                value={noteText}
                onChange={(e) => setNoteText(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && addNote()}
                placeholder="例如：参加架构评审，确认了订单服务拆分方案"
              />
            </div>
            <div className="min-w-[150px] space-y-1.5">
              <Label>项目</Label>
              <ProjectSelect
                value={noteProject}
                onChange={setNoteProject}
                options={projects}
              />
            </div>
            <div className="min-w-[140px] space-y-1.5">
              <Label>日期</Label>
              <Input type="date" value={noteDate} onChange={(e) => setNoteDate(e.target.value)} />
            </div>
            <Button onClick={addNote} className="bg-violet-600 text-white hover:bg-violet-600/90">
              <Plus />
              添加
            </Button>
            <Button variant="outline" onClick={() => openEditor(todayISO())}>
              <Pencil />
              编辑器打开
            </Button>
          </div>

          {/* AI 记忆推断提示 */}
          {(inferring || (inferResult && inferResult.project && inferResult.confidence > 0.3)) && (
            <div className="mt-3 flex flex-wrap items-center gap-3 rounded-md border border-amber-300/60 bg-amber-50/80 p-3 dark:border-amber-700/50 dark:bg-amber-950/30">
              <Lightbulb className="size-4 shrink-0 text-amber-600 dark:text-amber-400" />
              {inferring ? (
                <span className="text-sm text-muted-foreground">
                  <Loader2 className="mr-1 inline size-3 animate-spin" />
                  正在检索历史记忆，推断相关项目…
                </span>
              ) : inferResult && inferResult.project ? (
                <>
                  <span className="text-sm">
                    根据历史记忆，这可能与
                    <strong className="mx-1 text-amber-700 dark:text-amber-300">【{inferResult.project}】</strong>
                    相关（置信度 {Math.round((inferResult.confidence || 0) * 100)}%）
                    {inferResult.suggestedSummary && (
                      <span className="text-muted-foreground"> · {inferResult.suggestedSummary}</span>
                    )}
                  </span>
                  {!noteProject && (
                    <Button
                      size="sm"
                      variant="outline"
                      type="button"
                      onClick={() => {
                        if (inferResult.project) setNoteProject(inferResult.project)
                      }}
                    >
                      归入该项目
                    </Button>
                  )}
                </>
              ) : null}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Codex hook 待处理小记池 */}
      <Card>
        <CardHeader className="gap-3 md:flex-row md:items-center md:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <CardTitle>Codex Hook 待处理小记池</CardTitle>
              <Badge variant={pendingNotes.length ? 'secondary' : 'muted'} className="font-mono">{pendingNotes.length} 条</Badge>
              {selectedPendingCount > 0 && (
                <Badge variant="success" className="font-mono">已选择 {selectedPendingCount}</Badge>
              )}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">Codex 完成任务后先进入这里，确认后再写入正式笔记。</p>
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
              <div className="mt-1 text-xs text-muted-foreground">完成 Codex 任务后会出现在这里</div>
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
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" onClick={writePendingSummaryDraft} disabled={pendingBusy || !selectedPendingIds.length || !pendingSummaryDraft.trim()} className="bg-violet-600 text-white hover:bg-violet-600/90">
                  <Plus />
                  写入总结小记
                </Button>
                <Button size="sm" variant="outline" onClick={() => {
                  setPendingSummaryDraft('')
                  setPendingSummaryUsageText('')
                }} disabled={pendingBusy}>
                  清空草稿
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* 筛选 */}
      <div className="flex flex-wrap items-center gap-3">
        <ToggleGroup type="single" value={filter} onValueChange={(v) => v && setFilter(v as Filter)}>
          <ToggleGroupItem value="all">全部</ToggleGroupItem>
          <ToggleGroupItem value="project">项目笔记</ToggleGroupItem>
          <ToggleGroupItem value="misc">日常工作（通用）</ToggleGroupItem>
        </ToggleGroup>
        <div className="ml-auto flex items-center gap-2">
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-auto" />
          <span className="text-muted-foreground">~</span>
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-auto" />
          <Button variant="outline" size="sm" onClick={loadNotes}>
            <RefreshCw />
            刷新
          </Button>
        </div>
      </div>

      {/* 时间线 */}
      {loading ? (
        <div className="py-12 text-center text-sm text-muted-foreground">
          <Loader2 className="mx-auto mb-2 h-5 w-5 animate-spin" />
          加载中…
        </div>
      ) : byDay.length === 0 ? (
        <div className="py-12 text-center text-sm text-muted-foreground">该范围内暂无笔记</div>
      ) : (
        <div className="space-y-6">
          {byDay.map((day) => (
            <div key={day.date}>
              <div className="mb-3 flex items-baseline gap-3">
                <span className="font-mono text-sm font-semibold">
                  {fmtDateNoZero(day.date)}
                  {day.date === todayISO() && ' · 今天'}
                </span>
                <span className="font-mono text-xs text-muted-foreground">{day.items.length} 条</span>
              </div>
              <div className="space-y-2">
                {day.items.map((n, i) => (
                  <NoteCard key={i} note={n} miscProject={miscProject} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 原始格式预览 */}
      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle>笔记文件原始格式</CardTitle>
          <Badge variant="muted" className="font-mono">notes/{rawDate}.md</Badge>
        </CardHeader>
        <CardContent>
          <pre className={cn(codeSurface, 'overflow-x-auto p-4')}>
            {rawText}
          </pre>
          <p className="mt-3 text-xs text-muted-foreground">
            规则：<code className="rounded bg-muted px-1.5 py-0.5 font-mono">## 项目名</code> 下的内容归该项目桶；{' '}
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono">## 日常工作</code>（或顶部无标题）归当天通用笔记，注入所有桶 + 独立段落。
          </p>
        </CardContent>
      </Card>

      {/* 编辑器弹窗 */}
      <Dialog open={editorOpen} onOpenChange={setEditorOpen}>
        <DialogContent className="max-w-[640px]">
          <DialogHeader>
            <DialogTitle>编辑笔记 · notes/{editorDate}.md</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">
              用 <code className="rounded bg-muted px-1.5 py-0.5 font-mono">## 项目名</code> 分段；标题之上或{' '}
              <code className="rounded bg-muted px-1.5 py-0.5 font-mono">## 日常工作</code> 下为通用笔记。
            </p>
            <div className="space-y-1.5">
              <Label>日期</Label>
              <Input
                type="date"
                value={editorDate}
                onChange={async (e) => {
                  setEditorDate(e.target.value)
                  try {
                    const text = await api.notes.getText(e.target.value)
                    setEditorText(text || `## ${miscProject}\n`)
                  } catch {
                    setEditorText(`## ${miscProject}\n`)
                  }
                }}
                className="max-w-[200px]"
              />
            </div>
            <Textarea
              value={editorText}
              onChange={(e) => setEditorText(e.target.value)}
              className="min-h-[260px] font-mono text-sm"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditorOpen(false)}>取消</Button>
            <Button onClick={saveEditor} className="bg-violet-600 text-white hover:bg-violet-600/90">保存</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
