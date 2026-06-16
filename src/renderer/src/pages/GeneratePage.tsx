import { useState, useCallback, useEffect } from 'react'
import { Play, Eye, Copy, Download, RefreshCw, Loader2, Pencil, Check } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { useConfig } from '@/hooks/useConfig'
import { useGenerate } from '@/hooks/useGenerate'
import { useExistingReport } from '@/hooks/useExistingReport'
import { todayISO } from '@/lib/dates'
import { ReportPreview } from '@/components/ReportPreview'
import { ExistingReportCard } from '@/components/ExistingReportCard'
import { StatCard } from '@/components/StatCard'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import type { GenerateRangeOpts } from '@/types/weeklog'

type Mode = 'weekly' | 'daily'
type RangePreset = 'thisweek' | 'lastweek' | 'custom'

export function GeneratePage() {
  const { config } = useConfig()
  const gen = useGenerate()

  const [mode, setMode] = useState<Mode>('weekly')
  const [preset, setPreset] = useState<RangePreset>('thisweek')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState(todayISO())
  const [dailyDate, setDailyDate] = useState('today')
  const [notesEnabled, setNotesEnabled] = useState(true)
  const [author, setAuthor] = useState('')
  const [merge, setMerge] = useState<'exclude' | 'include' | 'only'>('exclude')
  const [format, setFormat] = useState<'text' | 'md' | 'json'>('text')

  // 融合预览统计
  const [fusion, setFusion] = useState<{ commitCount: number; noteCount: number; noteProjectCount: number; noteMiscCount: number; desc: string } | null>(null)
  const [fusionLoading, setFusionLoading] = useState(false)

  // 报告编辑：editText 是用户可改的副本，随每次新生成的 report 重置
  const [editText, setEditText] = useState('')
  const [editing, setEditing] = useState(false)
  useEffect(() => {
    setEditText(gen.report)
  }, [gen.report])

  useEffect(() => {
    if (config) {
      setNotesEnabled(config.notes.enabled)
      setMerge(config.filters.mergeCommits)
      setFormat(config.output.format)
    }
  }, [config])

  const buildRange = useCallback((): GenerateRangeOpts => {
    if (mode === 'daily') return { mode: 'daily', date: dailyDate }
    if (preset === 'lastweek') return { week: 'last' }
    if (preset === 'custom') return { from, to }
    return {}
  }, [mode, preset, from, to, dailyDate])

  const buildOptions = useCallback(
    () => ({
      noNotes: !notesEnabled,
      format,
      author: author.trim(),
      merge,
      weekStart: config?.weekStart,
    }),
    [notesEnabled, format, author, merge, config]
  )

  // 当前选择范围（同日/同周）下的已有报告，用于展示「重新生成将覆盖」
  const reportType = mode === 'daily' ? '日报' : '周报'
  const { existing, loading } = useExistingReport(reportType, buildRange(), { weekStart: config?.weekStart })

  const refreshFusion = useCallback(async () => {
    setFusionLoading(true)
    try {
      const res = await api.collect({ rangeOpts: buildRange(), options: buildOptions() })
      const s = res.stats
      setFusion({
        commitCount: s.commitCount,
        noteCount: s.noteCount,
        noteProjectCount: s.noteProjectCount,
        noteMiscCount: s.noteMiscCount,
        desc: `${s.noteProjectCount} 项目级 + ${s.noteMiscCount} 通用（注入全部桶 + 日常工作段）`,
      })
    } catch (e) {
      toast.error('采集失败', { description: (e as Error).message })
    } finally {
      setFusionLoading(false)
    }
  }, [buildRange, buildOptions])

  const doGenerate = useCallback(() => {
    gen.run(buildRange(), buildOptions(), mode === 'daily' ? '日报' : '周报')
  }, [gen, buildRange, buildOptions, mode])

  const doDryRun = useCallback(async () => {
    try {
      const res = await api.collect({ rangeOpts: buildRange(), options: buildOptions() })
      const s = res.stats
      const errs = s.repoErrors.length ? `\n⚠ 采集失败仓库：${s.repoErrors.map((e) => e.repo).join('、')}` : ''
      toast('Dry-Run 预览', {
        description: `${s.bucketCount} 单元 · ~${s.estTokens.toLocaleString()} token · ${s.commitCount} commits + ${s.noteCount} 笔记${errs}`,
      })
    } catch (e) {
      toast.error('采集失败', { description: (e as Error).message })
    }
  }, [buildRange, buildOptions])

  // 复制 / 导出一律用编辑后的文本（用户可能已手动更正）
  const reportText = editing ? editText : gen.report
  const copyReport = useCallback(() => {
    navigator.clipboard?.writeText(editText)
    toast.success('已复制到剪贴板')
  }, [editText])

  // 切换编辑模式：进入编辑时以当前报告为起点；改动持续保留，直到下次「生成报告」重置
  const toggleEditing = useCallback(() => {
    setEditing((on) => {
      if (!on) setEditText(gen.report) // 进入编辑前同步最新
      return !on
    })
  }, [gen.report])

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">生成报告</h2>
        <p className="text-sm text-muted-foreground">commit 与人工笔记融合，一键产出结构化工作周报 / 日报</p>
      </div>

      {/* 报告类型 */}
      <Card>
        <CardContent className="pt-6">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div className="space-y-2">
              <Label>报告类型</Label>
              <Tabs value={mode} onValueChange={(v) => setMode(v as Mode)}>
                <TabsList>
                  <TabsTrigger value="weekly">周报</TabsTrigger>
                  <TabsTrigger value="daily">日报</TabsTrigger>
                </TabsList>
              </Tabs>
            </div>
            {mode === 'daily' && (
              <div className="min-w-[200px] space-y-1.5">
                <Label>日期</Label>
                <Select value={dailyDate} onValueChange={setDailyDate}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="today">今天</SelectItem>
                    <SelectItem value="yesterday">昨天</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* 时间范围（仅周报） */}
      {mode === 'weekly' && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">时间范围</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <ToggleGroup
              type="single"
              value={preset}
              onValueChange={(v) => v && setPreset(v as RangePreset)}
            >
              <ToggleGroupItem value="thisweek">本周</ToggleGroupItem>
              <ToggleGroupItem value="lastweek">上周</ToggleGroupItem>
              <ToggleGroupItem value="custom">自定义</ToggleGroupItem>
            </ToggleGroup>
            <div className="flex flex-wrap gap-4">
              <div className="min-w-[140px] flex-1 space-y-1.5">
                <Label>起始日期</Label>
                <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} disabled={preset !== 'custom'} />
              </div>
              <div className="min-w-[140px] flex-1 space-y-1.5">
                <Label>结束日期</Label>
                <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} disabled={preset !== 'custom'} />
              </div>
              <div className="min-w-[140px] space-y-1.5">
                <Label>周起始日</Label>
                <Select value={config?.weekStart ?? 'monday'} onValueChange={() => {}}>
                  <SelectTrigger disabled><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="monday">周一（默认）</SelectItem>
                    <SelectItem value="sunday">周日</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* 信息源融合 */}
      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle className="text-base">信息源融合</CardTitle>
          <Switch checked={notesEnabled} onCheckedChange={setNotesEnabled} />
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="rounded-md border-t-4 border-t-blue-500 border-x border-b bg-muted/30 p-4">
              <h4 className="mb-2 font-mono text-xs uppercase text-blue-500">代码提交（Commit）</h4>
              <p className="font-mono text-xl font-bold">{fusion ? fusion.commitCount : '—'}</p>
              <p className="mt-2 text-xs text-muted-foreground">采集后显示</p>
            </div>
            <div className="rounded-md border-t-4 border-t-violet-500 border-x border-b bg-muted/30 p-4">
              <h4 className="mb-2 font-mono text-xs uppercase text-violet-500">人工笔记（Note）</h4>
              <p className="font-mono text-xl font-bold">{fusion ? fusion.noteCount : '—'}</p>
              <p className="mt-2 text-xs text-muted-foreground">{fusion?.desc ?? '采集后显示'}</p>
            </div>
          </div>
          <div className="rounded-md border-l-4 border-l-violet-500 bg-muted/50 p-3">
            <p className="text-xs text-foreground/80">
              <strong>融合规则：</strong>带项目标签的笔记 → 对应项目桶；通用笔记 → 注入当天所有桶作补充上下文，同时作为【日常工作】独立段落兜底。两类信息源由 AI 统一归纳为 3–5 句总结。
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={refreshFusion} disabled={fusionLoading}>
            {fusionLoading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            刷新采集预览
          </Button>
        </CardContent>
      </Card>

      {/* 仓库与过滤 */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">仓库与过滤</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-4">
            <div className="min-w-[160px] flex-1 space-y-1.5">
              <Label>作者过滤</Label>
              <Input value={author} onChange={(e) => setAuthor(e.target.value)} placeholder="留空=全部，输入邮箱" />
            </div>
            <div className="min-w-[140px] space-y-1.5">
              <Label>Merge Commit</Label>
              <Select value={merge} onValueChange={(v) => setMerge(v as typeof merge)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="exclude">排除（推荐）</SelectItem>
                  <SelectItem value="include">包含</SelectItem>
                  <SelectItem value="only">仅 Merge</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="min-w-[140px] space-y-1.5">
              <Label>输出格式</Label>
              <Select value={format} onValueChange={(v) => setFormat(v as typeof format)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="text">text（默认）</SelectItem>
                  <SelectItem value="md">md</SelectItem>
                  <SelectItem value="json">json</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* 生成操作 */}
      <div className="flex flex-wrap items-center gap-3">
        <Button size="lg" onClick={doGenerate} disabled={gen.busy}>
          {gen.busy ? <Loader2 className="animate-spin" /> : <Play />}
          {gen.busy ? '生成中…' : '生成报告'}
        </Button>
        <Button size="lg" variant="outline" onClick={doDryRun} disabled={gen.busy}>
          <Eye />
          Dry-Run 预览
        </Button>
        {gen.status && <span className="font-mono text-xs text-muted-foreground">{gen.status}</span>}
      </div>

      {/* 已有报告（同日/同周）：重新生成将覆盖 */}
      <ExistingReportCard existing={existing} loading={loading} newReport={gen.report} />

      {/* 报告预览 */}
      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle>报告预览</CardTitle>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={toggleEditing} disabled={!gen.report}>
              {editing ? <Check /> : <Pencil />}
              {editing ? '完成' : '编辑'}
            </Button>
            <Button variant="outline" size="sm" onClick={copyReport} disabled={!gen.report}>
              <Copy />
              复制
            </Button>
            <Button variant="outline" size="sm" onClick={copyReport} disabled={!gen.report}>
              <Download />
              导出
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {editing ? (
            <textarea
              value={editText}
              onChange={(e) => setEditText(e.target.value)}
              autoFocus
              spellCheck={false}
              className="min-h-[240px] w-full resize-y rounded-md border bg-zinc-950 p-8 font-mono text-sm leading-[1.85] text-slate-200 shadow-sm outline-none focus:ring-2 focus:ring-ring"
            />
          ) : (
            <ReportPreview text={reportText} />
          )}
        </CardContent>
      </Card>
    </div>
  )
}
