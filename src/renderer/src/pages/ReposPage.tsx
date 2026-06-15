import { useState, useCallback } from 'react'
import { Plus, Trash2, FolderGit2, FolderOpen, X, CheckCircle2, XCircle, Loader2, ScanLine, FolderSearch } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { useConfig } from '@/hooks/useConfig'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import type { Repo, ScannedRepo } from '@/types/weeklog'

export function ReposPage() {
  const { config, refresh } = useConfig()
  const [addOpen, setAddOpen] = useState(false)
  const [scanOpen, setScanOpen] = useState(false)

  const repos = config?.repos ?? []

  const updateAlias = useCallback(async (repo: Repo, alias: string) => {
    await api.repo.update(repo.id, { alias: alias.trim() })
    await refresh()
  }, [refresh])

  const removeRepo = useCallback(async (repo: Repo) => {
    await api.repo.remove(repo.id)
    toast.success(`已移除仓库 ${repo.name}`)
    await refresh()
  }, [refresh])

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">仓库管理</h2>
          <p className="text-sm text-muted-foreground">注册和管理本地 Git 仓库，配置项目名称与采集策略</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => setScanOpen(true)}>
            <ScanLine />
            扫描文件夹
          </Button>
          <Button size="sm" onClick={() => setAddOpen(true)}>
            <Plus />
            添加仓库
          </Button>
        </div>
      </div>

      <div className="text-sm text-muted-foreground">{repos.length} 个已注册仓库</div>

      {repos.length === 0 ? (
        <Card className="p-8 text-center text-sm text-muted-foreground">
          暂无仓库，点击「添加仓库」注册本地 Git 仓库
        </Card>
      ) : (
        <div className="space-y-3">
          {repos.map((r) => (
            <Card key={r.id} className="flex items-center gap-4 p-4">
              <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-md bg-muted text-primary">
                <FolderGit2 className="h-5 w-5" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="font-semibold">{r.alias || r.name}</div>
                <div className="truncate font-mono text-xs text-muted-foreground">{r.path}</div>
              </div>
              <div className="flex flex-col items-end gap-1.5">
                <div className="flex items-center gap-2">
                  <Badge variant="secondary">{r.branch || 'main'}</Badge>
                  <Badge variant="success">在线</Badge>
                  <Button variant="ghost" size="sm" onClick={() => removeRepo(r)}>
                    <Trash2 />
                    移除
                  </Button>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="whitespace-nowrap text-xs text-muted-foreground">别名</span>
                  <Input
                    defaultValue={r.alias || ''}
                    placeholder="日报显示名（留空用项目名）"
                    className="h-7 w-[150px] text-xs"
                    onBlur={(e) => {
                      if (e.target.value !== (r.alias || '')) updateAlias(r, e.target.value)
                    }}
                  />
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      <AddRepoDialog open={addOpen} onOpenChange={setAddOpen} onAdded={refresh} />
      <ScanRepoDialog
        open={scanOpen}
        onOpenChange={setScanOpen}
        existingPaths={new Set(repos.map((r) => r.path))}
        onAdded={refresh}
      />
    </div>
  )
}

interface AddRepoState {
  path: string
  name: string
  alias: string
  branch: string
}

function AddRepoDialog({ open, onOpenChange, onAdded }: { open: boolean; onOpenChange: (o: boolean) => void; onAdded: () => void }) {
  const [state, setState] = useState<AddRepoState>({ path: '', name: '', alias: '', branch: 'main' })
  const [validate, setValidate] = useState<{ ok: boolean; branch: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const reset = useCallback(() => {
    setState({ path: '', name: '', alias: '', branch: 'main' })
    setValidate(null)
    setError(null)
  }, [])

  const browse = useCallback(async () => {
    const p = await api.dialog.pickRepo()
    if (!p) return
    setState((s) => ({ ...s, path: p }))
    const v = await api.repo.validate(p)
    setValidate(v)
    if (v.ok) {
      setState((s) => ({
        ...s,
        path: p,
        name: s.name || p.replace(/[/\\]+$/, '').split(/[/\\]/).pop() || '',
        branch: s.branch === 'main' ? v.branch || 'main' : s.branch,
      }))
    }
  }, [])

  const confirm = useCallback(async () => {
    if (!state.path.trim()) return
    setBusy(true)
    setError(null)
    try {
      const r = await api.repo.add({ path: state.path.trim(), name: state.name, branch: state.branch, alias: state.alias })
      if (r.error) {
        setError(r.error)
        return
      }
      toast.success('仓库已添加')
      reset()
      onOpenChange(false)
      onAdded()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }, [state, reset, onOpenChange, onAdded])

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset()
        onOpenChange(o)
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>添加仓库</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>仓库路径</Label>
            <div className="flex gap-2">
              <Input
                value={state.path}
                onChange={(e) => {
                  setState((s) => ({ ...s, path: e.target.value }))
                  setValidate(null)
                }}
                placeholder="F:/code/my-project"
                className="flex-1"
              />
              <Button variant="outline" type="button" onClick={browse}>
                <FolderOpen />
                浏览
              </Button>
            </div>
            {validate ? (
              validate.ok ? (
                <p className="flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
                  <CheckCircle2 className="h-3 w-3" /> 有效 Git 仓库 · 当前分支 {validate.branch || '—'}
                </p>
              ) : (
                <p className="flex items-center gap-1 text-xs text-red-600 dark:text-red-400">
                  <XCircle className="h-3 w-3" /> 不是有效的 Git 仓库
                </p>
              )
            ) : (
              <p className="text-xs text-muted-foreground">本地 Git 仓库绝对路径</p>
            )}
            {error && <p className="text-xs text-red-600 dark:text-red-400">✗ {error}</p>}
          </div>
          <div className="flex gap-4">
            <div className="flex-1 space-y-1.5">
              <Label>项目名称</Label>
              <Input value={state.name} onChange={(e) => setState((s) => ({ ...s, name: e.target.value }))} placeholder="聚合标识（稳定，建议英文）" />
              <p className="text-xs text-muted-foreground">用于聚合与笔记匹配</p>
            </div>
            <div className="flex-1 space-y-1.5">
              <Label>别名（日报显示）</Label>
              <Input value={state.alias} onChange={(e) => setState((s) => ({ ...s, alias: e.target.value }))} placeholder="如：订单服务后端（留空用项目名）" />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>默认分支</Label>
            <Input value={state.branch} onChange={(e) => setState((s) => ({ ...s, branch: e.target.value }))} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          <Button onClick={confirm} disabled={busy || !state.path.trim()}>
            {busy ? <Loader2 className="animate-spin" /> : null}
            确认添加
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * 扫描文件夹下的 Git 仓库（最大深度 3 层），
 * 列出候选项供勾选批量添加；已在册的仓库标记"已注册"且默认不勾选。
 */
function ScanRepoDialog({
  open,
  onOpenChange,
  existingPaths,
  onAdded,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  existingPaths: Set<string>
  onAdded: () => void
}) {
  const [rootDir, setRootDir] = useState('')
  const [results, setResults] = useState<ScannedRepo[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [scanning, setScanning] = useState(false)
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const reset = useCallback(() => {
    setRootDir('')
    setResults([])
    setSelected(new Set())
    setError(null)
  }, [])

  const browse = useCallback(async () => {
    const p = await api.dialog.pickFolder()
    if (p) setRootDir(p)
  }, [])

  const doScan = useCallback(async () => {
    if (!rootDir.trim()) return
    setScanning(true)
    setError(null)
    setResults([])
    setSelected(new Set())
    try {
      const { repos, error: scanError } = await api.repo.scan(rootDir.trim())
      if (scanError) {
        setError(scanError)
        return
      }
      // 过滤掉已注册的，默认全选未注册的
      const fresh = repos.filter((r) => !existingPaths.has(r.path))
      setResults(fresh)
      setSelected(new Set(fresh.map((r) => r.path)))
      if (!fresh.length) {
        toast.info('未发现新的 Git 仓库', { description: '该目录下（3 层内）已无可添加的仓库' })
      } else {
        toast.success(`发现 ${fresh.length} 个未注册仓库`)
      }
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setScanning(false)
    }
  }, [rootDir, existingPaths])

  const toggle = useCallback((p: string) => {
    setSelected((s) => {
      const next = new Set(s)
      if (next.has(p)) next.delete(p)
      else next.add(p)
      return next
    })
  }, [])

  const confirm = useCallback(async () => {
    const picked = results.filter((r) => selected.has(r.path))
    if (!picked.length) return
    setAdding(true)
    let okCount = 0
    for (const r of picked) {
      try {
        const res = await api.repo.add({ path: r.path, name: r.name, branch: r.branch })
        if (!res.error) okCount++
      } catch {}
    }
    setAdding(false)
    if (okCount) {
      toast.success(`已添加 ${okCount} 个仓库`, {
        description: picked.length > okCount ? `${picked.length - okCount} 个失败（可能路径重复）` : undefined,
      })
      onAdded()
      reset()
      onOpenChange(false)
    } else {
      toast.error('添加失败', { description: '所选仓库均添加失败' })
    }
  }, [results, selected, onAdded, reset, onOpenChange])

  const allSelected = results.length > 0 && selected.size === results.length

  const toggleAll = useCallback(() => {
    setSelected(allSelected ? new Set() : new Set(results.map((r) => r.path)))
  }, [allSelected, results])

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset()
        onOpenChange(o)
      }}
    >
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>扫描文件夹</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            选择一个根目录，自动扫描其下（最大 3 层）的 Git 仓库，批量添加。
          </p>
          <div className="space-y-1.5">
            <Label>根目录</Label>
            <div className="flex gap-2">
              <Input
                value={rootDir}
                onChange={(e) => setRootDir(e.target.value)}
                placeholder="例如 ~/code 或 D:/projects"
                className="flex-1"
              />
              <Button variant="outline" type="button" onClick={browse}>
                <FolderOpen />
                浏览
              </Button>
              <Button type="button" onClick={doScan} disabled={scanning || !rootDir.trim()}>
                {scanning ? <Loader2 className="animate-spin" /> : <FolderSearch />}
                扫描
              </Button>
            </div>
            {error && <p className="text-xs text-red-600 dark:text-red-400">✗ {error}</p>}
          </div>

          {results.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">
                  发现 {results.length} 个未注册仓库 · 已选 {selected.size}
                </span>
                <Button variant="ghost" size="sm" type="button" onClick={toggleAll}>
                  {allSelected ? '取消全选' : '全选'}
                </Button>
              </div>
              <div className="max-h-[280px] space-y-1.5 overflow-y-auto rounded-md border p-2">
                {results.map((r) => {
                  const isSel = selected.has(r.path)
                  return (
                    <button
                      key={r.path}
                      type="button"
                      onClick={() => toggle(r.path)}
                      className={cn(
                        'flex w-full items-center gap-3 rounded-md border px-3 py-2 text-left transition-colors',
                        isSel
                          ? 'border-primary/40 bg-primary/5'
                          : 'border-transparent hover:bg-muted'
                      )}
                    >
                      <span
                        className={cn(
                          'flex h-4 w-4 flex-shrink-0 items-center justify-center rounded border',
                          isSel ? 'border-primary bg-primary text-primary-foreground' : 'border-muted-foreground/40'
                        )}
                      >
                        {isSel && <CheckCircle2 className="h-3 w-3" />}
                      </span>
                      <FolderGit2 className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium">{r.name}</div>
                        <div className="truncate font-mono text-xs text-muted-foreground">{r.path}</div>
                      </div>
                      <Badge variant="secondary" className="flex-shrink-0">{r.branch || '—'}</Badge>
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          {!scanning && results.length === 0 && !error && rootDir && (
            <p className="py-4 text-center text-sm text-muted-foreground">点击「扫描」开始查找</p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          <Button onClick={confirm} disabled={adding || selected.size === 0}>
            {adding ? <Loader2 className="animate-spin" /> : <Plus />}
            添加所选 ({selected.size})
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
