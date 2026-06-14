import { useState, useEffect, useCallback } from 'react'
import { Eye, EyeOff, FolderOpen, Save, Trash2, Cloud, Brain, RefreshCw, Zap, Database } from 'lucide-react'
import { ProviderBadge } from '@/components/BrandIcons'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { useConfig } from '@/hooks/useConfig'
import { ThemeToggle } from '@/components/ThemeToggle'
import { accelToLabel, useShortcutRecorder } from '@/hooks/useShortcut'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { Separator } from '@/components/ui/separator'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import type { Config, MemoryIndexItem, WebdavStatus, MemoryQueueStatus } from '@/types/weeklog'

export function SettingsPage() {
  const { config, save } = useConfig()
  const [draft, setDraft] = useState<Config | null>(null)
  const [notesDirDisplay, setNotesDirDisplay] = useState('—')
  const [showKey, setShowKey] = useState(false)
  const [apiKey, setApiKey] = useState('')
  const [keyAvailable, setKeyAvailable] = useState(true)

  // WebDAV 同步状态
  const [webdavPassword, setWebdavPassword] = useState('')
  const [showWebdavPass, setShowWebdavPass] = useState(false)
  const [webdavStatus, setWebdavStatus] = useState<WebdavStatus | null>(null)
  const [testingWebdav, setTestingWebdav] = useState(false)
  const [syncingWebdav, setSyncingWebdav] = useState(false)

  // AI 记忆状态
  const [memList, setMemList] = useState<MemoryIndexItem[]>([])
  const [memQueue, setMemQueue] = useState<MemoryQueueStatus | null>(null)
  const [rebuildingMem, setRebuildingMem] = useState(false)
  const [memDialogOpen, setMemDialogOpen] = useState(false)

  const recorder = useShortcutRecorder(config?.ui?.quickNoteShortcut || 'CommandOrControl+Shift+L')

  useEffect(() => {
    if (config) setDraft(structuredClone(config))
  }, [config])

  // 加载当前 provider 的 API Key + notesDir
  useEffect(() => {
    if (!draft) return
    api.secrets.get(draft.ai.provider).then((r) => {
      setApiKey(r.key || '')
      setKeyAvailable(r.available)
    })
    api.config.notesDir().then(setNotesDirDisplay)
  }, [draft])

  // 加载 WebDAV 密码 + 同步状态
  useEffect(() => {
    api.webdav.getPassword().then((r) => setWebdavPassword(r.password || ''))
    api.webdav.status().then(setWebdavStatus)
  }, [])

  // 加载记忆列表 + 队列状态（记忆弹窗打开时刷新）
  useEffect(() => {
    if (memDialogOpen) {
      api.memory.list().then(setMemList)
      api.memory.queueStatus().then(setMemQueue)
    }
  }, [memDialogOpen])

  const patch = useCallback((updater: (c: Config) => void) => {
    setDraft((prev) => {
      if (!prev) return prev
      const next = structuredClone(prev)
      updater(next)
      return next
    })
  }, [])

  const selectProvider = useCallback(
    (p: 'openai' | 'anthropic') => {
      patch((c) => {
        c.ai.provider = p
      })
      // 切换 provider 后加载对应 key
      api.secrets.get(p).then((r) => setApiKey(r.key || ''))
    },
    [patch]
  )

  const pickNotesDir = useCallback(async () => {
    const p = await api.dialog.pickFolder()
    if (p) patch((c) => { c.notes.dir = p })
  }, [patch])

  const clearApiKey = useCallback(async () => {
    if (!draft) return
    await api.secrets.clear(draft.ai.provider)
    setApiKey('')
    toast.success('API Key 已清除')
  }, [draft])

  const handleSave = useCallback(async () => {
    if (!draft) return
    draft.ui = draft.ui || { theme: 'auto', quickNoteShortcut: recorder.accel }
    draft.ui.quickNoteShortcut = recorder.accel
    // API Key：与当前存储不同才写入
    const curKey = (await api.secrets.get(draft.ai.provider)).key || ''
    if (apiKey !== curKey) {
      await api.secrets.set(draft.ai.provider, apiKey)
    }
    // WebDAV 密码：与当前存储不同才写入
    const curWd = (await api.webdav.getPassword()).password || ''
    if (webdavPassword !== curWd) {
      await api.webdav.savePassword(webdavPassword)
    }
    await save(draft)
    const sr = await api.shortcut.apply()
    if (sr && !sr.ok) toast.warning('快捷键可能被占用，已回退默认')
    else toast.success('设置已保存')
  }, [draft, apiKey, webdavPassword, recorder.accel, save])

  // WebDAV：测试连接
  const testWebdav = useCallback(async () => {
    if (!draft) return
    setTestingWebdav(true)
    try {
      const r = await api.webdav.test(draft.webdav.url, draft.webdav.username, webdavPassword)
      if (r.ok) toast.success(r.message)
      else toast.error(r.message)
    } catch (e: any) {
      toast.error('测试失败：' + (e?.message || '未知错误'))
    } finally {
      setTestingWebdav(false)
    }
  }, [draft, webdavPassword])

  // WebDAV：立即同步
  const syncNow = useCallback(async (direction: 'pull' | 'push' | 'both') => {
    setSyncingWebdav(true)
    try {
      // 先确保配置已保存（同步用最新配置）
      if (draft) await save(draft)
      const r = await api.webdav.syncNow(direction)
      await api.webdav.status().then(setWebdavStatus)
      if (r.errors.length) {
        toast.warning(`同步完成：拉取 ${r.pulled}，推送 ${r.pushed}，${r.errors.length} 个错误`)
      } else {
        toast.success(`同步完成：拉取 ${r.pulled}，推送 ${r.pushed}`)
      }
    } catch (e: any) {
      toast.error('同步失败：' + (e?.message || '未知错误'))
    } finally {
      setSyncingWebdav(false)
    }
  }, [draft, save])

  // 记忆：重建
  const rebuildMemory = useCallback(async () => {
    setRebuildingMem(true)
    try {
      const r = await api.memory.rebuild()
      if (r.error) {
        toast.error(r.error)
      } else {
        toast.success(`记忆重建完成：生成 ${r.generated} 条，失败 ${r.failed} 条`)
        api.memory.list().then(setMemList)
        api.memory.queueStatus().then(setMemQueue)
      }
    } catch (e: any) {
      toast.error('重建失败：' + (e?.message || '未知错误'))
    } finally {
      setRebuildingMem(false)
    }
  }, [])

  // 记忆：删除单条
  const removeMemory = useCallback(async (id: string) => {
    await api.memory.remove(id)
    setMemList((prev) => prev.filter((m) => m.id !== id))
    toast.success('已删除')
  }, [])

  if (!draft) {
    return <div className="py-8 text-center text-sm text-muted-foreground">加载配置中…</div>
  }

  const prov = draft.ai.provider
  const sub = draft.ai[prov]
  const tempPct = Math.round((sub.temperature ?? 0.3) * 100)

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">AI 与输出设置</h2>
        <p className="text-sm text-muted-foreground">配置 LLM 后端、笔记、输出格式、并发与容错策略</p>
      </div>

      {/* 界面与快捷键 */}
      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle>界面与快捷键</CardTitle>
          <Badge variant="secondary">v1.2</Badge>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-6">
            <div className="space-y-1.5">
              <Label>主题外观</Label>
              <ThemeToggle />
              <p className="text-xs text-muted-foreground">深色模式更护眼；「跟随系统」随操作系统切换</p>
            </div>
            <div className="min-w-[240px] space-y-1.5">
              <Label>快速记笔记快捷键</Label>
              <div className="flex gap-2">
                <Input
                  value={accelToLabel(recorder.accel)}
                  readOnly
                  onFocus={recorder.onFocus}
                  onBlur={recorder.onBlur}
                  onKeyDown={recorder.handleKeyDown}
                  className="flex-1 cursor-pointer text-center font-mono"
                  placeholder="点击后按下组合键"
                />
                <Button variant="outline" type="button" onClick={recorder.reset}>
                  默认
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">全局生效（含最小化到托盘时）。需含 Ctrl / Alt / Shift 至少一个修饰键</p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* 笔记配置 */}
      <Card className="border-l-4 border-l-violet-500">
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle>笔记配置</CardTitle>
          <Badge variant="secondary" className="bg-violet-500/10 text-violet-600 dark:text-violet-400">v1.1</Badge>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-4">
            <div className="flex-1 space-y-1.5">
              <Label>笔记目录</Label>
              <div className="flex gap-2">
                <Input
                  value={draft.notes.dir ?? ''}
                  onChange={(e) => patch((c) => { c.notes.dir = e.target.value || undefined })}
                  placeholder="留空=默认（应用数据目录/notes）"
                  className="flex-1"
                />
                <Button variant="outline" type="button" onClick={pickNotesDir}>
                  <FolderOpen />
                  浏览
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">当前：<code className="rounded bg-muted px-1.5 py-0.5 font-mono">{notesDirDisplay}</code></p>
            </div>
            <div className="min-w-[200px] space-y-1.5">
              <Label>通用项目名（miscProject）</Label>
              <Input
                value={draft.notes.miscProject}
                onChange={(e) => patch((c) => { c.notes.miscProject = e.target.value || '日常工作' })}
              />
            </div>
          </div>
          <div className="flex items-center justify-between py-2">
            <div>
              <h4 className="text-sm font-semibold">启用笔记融合</h4>
              <p className="text-xs text-muted-foreground">关闭后仅基于 commit 生成</p>
            </div>
            <Switch
              checked={draft.notes.enabled}
              onCheckedChange={(v) => patch((c) => { c.notes.enabled = v })}
            />
          </div>
          <div className="rounded-md border-l-4 border-l-violet-500 bg-muted/50 p-3">
            <p className="text-xs text-foreground/80">
              <strong>隐私提示：</strong>笔记往往含更敏感业务信息。commit 与笔记一并受脱敏规则约束，可指向私有网关实现数据不出内网。
            </p>
          </div>
        </CardContent>
      </Card>

      {/* AI 提供商 */}
      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle>AI 提供商</CardTitle>
          <KeyBadge hasKey={!!apiKey} />
        </CardHeader>
        <CardContent className="space-y-4">
          <RadioGroup
            value={prov}
            onValueChange={(v) => selectProvider(v as 'openai' | 'anthropic')}
            className="grid grid-cols-2 gap-4"
          >
            {(['anthropic', 'openai'] as const).map((p) => (
              <label
                key={p}
                htmlFor={`prov-${p}`}
                className={cn(
                  'flex cursor-pointer items-start gap-3 rounded-md border-2 p-4 transition-all',
                  prov === p ? 'border-primary bg-muted/40' : 'border-border hover:border-primary/50'
                )}
              >
                <RadioGroupItem value={p} id={`prov-${p}`} className="mt-1" />
                <div className="flex-1">
                  <div className="mb-1 flex items-center gap-2">
                    <ProviderBadge provider={p} />
                    <h4 className="font-semibold">{p === 'anthropic' ? 'Anthropic' : 'OpenAI'}</h4>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {p === 'anthropic' ? 'Claude 系列模型 · Messages API' : 'GPT 系列模型 · Responses API'}
                  </p>
                </div>
              </label>
            ))}
          </RadioGroup>

          <div className="flex flex-wrap gap-4">
            <div className="flex-1 space-y-1.5">
              <Label>模型</Label>
              <Input value={sub.model} onChange={(e) => patch((c) => { c.ai[prov].model = e.target.value })} />
            </div>
            <div className="flex-1 space-y-1.5">
              <Label>API Base URL</Label>
              <Input
                value={sub.baseUrl}
                onChange={(e) => patch((c) => { c.ai[prov].baseUrl = e.target.value })}
                placeholder="留空用官方默认"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>API Key（软件内填写）</Label>
            <div className="flex gap-2">
              <Input
                type={showKey ? 'text' : 'password'}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="sk-...（留空则用环境变量）"
                autoComplete="off"
                className="flex-1"
              />
              <Button variant="outline" type="button" onClick={() => setShowKey((s) => !s)}>
                {showKey ? <EyeOff /> : <Eye />}
                {showKey ? '隐藏' : '显示'}
              </Button>
              <Button variant="outline" type="button" onClick={clearApiKey}>
                <Trash2 />
                清除
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              {apiKey ? '✓ 已填写' : '未填写，将使用环境变量'}
              {!keyAvailable && '（当前环境不支持系统加密，将以明文存储）'} · 环境变量{' '}
              <code className="rounded bg-muted px-1.5 py-0.5 font-mono">
                {prov === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY'}
              </code>
            </p>
          </div>
        </CardContent>
      </Card>

      {/* 生成参数 */}
      <Card>
        <CardHeader>
          <CardTitle>生成参数</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-4">
            <div className="flex-1 space-y-1.5">
              <Label>Temperature：{(sub.temperature ?? 0.3).toFixed(1)}</Label>
              <input
                type="range"
                min={0}
                max={100}
                value={tempPct}
                onChange={(e) => patch((c) => { c.ai[prov].temperature = Number(e.target.value) / 100 })}
                className="w-full accent-primary"
              />
            </div>
            <div className="min-w-[140px] space-y-1.5">
              <Label>最大输出 Token</Label>
              <Input
                type="number"
                value={sub.maxTokens}
                onChange={(e) => patch((c) => { c.ai[prov].maxTokens = Number(e.target.value) || 800 })}
              />
            </div>
            <div className="min-w-[140px] space-y-1.5">
              <Label>最大输入 Token</Label>
              <Input
                type="number"
                value={draft.ai.maxInputTokens}
                onChange={(e) => patch((c) => { c.ai.maxInputTokens = Number(e.target.value) || 6000 })}
              />
            </div>
          </div>
          <div className="flex flex-wrap gap-4">
            <div className="min-w-[120px] space-y-1.5">
              <Label>并发调用数</Label>
              <Input
                type="number"
                min={1}
                max={10}
                value={draft.ai.concurrency}
                onChange={(e) => patch((c) => { c.ai.concurrency = Number(e.target.value) || 3 })}
              />
            </div>
            <div className="min-w-[120px] space-y-1.5">
              <Label>重试次数</Label>
              <Input
                type="number"
                min={0}
                max={5}
                value={draft.ai.retries}
                onChange={(e) => patch((c) => { c.ai.retries = Number(e.target.value) || 3 })}
              />
            </div>
            <div className="min-w-[120px] space-y-1.5">
              <Label>超时（秒）</Label>
              <Input
                type="number"
                min={10}
                max={300}
                value={draft.ai.timeoutSeconds}
                onChange={(e) => patch((c) => { c.ai.timeoutSeconds = Number(e.target.value) || 60 })}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* 输出格式 */}
      <Card>
        <CardHeader>
          <CardTitle>输出格式</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-4">
            <div className="min-w-[160px] space-y-1.5">
              <Label>默认格式</Label>
              <Select value={draft.output.format} onValueChange={(v) => patch((c) => { c.output.format = v as Config['output']['format'] })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="text">text（推荐）</SelectItem>
                  <SelectItem value="md">md</SelectItem>
                  <SelectItem value="json">json</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="min-w-[160px] space-y-1.5">
              <Label>换行符</Label>
              <Select value={draft.output.newline} onValueChange={(v) => patch((c) => { c.output.newline = v as Config['output']['newline'] })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="CRLF">CRLF（Windows）</SelectItem>
                  <SelectItem value="LF">LF（macOS/Linux）</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <Separator />
          <div className="flex items-center justify-between">
            <div>
              <h4 className="text-sm font-semibold">附带 commit 列表</h4>
              <p className="text-xs text-muted-foreground">摘要后附 shortHash 列表</p>
            </div>
            <Switch
              checked={draft.output.withCommits}
              onCheckedChange={(v) => patch((c) => { c.output.withCommits = v })}
            />
          </div>
        </CardContent>
      </Card>

      {/* 云同步 WebDAV */}
      <Card className="border-l-4 border-l-sky-500">
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle className="flex items-center gap-2"><Cloud className="size-4" />云同步（WebDAV）</CardTitle>
          <Badge variant="secondary" className="bg-sky-500/10 text-sky-600 dark:text-sky-400">v1.2</Badge>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between py-2">
            <div>
              <h4 className="text-sm font-semibold">启用 WebDAV 同步</h4>
              <p className="text-xs text-muted-foreground">同步笔记、报告历史、AI 记忆、配置偏好到多台电脑</p>
            </div>
            <Switch
              checked={draft.webdav.enabled}
              onCheckedChange={(v) => patch((c) => { c.webdav.enabled = v })}
            />
          </div>
          <div className="flex flex-wrap gap-4">
            <div className="flex-[2] space-y-1.5">
              <Label>WebDAV 服务器 URL</Label>
              <Input
                value={draft.webdav.url}
                onChange={(e) => patch((c) => { c.webdav.url = e.target.value })}
                placeholder="https://dav.example.com/weeklog/"
                disabled={!draft.webdav.enabled}
              />
            </div>
            <div className="flex-1 space-y-1.5">
              <Label>用户名</Label>
              <Input
                value={draft.webdav.username}
                onChange={(e) => patch((c) => { c.webdav.username = e.target.value })}
                disabled={!draft.webdav.enabled}
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>密码（加密存储，不落配置文件）</Label>
            <div className="flex gap-2">
              <Input
                type={showWebdavPass ? 'text' : 'password'}
                value={webdavPassword}
                onChange={(e) => setWebdavPassword(e.target.value)}
                placeholder="••••••"
                autoComplete="off"
                disabled={!draft.webdav.enabled}
                className="flex-1"
              />
              <Button variant="outline" type="button" onClick={() => setShowWebdavPass((s) => !s)} disabled={!draft.webdav.enabled}>
                {showWebdavPass ? <EyeOff /> : <Eye />}
                {showWebdavPass ? '隐藏' : '显示'}
              </Button>
              <Button variant="outline" type="button" onClick={testWebdav} disabled={!draft.webdav.enabled || testingWebdav || !draft.webdav.url}>
                {testingWebdav ? <RefreshCw className="animate-spin" /> : <Zap />}
                测试
              </Button>
            </div>
          </div>
          <Separator />
          <div className="space-y-1.5">
            <Label>自动同步时机</Label>
            <Select
              value={draft.webdav.autoSync}
              onValueChange={(v) => patch((c) => { c.webdav.autoSync = v as Config['webdav']['autoSync'] })}
              disabled={!draft.webdav.enabled}
            >
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="both">启动拉取 + 退出推送（推荐）</SelectItem>
                <SelectItem value="pull">仅启动拉取</SelectItem>
                <SelectItem value="push">仅退出推送</SelectItem>
                <SelectItem value="off">关闭自动同步（仅手动）</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="default" type="button" onClick={() => syncNow('both')} disabled={!draft.webdav.enabled || syncingWebdav}>
              {syncingWebdav ? <RefreshCw className="animate-spin" /> : <RefreshCw />}
              立即同步（双向）
            </Button>
            <Button variant="outline" type="button" onClick={() => syncNow('pull')} disabled={!draft.webdav.enabled || syncingWebdav}>
              仅拉取
            </Button>
            <Button variant="outline" type="button" onClick={() => syncNow('push')} disabled={!draft.webdav.enabled || syncingWebdav}>
              仅推送
            </Button>
            {webdavStatus?.lastSync && (
              <span className="text-xs text-muted-foreground">
                最近同步：{new Date(webdavStatus.lastSync).toLocaleString()}
                {typeof webdavStatus.pulled === 'number' && `（拉取 ${webdavStatus.pulled}，推送 ${webdavStatus.pushed}）`}
              </span>
            )}
          </div>
        </CardContent>
      </Card>

      {/* AI 记忆系统 */}
      <Card className="border-l-4 border-l-amber-500">
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle className="flex items-center gap-2"><Brain className="size-4" />AI 记忆系统</CardTitle>
          <Badge variant="secondary" className="bg-amber-500/10 text-amber-600 dark:text-amber-400">v1.2</Badge>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between py-2">
            <div>
              <h4 className="text-sm font-semibold">启用 AI 记忆</h4>
              <p className="text-xs text-muted-foreground">自动整理压缩历史报告，写笔记时辅助推断项目与工作</p>
            </div>
            <Switch
              checked={draft.memory.enabled}
              onCheckedChange={(v) => patch((c) => { c.memory.enabled = v })}
            />
          </div>
          <div className="flex items-center justify-between py-2">
            <div>
              <h4 className="text-sm font-semibold">报告生成后自动产出记忆</h4>
              <p className="text-xs text-muted-foreground">每次生成报告后，AI 自动压缩为一条长期记忆</p>
            </div>
            <Switch
              checked={draft.memory.autoGenerate}
              onCheckedChange={(v) => patch((c) => { c.memory.autoGenerate = v })}
              disabled={!draft.memory.enabled}
            />
          </div>
          <div className="flex flex-wrap gap-4">
            <div className="min-w-[200px] space-y-1.5">
              <Label>Embedding 来源</Label>
              <Select
                value={draft.memory.embeddingSource}
                onValueChange={(v) => patch((c) => { c.memory.embeddingSource = v as Config['memory']['embeddingSource'] })}
                disabled={!draft.memory.enabled}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="local">本地模型（推荐，离线、隐私）</SelectItem>
                  <SelectItem value="api">API（OpenAI embedding）</SelectItem>
                </SelectContent>
              </Select>
              {draft.memory.embeddingSource === 'local' && (
                <p className="text-xs text-muted-foreground">首次使用需下载约 120MB 模型，之后离线缓存</p>
              )}
            </div>
            {draft.memory.embeddingSource === 'local' && (
              <div className="min-w-[200px] space-y-1.5">
                <Label>模型下载源</Label>
                <Select
                  value={draft.memory.modelSource}
                  onValueChange={(v) => patch((c) => { c.memory.modelSource = v as Config['memory']['modelSource'] })}
                  disabled={!draft.memory.enabled}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto">魔搭 ModelScope（国内推荐，自动）</SelectItem>
                    <SelectItem value="modelscope">魔搭 ModelScope</SelectItem>
                    <SelectItem value="huggingface">HuggingFace（国外）</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">国内网络建议用魔搭，下载更快</p>
              </div>
            )}
            <div className="min-w-[200px] space-y-1.5">
              <Label>本地 Embedding 模型</Label>
              <Input
                value={draft.memory.embeddingModel}
                onChange={(e) => patch((c) => { c.memory.embeddingModel = e.target.value })}
                disabled={!draft.memory.enabled || draft.memory.embeddingSource !== 'local'}
                placeholder="Xenova/multilingual-e5-small"
              />
            </div>
            <div className="min-w-[120px] space-y-1.5">
              <Label>检索条数 (topK)</Label>
              <Input
                type="number"
                min={1}
                max={20}
                value={draft.memory.topK}
                onChange={(e) => patch((c) => { c.memory.topK = Number(e.target.value) || 5 })}
                disabled={!draft.memory.enabled}
              />
            </div>
          </div>
          <Separator />
          <div className="flex flex-wrap items-center gap-2">
            <Dialog open={memDialogOpen} onOpenChange={setMemDialogOpen}>
              <DialogTrigger asChild>
                <Button variant="outline" type="button" disabled={!draft.memory.enabled}>
                  <Database />
                  查看记忆 ({memList.length || '…'})
                </Button>
              </DialogTrigger>
              <DialogContent className="max-h-[80vh] max-w-2xl overflow-y-auto">
                <DialogHeader>
                  <DialogTitle>AI 记忆库</DialogTitle>
                </DialogHeader>
                <div className="space-y-2">
                  {memQueue && memQueue.pending > 0 && (
                    <p className="text-xs text-amber-600 dark:text-amber-400">
                      ⏳ {memQueue.pending} 条记忆正在后台计算向量…
                    </p>
                  )}
                  {memList.length === 0 ? (
                    <p className="py-8 text-center text-sm text-muted-foreground">暂无记忆条目。生成报告后会自动积累。</p>
                  ) : (
                    memList.map((m) => (
                      <div key={m.id} className="rounded-md border p-3">
                        <div className="mb-1 flex items-center justify-between">
                          <span className="text-sm font-semibold">{m.project || '未分类'}</span>
                          <div className="flex items-center gap-2">
                            <Badge variant="secondary" className="text-xs">{m.date}</Badge>
                            {!m.embeddingReady && <Badge variant="outline" className="text-xs">向量待算</Badge>}
                            <Button variant="ghost" size="sm" type="button" onClick={() => removeMemory(m.id)}>
                              <Trash2 className="size-3" />
                            </Button>
                          </div>
                        </div>
                        <p className="text-sm text-foreground/80">{m.digest}</p>
                        {m.keywords.length > 0 && (
                          <div className="mt-1.5 flex flex-wrap gap-1">
                            {m.keywords.slice(0, 8).map((k, i) => (
                              <Badge key={i} variant="outline" className="text-xs">{k}</Badge>
                            ))}
                          </div>
                        )}
                      </div>
                    ))
                  )}
                </div>
              </DialogContent>
            </Dialog>
            <Button
              variant="outline"
              type="button"
              onClick={() => {
                if (confirm('将根据全部历史报告重新生成记忆（会调用 AI，耗时较长）。确定继续？')) rebuildMemory()
              }}
              disabled={!draft.memory.enabled || rebuildingMem}
            >
              {rebuildingMem ? <RefreshCw className="animate-spin" /> : <RefreshCw />}
              重建记忆
            </Button>
          </div>
        </CardContent>
      </Card>

      <div className="flex items-center gap-4">
        <Button size="lg" onClick={handleSave}>
          <Save />
          保存设置
        </Button>
      </div>
    </div>
  )
}

function KeyBadge({ hasKey }: { hasKey: boolean }) {
  return (
    <Badge variant={hasKey ? 'success' : 'warning'}>{hasKey ? 'Key 已配置' : 'Key 未配置'}</Badge>
  )
}
