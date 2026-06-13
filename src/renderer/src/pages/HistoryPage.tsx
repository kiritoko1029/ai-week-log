import { useState, useEffect, useCallback } from 'react'
import { Eye, History as HistoryIcon } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Table, TableHeader, TableBody, TableHead, TableRow, TableCell } from '@/components/ui/table'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import type { HistoryEntry } from '@/types/weeklog'

export function HistoryPage() {
  const [list, setList] = useState<HistoryEntry[]>([])
  const [selected, setSelected] = useState<HistoryEntry | null>(null)

  const load = useCallback(async () => {
    setList(await api.history.list())
  }, [])

  useEffect(() => {
    load()
  }, [load])

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">历史记录</h2>
        <p className="text-sm text-muted-foreground">查看和导出历史生成的周报 / 日报</p>
      </div>

      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>时间</TableHead>
              <TableHead>类型</TableHead>
              <TableHead>范围</TableHead>
              <TableHead>仓库</TableHead>
              <TableHead>笔记</TableHead>
              <TableHead>摘要</TableHead>
              <TableHead>状态</TableHead>
              <TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="text-center text-muted-foreground">暂无历史记录</TableCell>
              </TableRow>
            ) : (
              list.map((h) => {
                const time = new Date(h.createdAt)
                const m = h.meta || {}
                const degraded = (h.text || '').includes('降级') || (m.failedUnits && m.failedUnits.length)
                return (
                  <TableRow key={h.id}>
                    <TableCell className="font-mono tabular-nums">
                      {time.getMonth() + 1}/{time.getDate()} {String(time.getHours()).padStart(2, '0')}:{String(time.getMinutes()).padStart(2, '0')}
                    </TableCell>
                    <TableCell>
                      <Badge variant={h.type === '日报' ? 'secondary' : 'default'}>{h.type}</Badge>
                    </TableCell>
                    <TableCell className="font-mono tabular-nums">
                      {h.rangeStart || '—'}
                      {h.rangeEnd ? `~${h.rangeEnd.slice(5)}` : ''}
                    </TableCell>
                    <TableCell className="font-mono tabular-nums">{m.bucketCount ?? '—'}</TableCell>
                    <TableCell className="font-mono tabular-nums">{m.noteCount ?? 0}</TableCell>
                    <TableCell className="font-mono tabular-nums">{m.commitCount ?? 0}</TableCell>
                    <TableCell>
                      <Badge variant={degraded ? 'warning' : 'success'}>{degraded ? '含降级' : '完成'}</Badge>
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setSelected(h)
                          navigator.clipboard?.writeText(h.text || '')
                        }}
                      >
                        <Eye />
                        查看
                      </Button>
                    </TableCell>
                  </TableRow>
                )
              })
            )}
          </TableBody>
        </Table>
      </Card>

      <Dialog open={!!selected} onOpenChange={(o) => !o && setSelected(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <HistoryIcon className="h-5 w-5" />
              {selected?.type} · {selected?.rangeStart || '—'}
              {selected?.rangeEnd ? `~${selected.rangeEnd.slice(5)}` : ''}
            </DialogTitle>
          </DialogHeader>
          <pre className="max-h-[50vh] overflow-auto rounded-md border bg-zinc-950 p-4 font-mono text-sm leading-relaxed text-slate-200">
            {selected?.text || '（无内容）'}
          </pre>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                navigator.clipboard?.writeText(selected?.text || '')
                toast.success('已复制')
              }}
            >
              复制全文
            </Button>
            <Button onClick={() => setSelected(null)}>关闭</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
