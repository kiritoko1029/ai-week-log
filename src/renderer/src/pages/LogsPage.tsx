import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertCircle, Bug, CircleAlert, Info, RefreshCw, ScrollText, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { AppLogEntry } from '@/types/weeklog'

type LevelFilter = 'all' | AppLogEntry['level']

const levelMeta = {
  debug: { label: 'Debug', variant: 'muted' as const, icon: Bug },
  info: { label: 'Info', variant: 'secondary' as const, icon: Info },
  warn: { label: 'Warn', variant: 'warning' as const, icon: CircleAlert },
  error: { label: 'Error', variant: 'destructive' as const, icon: AlertCircle },
}

export function LogsPage() {
  const [logs, setLogs] = useState<AppLogEntry[]>([])
  const [level, setLevel] = useState<LevelFilter>('all')
  const [scope, setScope] = useState('all')
  const [loading, setLoading] = useState(false)
  const [logPath, setLogPath] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [items, p] = await Promise.all([api.logs.list(800), api.logs.path()])
      setLogs(items)
      setLogPath(p)
    } catch (e: any) {
      toast.error('读取日志失败：' + (e?.message || '未知错误'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const scopes = useMemo(() => {
    const values = Array.from(new Set(logs.map((item) => item.scope).filter(Boolean))).sort()
    return ['all', ...values]
  }, [logs])

  const filtered = useMemo(() => {
    return logs.filter((item) => {
      if (level !== 'all' && item.level !== level) return false
      if (scope !== 'all' && item.scope !== scope) return false
      return true
    })
  }, [logs, level, scope])

  const clear = useCallback(async () => {
    if (!confirm('清空本地日志？')) return
    await api.logs.clear()
    toast.success('日志已清空')
    load()
  }, [load])

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
            <ScrollText className="size-6" />
            日志
          </h2>
          <p className="text-sm text-muted-foreground">查看应用运行与 WebDAV 同步诊断信息</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" onClick={load} disabled={loading}>
            <RefreshCw className={cn(loading && 'animate-spin')} />
            刷新
          </Button>
          <Button type="button" variant="outline" onClick={clear} disabled={logs.length === 0}>
            <Trash2 />
            清空
          </Button>
        </div>
      </div>

      <Card>
        <CardContent className="space-y-4 p-4">
          <div className="flex flex-wrap items-center gap-3">
            <div className="min-w-[140px]">
              <Select value={level} onValueChange={(v) => setLevel(v as LevelFilter)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部级别</SelectItem>
                  <SelectItem value="error">Error</SelectItem>
                  <SelectItem value="warn">Warn</SelectItem>
                  <SelectItem value="info">Info</SelectItem>
                  <SelectItem value="debug">Debug</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="min-w-[220px]">
              <Select value={scope} onValueChange={setScope}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {scopes.map((item) => (
                    <SelectItem key={item} value={item}>{item === 'all' ? '全部模块' : item}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <span className="font-mono text-xs text-muted-foreground">{filtered.length}/{logs.length} 条</span>
          </div>
          {logPath && (
            <p className="truncate rounded-md bg-muted px-3 py-2 font-mono text-xs text-muted-foreground" title={logPath}>
              {logPath}
            </p>
          )}
        </CardContent>
      </Card>

      <div className="space-y-2">
        {filtered.length === 0 ? (
          <Card>
            <CardContent className="p-8 text-center text-sm text-muted-foreground">暂无日志</CardContent>
          </Card>
        ) : (
          filtered.map((entry, index) => {
            const meta = levelMeta[entry.level] || levelMeta.info
            const Icon = meta.icon
            return (
              <Card key={`${entry.ts}-${index}`}>
                <CardContent className="space-y-2 p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant={meta.variant}>
                      <Icon className="size-3" />
                      {meta.label}
                    </Badge>
                    <span className="font-mono text-xs text-muted-foreground">
                      {new Date(entry.ts).toLocaleString()}
                    </span>
                    <Badge variant="outline" className="font-mono">{entry.scope || 'app'}</Badge>
                    <span className="text-sm font-medium">{entry.message}</span>
                  </div>
                  {entry.data && Object.keys(entry.data).length > 0 && (
                    <pre className="max-h-56 overflow-auto rounded-md bg-muted p-3 text-xs leading-relaxed text-muted-foreground">
                      {JSON.stringify(entry.data, null, 2)}
                    </pre>
                  )}
                </CardContent>
              </Card>
            )
          })
        )}
      </div>
    </div>
  )
}
