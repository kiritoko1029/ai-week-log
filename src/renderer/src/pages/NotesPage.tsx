import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { Plus, Pencil, RefreshCw, Loader2, Lightbulb } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { useConfig } from '@/hooks/useConfig'
import { todayISO, daysAgoISO, fmtDateNoZero } from '@/lib/dates'
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
import type { Note, MemoryInferResult } from '@/types/weeklog'

type Filter = 'all' | 'project' | 'misc'

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

  useEffect(() => {
    loadNotes()
  }, [loadNotes])

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
            <Button onClick={addNote} className="bg-violet-600 hover:bg-violet-600/90">
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
          <pre className="overflow-x-auto rounded-md border bg-zinc-950 p-4 font-mono text-xs leading-relaxed text-slate-200">
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
            <Button onClick={saveEditor} className="bg-violet-600 hover:bg-violet-600/90">保存</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
