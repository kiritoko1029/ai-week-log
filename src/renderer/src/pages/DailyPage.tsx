import { useState, useCallback, useEffect, useMemo } from 'react'
import { Play, Plus, Loader2, MessageSquare } from 'lucide-react'
import { api } from '@/lib/api'
import { useConfig } from '@/hooks/useConfig'
import { useGenerate } from '@/hooks/useGenerate'
import { useExistingReport } from '@/hooks/useExistingReport'
import { useNav } from '@/hooks/useNav'
import { ReportPreview } from '@/components/ReportPreview'
import { Markdown } from '@/components/Markdown'
import { ExistingReportCard } from '@/components/ExistingReportCard'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Badge } from '@/components/ui/badge'
import { cn, codeSurface } from '@/lib/utils'
import type { ReportFormat } from '@/types/weeklog'

export function DailyPage() {
  const { config } = useConfig()
  const { navigate } = useNav()
  const gen = useGenerate()
  const [date, setDate] = useState('today')
  const [noCommits, setNoCommits] = useState(true)
  const [format, setFormat] = useState<ReportFormat>('text')
  // 跟踪当前预览文本所属的格式，用于切换下拉时做即时格式互转
  const [lastRenderedFormat, setLastRenderedFormat] = useState<ReportFormat>('text')
  const [displayReport, setDisplayReport] = useState('')
  const [converting, setConverting] = useState(false)

  useEffect(() => {
    if (config) {
      setFormat(config.output.format)
      setLastRenderedFormat(config.output.format)
    }
  }, [config])

  // 新报告生成后同步展示文本与格式
  useEffect(() => {
    setDisplayReport(gen.report)
    if (gen.report) setLastRenderedFormat(format)
  }, [gen.report, format])

  const doGenerate = useCallback(() => {
    gen.run({ mode: 'daily', date }, { format, weekStart: config?.weekStart }, '日报')
  }, [gen, date, format, config])

  // 切换输出格式：有报告时即时互转（不调 AI），无报告时仅设定下次生成格式
  const handleFormatChange = useCallback(
    async (v: ReportFormat) => {
      setFormat(v)
      if (!displayReport || v === lastRenderedFormat) return
      setConverting(true)
      try {
        const r = await api.report.convert({ text: displayReport, from: lastRenderedFormat, to: v })
        setDisplayReport(r.text)
        setLastRenderedFormat(v)
      } catch {
        // 转换失败静默保留原文
      } finally {
        setConverting(false)
      }
    },
    [displayReport, lastRenderedFormat]
  )

  // 当前日期下是否已有日报，用于展示「重新生成将覆盖」
  const rangeOpts = useMemo(() => ({ mode: 'daily' as const, date }), [date])
  const { existing, loading } = useExistingReport('日报', rangeOpts, { weekStart: config?.weekStart })

  // 送入 AI 对话润色
  const goRefine = useCallback(() => {
    if (!displayReport) return
    navigate('chat', { kind: 'reportRefine', reportText: displayReport, reportType: '日报' })
  }, [displayReport, navigate])

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">今日日报</h2>
        <p className="text-sm text-muted-foreground">单天 commit + 笔记融合，适合日终快速小结</p>
      </div>

      <Card>
        <CardContent className="space-y-5 pt-6">
          <div className="flex flex-wrap gap-4">
            <div className="min-w-[140px] space-y-1.5">
              <Label>日期</Label>
              <Select value={date} onValueChange={setDate}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="today">今天</SelectItem>
                  <SelectItem value="yesterday">昨天</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="min-w-[200px] space-y-1.5">
              <Label>无 commit 处理</Label>
              <Select value={noCommits ? '1' : '0'} onValueChange={(v) => setNoCommits(v === '1')}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="1">有笔记仍生成（--no-commits-ok）</SelectItem>
                  <SelectItem value="0">提示无记录</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="min-w-[140px] space-y-1.5">
              <Label>输出格式</Label>
              <Select value={format} onValueChange={(v) => handleFormatChange(v as ReportFormat)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="compact">紧凑文本（无换行）</SelectItem>
                  <SelectItem value="text">格式化文本（有换行）</SelectItem>
                  <SelectItem value="md">Markdown</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="rounded-md border-l-4 border-l-violet-500 bg-muted/50 p-3">
            <p className="text-xs text-foreground/80">
              <strong>纯笔记日报：</strong>今天如果只开会没写代码，开启「有笔记仍生成」，会基于笔记产出【日常工作】段——非代码工作一样能形成日报。
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={doGenerate} disabled={gen.busy}>
              {gen.busy ? <Loader2 className="animate-spin" /> : <Play />}
              {gen.busy ? '生成中…' : '生成日报'}
            </Button>
            <Button
              className="bg-violet-600 text-white hover:bg-violet-600/90"
              onClick={() => navigate('notes')}
            >
              <Plus />
              先记一笔
            </Button>
            {gen.status && <span className="font-mono text-xs text-muted-foreground">{gen.status}</span>}
          </div>
        </CardContent>
      </Card>

      {/* 已有日报：重新生成将覆盖 */}
      <ExistingReportCard existing={existing} loading={loading} newReport={gen.report} />

      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            日报预览
            {converting && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
          </CardTitle>
          <div className="flex items-center gap-2">
            {displayReport && <Badge variant="secondary">{date === 'today' ? '今天' : date === 'yesterday' ? '昨天' : date}</Badge>}
            <Button variant="outline" size="sm" onClick={goRefine} disabled={!displayReport} className="text-violet-600 hover:text-violet-700">
              <MessageSquare />
              去对话润色
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {format === 'md' ? (
            <div className={cn(codeSurface, 'min-h-[120px] overflow-x-auto p-8 shadow-sm')}>
              {displayReport ? <Markdown content={displayReport} /> : <span className="text-slate-500">点击「生成日报」后此处显示结果…</span>}
            </div>
          ) : (
            <ReportPreview text={displayReport} />
          )}
        </CardContent>
      </Card>
    </div>
  )
}
