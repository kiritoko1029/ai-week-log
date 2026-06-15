import { useState, useEffect, useCallback } from 'react'
import { Eye, History as HistoryIcon, Loader2 } from 'lucide-react'
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
  // 编辑态：弹窗内的可编辑文本
  const [editText, setEditText] = useState('')
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    setList(await api.history.list())
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const openEntry = useCallback((h: HistoryEntry) => {
    setSelected(h)
    setEditText(h.text || '')
  }, [])

  const saveEdit = useCallback(async () => {
    if (!selected) return
    setSaving(true)
    try {
      const r = await api.history.update(selected.id, editText)
      if (r.ok) {
        toast.success('已保存修改')
        // 同步本地列表，避免刷新才看到
        setList((prev) => prev.map((h) => (h.id === selected.id ? { ...h, text: editText, edited: true } : h)))
        setSelected((prev) => (prev ? { ...prev, text: editText, edited: true } : prev))
      } else {
        toast.error('保存失败：记录不存在或已被清理')
      }
    } catch (e: any) {
      toast.error('保存失败：' + (e?.message || '未知错误'))
    } finally {
      setSaving(false)
    }
  }, [selected, editText])

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
                      <Badge variant={degraded ? 'warning' : 'success'}>
                        {degraded ? '含降级' : h.edited ? '已编辑' : '完成'}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => openEntry(h)}
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
              {selected?.edited && <Badge variant="muted">已编辑</Badge>}
            </DialogTitle>
          </DialogHeader>
          <textarea
            value={editText}
            onChange={(e) => setEditText(e.target.value)}
            spellCheck={false}
            className="max-h-[50vh] min-h-[200px] w-full resize-y rounded-md border bg-zinc-950 p-4 font-mono text-sm leading-relaxed text-slate-200 outline-none focus:ring-2 focus:ring-ring"
          />
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                navigator.clipboard?.writeText(editText)
                toast.success('已复制')
              }}
            >
              复制全文
            </Button>
            <Button
              variant="outline"
              onClick={() => selected && setEditText(selected.text || '')}
              disabled={!selected || editText === (selected?.text || '')}
            >
              撤销改动
            </Button>
            <Button onClick={saveEdit} disabled={saving || !selected || editText === (selected?.text || '')}>
              {saving ? <Loader2 className="animate-spin" /> : null}
              保存
            </Button>
            <Button variant="ghost" onClick={() => setSelected(null)}>关闭</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
