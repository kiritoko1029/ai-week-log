import { useState, useCallback } from 'react'
import { Plus, Trash2, FolderGit2, FolderOpen, X, CheckCircle2, XCircle, Loader2 } from 'lucide-react'
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
import type { Repo } from '@/types/weeklog'

export function ReposPage() {
  const { config, refresh } = useConfig()
  const [addOpen, setAddOpen] = useState(false)

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
        <Button size="sm" onClick={() => setAddOpen(true)}>
          <Plus />
          添加仓库
        </Button>
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
