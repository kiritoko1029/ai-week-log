import { useState, useEffect } from 'react'
import { ChevronDown, ChevronUp, Clock, RefreshCw } from 'lucide-react'
import { ReportPreview } from '@/components/ReportPreview'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import type { HistoryEntry } from '@/types/weeklog'

function fmtTime(iso: string) {
  try {
    const d = new Date(iso)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  } catch {
    return iso
  }
}

/**
 * 生成页右侧的「已有报告」折叠卡：展示当前范围（同日/同周）下的历史报告。
 * - 无报告时不渲染。
 * - 有报告时默认展开；当新生成的报告到达（newReport 非空且变化）时自动收起，避免与新报告重复展示。
 */
export function ExistingReportCard({
  existing,
  loading,
  newReport,
}: {
  existing: HistoryEntry | null
  loading: boolean
  /** 刚生成的新报告文本：非空时本卡自动收起 */
  newReport?: string
}) {
  const [open, setOpen] = useState(true)

  // 新报告到达时自动收起，让位给主预览区
  useEffect(() => {
    if (newReport) setOpen(false)
  }, [newReport])

  if (!existing) {
    // 当前范围无历史报告：仅在非加载态时给出一行灰提示，避免页面空洞
    return loading ? null : (
      <Card className="border-dashed">
        <CardContent className="py-4 text-center text-sm text-muted-foreground">
          当前范围暂无历史报告，生成后将在此处展示
        </CardContent>
      </Card>
    )
  }

  const rangeLabel =
    existing.rangeStart === existing.rangeEnd
      ? existing.rangeStart
      : `${existing.rangeStart} ~ ${existing.rangeEnd}`

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <div className="flex items-center gap-2">
          <CardTitle>已有报告</CardTitle>
          <Badge variant="secondary">{existing.type}</Badge>
          <span className="font-mono text-xs text-muted-foreground">{rangeLabel}</span>
          {existing.edited && <Badge variant="outline">已编辑</Badge>}
        </div>
        <Button variant="ghost" size="sm" onClick={() => setOpen((v) => !v)}>
          {open ? <ChevronUp /> : <ChevronDown />}
          {open ? '收起' : '展开'}
        </Button>
      </CardHeader>
      {open && (
        <CardContent className="space-y-3">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Clock className="h-3 w-3" />
            <span>更新于 {fmtTime(existing.createdAt)}</span>
          </div>
          <div className="flex items-center gap-1.5 rounded-md border-l-4 border-l-amber-500 bg-muted/50 p-2">
            <RefreshCw className="h-3 w-3 text-amber-600" />
            <p className="text-xs text-foreground/80">
              已有该范围的{existing.type}，重新生成将<strong>覆盖更新</strong>此报告。
            </p>
          </div>
          <ReportPreview text={existing.text} placeholder="(报告为空)" className="p-6 text-xs leading-[1.8]" />
        </CardContent>
      )}
    </Card>
  )
}
