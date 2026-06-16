import { useState, useEffect, useCallback } from 'react'
import { Eye, EyeOff, FolderOpen, Save, Trash2, Cloud, Brain, RefreshCw, Zap, Database, Download, RotateCw, Loader2, CheckCircle2, AlertCircle, Cpu, Activity } from 'lucide-react'
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
import type { Config, MemoryIndexItem, MemoryStatus, WebdavStatus, MemoryQueueStatus, UpdateStatus } from '@/types/weeklog'

export function SettingsPage() {
  const { config, save } = useConfig()
  const [draft, setDraft] = useState<Config | null>(null)
  const [notesDirDisplay, setNotesDirDisplay] = useState('—')
  const [showKey, setShowKey] = useState(false)
  const [apiKey, setApiKey] = useState('')
  const [hasStoredKey, setHasStoredKey] = useState(false)
  const [keyAvailable, setKeyAvailable] = useState(true)

  // WebDAV 同步状态
  const [webdavPassword, setWebdavPassword] = useState('')
  const [hasStoredWebdavPassword, setHasStoredWebdavPassword] = useState(false)
  const [showWebdavPass, setShowWebdavPass] = useState(false)
  const [webdavStatus, setWebdavStatus] = useState<WebdavStatus | null>(null)
  const [testingWebdav, setTestingWebdav] = useState(false)
  const [syncingWebdav, setSyncingWebdav] = useState(false)

  // AI 连接测试状态
  const [testingAi, setTestingAi] = useState(false)

  // AI 记忆状态
  const [memList, setMemList] = useState<MemoryIndexItem[]>([])
  const [memQueue, setMemQueue] = useState<MemoryQueueStatus | null>(null)
  const [memStatus, setMemStatus] = useState<MemoryStatus | null>(null)
  const [rebuildingMem, setRebuildingMem] = useState(false)
  const [memDialogOpen, setMemDialogOpen] = useState(false)

  // 应用更新
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null)
  const [checkingUpdate, setCheckingUpdate] = useState(false)
  const [downloadingUpdate, setDownloadingUpdate] = useState(false)

  const recorder = useShortcutRecorder(config?.ui?.quickNoteShortcut || 'CommandOrControl+Shift+L')

  useEffect(() => {
    if (config) setDraft(structuredClone(config))
  }, [config])

  // 加载当前 provider 的 API Key + notesDir
  useEffect(() => {
    if (!draft) return
    api.secrets.status(draft.ai.provider).then((r) => {
      setHasStoredKey(r.hasKey)
      setKeyAvailable(r.available)
    })
    setApiKey('')
    api.config.notesDir().then(setNotesDirDisplay)
  }, [draft?.ai?.provider])

  // 加载 WebDAV 密码 + 同步状态
  useEffect(() => {
    api.webdav.passwordStatus().then((r) => setHasStoredWebdavPassword(r.hasPassword))
    api.webdav.status().then(setWebdavStatus)
  }, [])

  // 加载记忆列表 + 队列状态（记忆弹窗打开时刷新）
  useEffect(() => {
    if (memDialogOpen) {
      api.memory.list().then(setMemList)
      api.memory.queueStatus().then(setMemQueue)
    }
  }, [memDialogOpen])

  // 加载记忆系统状态（模型/向量化摘要）
  const refreshMemStatus = useCallback(() => {
    api.memory.status().then(setMemStatus).catch(() => {})
  }, [])
  useEffect(() => {
    refreshMemStatus()
  }, [refreshMemStatus])

  useEffect(() => {
    api.updates.status().then(setUpdateStatus).catch(() => {})
    const off = api.updates.onUpdate((payload) => {
      if (payload.type === 'status') setUpdateStatus(payload.status)
    })
    return off
  }, [])

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
      // 切换 provider 后只刷新配置状态，不回显已保存密钥
      api.secrets.status(p).then((r) => {
        setHasStoredKey(r.hasKey)
        setKeyAvailable(r.available)
      })
      setApiKey('')
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
    setHasStoredKey(false)
    toast.success('API Key 已清除')
  }, [draft])

  const clearWebdavPassword = useCallback(async () => {
    await api.webdav.clearPassword()
    setWebdavPassword('')
    setHasStoredWebdavPassword(false)
    toast.success('WebDAV 密码已清除')
  }, [])

  const handleSave = useCallback(async () => {
    if (!draft) return
    draft.ui = draft.ui || { theme: 'auto', quickNoteShortcut: recorder.accel }
    draft.ui.quickNoteShortcut = recorder.accel
    // API Key：只在用户输入新值时写入，避免从主进程回读明文
    if (apiKey.trim()) {
      await api.secrets.set(draft.ai.provider, apiKey)
      setHasStoredKey(true)
      setApiKey('')
    }
    // WebDAV 密码：只在用户输入新值时写入，避免从主进程回读明文
    if (webdavPassword.trim()) {
      await api.webdav.savePassword(webdavPassword)
      setHasStoredWebdavPassword(true)
      setWebdavPassword('')
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

  // AI：测试连接（用当前编辑中的配置 + 输入框的 Key，无需先保存）
  const testAi = useCallback(async () => {
    if (!draft) return
    setTestingAi(true)
    try {
      const r = await api.ai.test(draft, apiKey)
      if (r.ok) toast.success(r.message)
      else toast.error('连接失败', { description: r.message })
    } catch (e: any) {
      toast.error('测试失败：' + (e?.message || '未知错误'))
    } finally {
      setTestingAi(false)
    }
  }, [draft, apiKey])

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
        refreshMemStatus()
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

  const checkForUpdates = useCallback(async () => {
    setCheckingUpdate(true)
    try {
      const r = await api.updates.check()
      setUpdateStatus(r)
      if (r.phase === 'available') toast.success(`发现新版本 ${r.latestVersion || ''}`.trim())
      else if (r.phase === 'not-available') toast.success('当前已是最新版本')
      else if (r.phase === 'disabled') toast.info(r.error || '自动更新仅在安装包版本中可用')
      else if (r.phase === 'error') toast.error(r.error || '检查更新失败')
    } catch (e: any) {
      toast.error('检查更新失败：' + (e?.message || '未知错误'))
    } finally {
      setCheckingUpdate(false)
    }
  }, [])

  const downloadUpdate = useCallback(async () => {
    setDownloadingUpdate(true)
    try {
      const r = await api.updates.download()
      setUpdateStatus(r)
      if (r.phase === 'downloaded') toast.success('更新已下载，重启后安装')
    } catch (e: any) {
      toast.error('下载更新失败：' + (e?.message || '未知错误'))
    } finally {
      setDownloadingUpdate(false)
    }
  }, [])

  const installUpdate = useCallback(async () => {
    try {
      await api.updates.install()
    } catch (e: any) {
      toast.error('安装更新失败：' + (e?.message || '未知错误'))
    }
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
        <CardHeader>
          <CardTitle>界面与快捷键</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 gap-x-10 gap-y-6 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>主题外观</Label>
              <ThemeToggle className="flex h-9 w-fit p-1" />
              <p className="text-xs leading-relaxed text-muted-foreground">深色模式更护眼；「跟随系统」随操作系统切换</p>
            </div>
            <div className="space-y-2">
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
              <p className="text-xs leading-relaxed text-muted-foreground">全局生效（含最小化到托盘时）。需含 Ctrl / Alt / Shift 至少一个修饰键</p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* 应用更新 */}
      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle>应用更新</CardTitle>
          <Badge variant={updateStatus?.phase === 'available' ? 'success' : updateStatus?.phase === 'error' ? 'destructive' : 'secondary'}>
            {updateStatus ? updatePhaseLabel(updateStatus.phase) : '读取中'}
          </Badge>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-6">
            <div className="min-w-[180px] space-y-1.5">
              <Label>当前版本</Label>
              <p className="font-mono text-sm">{updateStatus?.currentVersion || '—'}</p>
            </div>
            <div className="min-w-[180px] space-y-1.5">
              <Label>最新版本</Label>
              <p className="font-mono text-sm">{updateStatus?.latestVersion || '—'}</p>
            </div>
            <div className="min-w-[220px] flex-1 space-y-1.5">
              <Label>状态</Label>
              <p className="text-sm text-muted-foreground">{updateStatusText(updateStatus)}</p>
            </div>
          </div>
          {updateStatus?.phase === 'downloading' && updateStatus.progress && (
            <div className="space-y-1.5">
              <div className="h-2 overflow-hidden rounded-full bg-muted">
                <div className="h-full bg-primary transition-all" style={{ width: `${Math.round(updateStatus.progress.percent || 0)}%` }} />
              </div>
              <p className="text-xs text-muted-foreground">下载进度 {Math.round(updateStatus.progress.percent || 0)}%</p>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="outline" className="min-w-[8.5rem]" onClick={checkForUpdates} disabled={checkingUpdate || !updateStatus?.canCheck}>
              {checkingUpdate || updateStatus?.phase === 'checking' ? <RefreshCw className="animate-spin" /> : <RefreshCw />}
              检查更新
            </Button>
            <Button type="button" variant="outline" className="min-w-[8.5rem]" onClick={downloadUpdate} disabled={downloadingUpdate || !updateStatus?.canDownload}>
              {downloadingUpdate || updateStatus?.phase === 'downloading' ? <Download className="animate-pulse" /> : <Download />}
              下载更新
            </Button>
            <Button type="button" className="min-w-[8.5rem]" onClick={installUpdate} disabled={!updateStatus?.canInstall}>
              <RotateCw />
              {typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '退出并安装' : '重启安装'}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* 笔记配置 */}
      <Card className="border-l-4 border-l-violet-500">
        <CardHeader>
          <CardTitle>笔记配置</CardTitle>
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
          <KeyBadge hasKey={hasStoredKey || !!apiKey} />
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
                placeholder={hasStoredKey ? '已保存；输入新 Key 可替换' : 'sk-...（留空则用环境变量）'}
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
              <Button variant="outline" type="button" onClick={testAi} disabled={testingAi}>
                {testingAi ? <RefreshCw className="animate-spin" /> : <Zap />}
                测试连接
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              {apiKey ? '✓ 已输入新 Key，保存后生效' : hasStoredKey ? '✓ 已保存 Key（不回显明文）' : '未填写，将使用环境变量'}
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
          {/* 常用：输出长度与并发，绝大多数用户只需调这两个 */}
          <div className="flex flex-wrap gap-4">
            <div className="min-w-[140px] space-y-1.5">
              <Label>最大输出 Token</Label>
              <Input
                type="number"
                value={sub.maxTokens}
                onChange={(e) => patch((c) => { c.ai[prov].maxTokens = Number(e.target.value) || 800 })}
              />
              <p className="text-xs text-muted-foreground">单次生成的输出上限（Anthropic 必填）</p>
            </div>
            <div className="min-w-[120px] space-y-1.5">
              <Label>并发调用数</Label>
              <Input
                type="number"
                min={1}
                max={10}
                value={draft.ai.concurrency}
                onChange={(e) => patch((c) => { c.ai.concurrency = Number(e.target.value) || 3 })}
              />
              <p className="text-xs text-muted-foreground">同时发起的 LLM 请求数，越大生成越快</p>
            </div>
          </div>
          {/* 高级：Temperature / 重试 / 超时，通常无需调整，默认收起 */}
          <details className="group rounded-md border border-border/60">
            <summary className="flex cursor-pointer select-none items-center justify-between px-4 py-3 text-sm font-medium text-muted-foreground hover:bg-muted/40">
              <span>高级选项</span>
              <span className="text-xs">Temperature · 重试 · 超时</span>
            </summary>
            <div className="space-y-4 border-t border-border/60 px-4 py-4">
              <div className="space-y-1.5">
                <Label>Temperature：{(sub.temperature ?? 0.3).toFixed(1)}</Label>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={tempPct}
                  onChange={(e) => patch((c) => { c.ai[prov].temperature = Number(e.target.value) / 100 })}
                  className="w-full accent-primary"
                />
                <p className="text-xs text-muted-foreground">越高越随机，越低越确定；周报建议 0.3</p>
              </div>
              <div className="flex flex-wrap gap-4">
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
            </div>
          </details>
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
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Cloud className="size-4" />云同步（WebDAV）</CardTitle>
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
                placeholder={hasStoredWebdavPassword ? '已保存；输入新密码可替换' : '••••••'}
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
              <Button variant="outline" type="button" onClick={clearWebdavPassword} disabled={!draft.webdav.enabled || !hasStoredWebdavPassword}>
                <Trash2 />
                清除
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              {webdavPassword ? '✓ 已输入新密码，保存后生效' : hasStoredWebdavPassword ? '✓ 已保存密码（不回显明文）' : '未保存密码'}
            </p>
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
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Brain className="size-4" />AI 记忆系统</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* 模型与向量化状态摘要 */}
          <div className="rounded-md border bg-muted/30 p-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">运行状态</span>
              <Button variant="ghost" size="sm" type="button" onClick={refreshMemStatus} className="h-6 px-2 text-xs">
                <RefreshCw className="size-3" />
                刷新
              </Button>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {/* 模型状态 */}
              <div className="flex items-start gap-2">
                {memStatus ? (
                  memStatus.source === 'local' ? (
                    memStatus.modelReady ? (
                      <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-500" />
                    ) : (
                      <AlertCircle className="mt-0.5 size-4 shrink-0 text-amber-500" />
                    )
                  ) : (
                    <Cpu className="mt-0.5 size-4 shrink-0 text-sky-500" />
                  )
                ) : (
                  <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin text-muted-foreground" />
                )}
                <div className="min-w-0 space-y-0.5">
                  <p className="text-xs font-medium text-foreground">
                    {memStatus ? (memStatus.source === 'local' ? '本地模型' : 'API 模型') : '模型状态'}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {memStatus ? (
                      memStatus.source === 'local' ? (
                        memStatus.modelReady
                          ? `✓ 已就绪 · ${memStatus.modelSizeMB}MB`
                          : '⚠ 未下载（首次生成报告后自动下载）'
                      ) : (
                        `OpenAI Embedding · ${memStatus.model.replace('Xenova/', '')}`
                      )
                    ) : '读取中…'}
                  </p>
                  {memStatus && (
                    <p className="truncate text-[11px] text-muted-foreground/70" title={memStatus.model}>
                      {memStatus.model}
                    </p>
                  )}
                </div>
              </div>
              {/* 向量化进度 */}
              <div className="flex items-start gap-2">
                <Activity className="mt-0.5 size-4 shrink-0 text-violet-500" />
                <div className="min-w-0 flex-1 space-y-0.5">
                  <p className="text-xs font-medium text-foreground">向量化进度</p>
                  {memStatus ? (
                    memStatus.total > 0 ? (
                      <>
                        <p className="text-xs text-muted-foreground">
                          {memStatus.embedded}/{memStatus.total} 条已完成
                          {memStatus.dim > 0 && ` · ${memStatus.dim} 维`}
                        </p>
                        <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                          <div
                            className="h-full bg-violet-500 transition-all"
                            style={{ width: `${Math.round((memStatus.embedded / memStatus.total) * 100)}%` }}
                          />
                        </div>
                      </>
                    ) : (
                      <p className="text-xs text-muted-foreground">暂无记忆，生成报告后自动积累</p>
                    )
                  ) : (
                    <p className="text-xs text-muted-foreground">读取中…</p>
                  )}
                </div>
              </div>
            </div>
          </div>
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
                  <SelectItem value="auto">自动（探测魔搭，不通则回退 HF）</SelectItem>
                  <SelectItem value="modelscope">魔搭 ModelScope（国内更快）</SelectItem>
                  <SelectItem value="huggingface">HuggingFace（国外）</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">国内网络建议用魔搭或自动；首次下载约 120MB</p>
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
                    <p className="flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400">
                      <Loader2 className="size-3 animate-spin" />
                      {memQueue.pending} 条记忆正在后台计算向量…
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
        <Button onClick={handleSave}>
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

function updatePhaseLabel(phase: UpdateStatus['phase']) {
  const labels: Record<UpdateStatus['phase'], string> = {
    disabled: '不可用',
    idle: '待检查',
    checking: '检查中',
    available: '有更新',
    'not-available': '已最新',
    downloading: '下载中',
    downloaded: '待安装',
    error: '失败',
  }
  return labels[phase]
}

function updateStatusText(status: UpdateStatus | null) {
  if (!status) return '正在读取更新状态…'
  if (status.error) return status.error
  if (status.phase === 'available') return `发现新版本 ${status.latestVersion || ''}，可以下载更新。`
  if (status.phase === 'downloaded') {
    const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
    return isMac ? '更新已下载完成，点击「退出并安装」将关闭应用并自动完成安装。' : '更新已下载完成，重启应用后安装。'
  }
  if (status.phase === 'downloading') return `正在下载更新 ${Math.round(status.progress?.percent || 0)}%。`
  if (status.phase === 'checking') return '正在检查是否有新版本。'
  if (status.phase === 'not-available') return '当前版本已是最新。'
  return '可以手动检查是否有新版本。'
}
