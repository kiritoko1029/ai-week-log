import { useState, useCallback, useEffect } from 'react'
import { Plus, Sparkles, CalendarClock, Eye, Zap } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { useConfig } from '@/hooks/useConfig'
import { useNav } from '@/hooks/useNav'
import { todayISO } from '@/lib/dates'
import { StatCard } from '@/components/StatCard'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { ProjectSelect } from '@/components/ProjectSelect'

interface DashStats {
  commitCount: number
  noteCount: number
  bucketCount: number
  estTokens: number
  days: number
  noteProjectCount: number
  noteMiscCount: number
  notesOnlyCount: number
}

export function DashboardPage() {
  const { config } = useConfig()
  const { navigate } = useNav()
  const [stats, setStats] = useState<DashStats | null>(null)
  const [statsError, setStatsError] = useState<string | null>(null)
  const [noteText, setNoteText] = useState('')
  const [noteProject, setNoteProject] = useState('')

  const loadStats = useCallback(async () => {
    try {
      const res = await api.collect({ rangeOpts: {}, options: {} })
      setStats(res.stats as unknown as DashStats)
      setStatsError(null)
    } catch (e) {
      setStatsError((e as Error).message)
    }
  }, [])

  useEffect(() => {
    loadStats()
  }, [loadStats])

  const addNote = useCallback(async () => {
    const content = noteText.trim()
    if (!content) return
    try {
      const r = await api.notes.add({ date: todayISO(), project: noteProject, content })
      toast.success(`已写入 ${r.file}`, { description: noteProject ? `## ${noteProject}` : '## 日常工作' })
      setNoteText('')
      loadStats()
    } catch (e) {
      toast.error('保存失败', { description: (e as Error).message })
    }
  }, [noteText, noteProject, loadStats])

  const projects = config?.repos.map((r) => ({ value: r.name, label: r.alias || r.name })) ?? []

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">仪表盘</h2>
        <p className="text-sm text-muted-foreground">本周工作概览 · commit + 笔记双信息源融合</p>
      </div>

      {/* 统计卡片 */}
      <div className="grid grid-cols-[repeat(auto-fit,minmax(190px,1fr))] gap-4">
        <StatCard
          label="本周 Commits"
          value={stats ? stats.commitCount : '—'}
          delta={stats ? `${stats.days} 个工作日` : statsError ? '采集失败：' + statsError : '加载中…'}
        />
        <StatCard
          label="本周笔记"
          value={stats ? stats.noteCount : '—'}
          delta={stats ? `${stats.noteProjectCount} 项目级 + ${stats.noteMiscCount} 通用` : '—'}
          deltaClassName="text-violet-500"
        />
        <StatCard
          label="周报单元"
          value={stats ? stats.bucketCount : '—'}
          delta={stats ? (stats.notesOnlyCount ? `含 ${stats.notesOnlyCount} 个纯笔记段` : '全部含 commit') : '—'}
        />
        <StatCard
          label="预估 Token"
          value={stats ? '~' + stats.estTokens.toLocaleString() : '—'}
          delta="commit + 笔记合计"
        />
      </div>

      {/* 快速记一笔 */}
      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle>快速记一笔</CardTitle>
          <Badge variant="secondary" className="bg-violet-500/10 text-violet-600 dark:text-violet-400">
            补全非代码工作
          </Badge>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            会议、沟通、方案设计、技术调研……这些工作不在 commit 里，记一条笔记，生成周报时会自动融合。
          </p>
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-[200px] flex-1 space-y-1.5">
              <Label htmlFor="dashNoteInput">笔记内容</Label>
              <Input
                id="dashNoteInput"
                value={noteText}
                onChange={(e) => setNoteText(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && addNote()}
                placeholder="例如：参加架构评审，确认了订单服务拆分方案"
              />
            </div>
            <div className="min-w-[160px] space-y-1.5">
              <Label>关联项目</Label>
              <ProjectSelect
                value={noteProject}
                onChange={(v) => setNoteProject(v)}
                options={projects}
              />
            </div>
            <Button onClick={addNote} className="bg-violet-600 text-white hover:bg-violet-600/90">
              <Plus />
              添加笔记
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* 一键生成 */}
      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle>一键生成</CardTitle>
          <Badge variant={stats && statsError === null ? 'success' : 'warning'}>
            {statsError === null ? '就绪' : '未就绪'}
          </Badge>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-3">
            <Button onClick={() => navigate('generate')}>
              <Sparkles />
              生成本周周报
            </Button>
            <Button variant="outline" onClick={() => navigate('daily')}>
              <CalendarClock />
              生成今日日报
            </Button>
            <Button variant="outline" onClick={() => navigate('generate')}>
              <Eye />
              Dry-Run 预览
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* 最近生成 */}
      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle>最近生成</CardTitle>
          <Button variant="ghost" size="sm" onClick={() => navigate('history')}>
            查看全部
          </Button>
        </CardHeader>
        <CardContent>
          <RecentList />
        </CardContent>
      </Card>
    </div>
  )
}

function RecentList() {
  const [recent, setRecent] = useState<{ type: string; createdAt: string }[]>([])

  useEffect(() => {
    api.history.list().then((list) => setRecent(list.slice(0, 3)))
  }, [])

  if (!recent.length) {
    return <div className="py-8 text-center text-sm text-muted-foreground">暂无记录</div>
  }
  return (
    <div className="space-y-2">
      {recent.map((r, i) => (
        <div key={i} className="flex items-center gap-3 rounded-md border px-4 py-2 text-sm">
          <Zap className="h-4 w-4 text-primary" />
          <Badge variant={r.type === '日报' ? 'secondary' : 'default'}>{r.type}</Badge>
          <span className="font-mono text-xs text-muted-foreground">
            {new Date(r.createdAt).toLocaleString('zh-CN')}
          </span>
        </div>
      ))}
    </div>
  )
}
