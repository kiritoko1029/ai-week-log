import { useState, useEffect, useCallback, useMemo } from 'react'
import { Eye, EyeOff, FolderOpen, Save, Trash2, Cloud, Brain, RefreshCw, Zap, Database, Download, RotateCw, Loader2, CheckCircle2, AlertCircle, Cpu, Activity, ArchiveRestore, Globe, Bot, PlugZap } from 'lucide-react'
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
import { Tabs, TabsListUnderline, TabsTriggerUnderline, TabsContent } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'
import type { Config, MemoryIndexItem, MemoryStatus, WebdavStatus, MemoryQueueStatus, UpdateStatus, WebdavBackupInfo, McpStatus, IntegrationStatus, NoteSummaryConfig, WritingPreference } from '@/types/weeklog'

const AGENT_OPTIONS: { id: string; label: string }[] = [
  { id: 'codex', label: 'Codex' },
  { id: 'claude', label: 'Claude Code' },
  { id: 'zcode', label: 'ZCode' },
]

export function SettingsPage() {
  const { config, save, refresh: refreshConfig } = useConfig()
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
  const [webdavBusy, setWebdavBusy] = useState(false)
  const [backupDialogOpen, setBackupDialogOpen] = useState(false)
  const [backups, setBackups] = useState<WebdavBackupInfo[]>([])
  const [loadingBackups, setLoadingBackups] = useState(false)
  const [selectedBackup, setSelectedBackup] = useState('')

  // AI 连接测试状态
  const [testingAi, setTestingAi] = useState(false)

  // AI 记忆状态
  const [memList, setMemList] = useState<MemoryIndexItem[]>([])
  const [memQueue, setMemQueue] = useState<MemoryQueueStatus | null>(null)
  const [memStatus, setMemStatus] = useState<MemoryStatus | null>(null)
  const [rebuildingMem, setRebuildingMem] = useState(false)
  const [downloadingMemModel, setDownloadingMemModel] = useState(false)
  const [clearingMemModel, setClearingMemModel] = useState(false)
  const [memDialogOpen, setMemDialogOpen] = useState(false)

  // 写作偏好（报告生成注入）
  const [prefs, setPrefs] = useState<WritingPreference[]>([])
  const [newPref, setNewPref] = useState('')
  const loadPrefs = useCallback(async () => {
    try { setPrefs(await api.prefs.list()) } catch {}
  }, [])
  const addPref = useCallback(async () => {
    const rule = newPref.trim()
    if (!rule) return
    await api.prefs.add(rule)
    setNewPref('')
    await loadPrefs()
    toast.success('已添加写作偏好')
  }, [newPref, loadPrefs])
  const togglePref = useCallback(async (id: string, enabled: boolean) => {
    await api.prefs.toggle(id, enabled)
    await loadPrefs()
  }, [loadPrefs])
  const removePref = useCallback(async (id: string) => {
    await api.prefs.remove(id)
    await loadPrefs()
    toast.success('已删除')
  }, [loadPrefs])

  // 应用更新
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null)
  const [checkingUpdate, setCheckingUpdate] = useState(false)
  const [downloadingUpdate, setDownloadingUpdate] = useState(false)
  const [creatingLocalBackup, setCreatingLocalBackup] = useState(false)

  // AI 小记（Skill + MCP）：MCP 服务状态 + 一键集成
  const [mcpStatus, setMcpStatus] = useState<McpStatus | null>(null)
  const [integrationStatus, setIntegrationStatus] = useState<IntegrationStatus | null>(null)
  const [selectedAgents, setSelectedAgents] = useState<string[]>(['codex', 'claude', 'zcode'])
  const [installingAgents, setInstallingAgents] = useState(false)
  const [uninstallingAgents, setUninstallingAgents] = useState(false)
  const [testingNoteSummary, setTestingNoteSummary] = useState(false)

  const recorder = useShortcutRecorder(config?.ui?.quickNoteShortcut || 'CommandOrControl+Shift+L')

  useEffect(() => {
    if (config) setDraft(structuredClone(config))
  }, [config])

  // config 加载/保存后，把快捷键录制器基线同步到已保存值：避免首渲染时 config 尚空、
  // 录制器停留在默认值，进而被「未保存」检测误判。用户录制期间 config 不变，不会被打断。
  useEffect(() => {
    if (config) recorder.setAccel(config.ui?.quickNoteShortcut || 'CommandOrControl+Shift+L')
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    loadPrefs()
  }, [loadPrefs])

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

  const refreshIntegrationStatus = useCallback(() => {
    api.integration.status().then((s) => {
      setIntegrationStatus(s)
      setMcpStatus(s.mcp)
    }).catch(() => {})
  }, [])

  useEffect(() => {
    refreshIntegrationStatus()
  }, [refreshIntegrationStatus])

  const patch = useCallback((updater: (c: Config) => void) => {
    setDraft((prev) => {
      if (!prev) return prev
      const next = structuredClone(prev)
      updater(next)
      return next
    })
  }, [])

  // 是否存在未保存改动：配置草稿 / 快捷键 / 待保存的 API Key / WebDAV 密码 任一与已保存态不同。
  // 保存（handleSave）会一并持久化这几项，故都纳入比较；保存成功后 config 刷新 → draft 重置 → 归零。
  const dirty = useMemo(() => {
    if (!draft || !config) return false
    const savedShortcut = config.ui?.quickNoteShortcut || 'CommandOrControl+Shift+L'
    return (
      JSON.stringify(draft) !== JSON.stringify(config) ||
      recorder.accel !== savedShortcut ||
      apiKey.trim() !== '' ||
      webdavPassword !== ''
    )
  }, [draft, config, recorder.accel, apiKey, webdavPassword])

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
    refreshIntegrationStatus()
    if (sr && !sr.ok) toast.warning('快捷键可能被占用，已回退默认')
    else toast.success('设置已保存')
  }, [draft, apiKey, webdavPassword, recorder.accel, save, refreshIntegrationStatus])

  // WebDAV：测试连接
  const testWebdav = useCallback(async () => {
    if (!draft) return
    setTestingWebdav(true)
    try {
      const r = await api.webdav.test(draft.webdav.url, draft.webdav.username, webdavPassword)
      if (r.ok) toast.success(r.message)
      else toast.error('WebDAV 连接失败', { description: r.message })
    } catch (e: any) {
      toast.error('WebDAV 连接失败', { description: e?.message || '未知错误' })
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

  const loadBackups = useCallback(async () => {
    setLoadingBackups(true)
    try {
      const list = await api.webdav.listBackups()
      setBackups(list)
      if (!selectedBackup && list[0]) setSelectedBackup(list[0].name)
    } catch (e: any) {
      toast.error('读取备份列表失败', { description: e?.message || '未知错误' })
    } finally {
      setLoadingBackups(false)
    }
  }, [selectedBackup])

  const openBackupDialog = useCallback(() => {
    setBackupDialogOpen(true)
    loadBackups()
  }, [loadBackups])

  // WebDAV：立即备份
  const backupNow = useCallback(async () => {
    setWebdavBusy(true)
    try {
      if (draft) await save(draft)
      const r = await api.webdav.backupNow()
      await api.webdav.status().then(setWebdavStatus)
      toast.success('WebDAV 备份完成', {
        description: `${r.name}${typeof r.pruned === 'number' && r.pruned > 0 ? `，已清理 ${r.pruned} 份旧备份` : ''}`,
      })
    } catch (e: any) {
      await api.webdav.status().then(setWebdavStatus).catch(() => {})
      toast.error('WebDAV 备份失败', { description: e?.message || '未知错误' })
    } finally {
      setWebdavBusy(false)
    }
  }, [draft, save])

  // WebDAV：恢复备份
  const restoreBackup = useCallback(async () => {
    if (!selectedBackup) return
    if (!confirm(`恢复备份 ${selectedBackup}？当前本地数据会被该备份覆盖，恢复前会自动保存一份本机安全备份。`)) return
    setWebdavBusy(true)
    try {
      const r = await api.webdav.restoreBackup(selectedBackup)
      await api.webdav.status().then(setWebdavStatus)
      const nextCfg = await refreshConfig()
      setDraft(structuredClone(nextCfg))
      setBackupDialogOpen(false)
      toast.success('WebDAV 备份已恢复', {
        description: `恢复 ${r.restoredFiles} 个文件，本机安全备份：${r.safetyName}`,
      })
    } catch (e: any) {
      await api.webdav.status().then(setWebdavStatus).catch(() => {})
      toast.error('WebDAV 恢复失败', { description: e?.message || '未知错误' })
    } finally {
      setWebdavBusy(false)
    }
  }, [selectedBackup, refreshConfig])

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

  const downloadMemoryModel = useCallback(async () => {
    setDownloadingMemModel(true)
    try {
      const r = await api.memory.downloadModel()
      if (r.error || !r.ok) {
        toast.error(r.error || '模型下载失败')
      } else {
        toast.success('模型已下载', { description: r.sizeMB ? `${r.sizeMB}MB` : r.model })
        refreshMemStatus()
      }
    } catch (e: any) {
      toast.error('模型下载失败：' + (e?.message || '未知错误'))
    } finally {
      setDownloadingMemModel(false)
    }
  }, [refreshMemStatus])

  const openMemoryModelFolder = useCallback(async () => {
    try {
      const r = await api.memory.openModelFolder()
      if (!r.ok) toast.error('打开模型文件夹失败')
    } catch (e: any) {
      toast.error('打开模型文件夹失败：' + (e?.message || '未知错误'))
    }
  }, [])

  const clearMemoryModel = useCallback(async () => {
    if (!confirm('清理本地 Embedding 模型？之后需要手动重新下载，AI 记忆会降级为关键词检索。')) return
    setClearingMemModel(true)
    try {
      const r = await api.memory.clearModel()
      if (!r.ok) toast.error('清理模型失败')
      else {
        toast.success('模型已清理')
        refreshMemStatus()
      }
    } catch (e: any) {
      toast.error('清理模型失败：' + (e?.message || '未知错误'))
    } finally {
      setClearingMemModel(false)
    }
  }, [refreshMemStatus])

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

  const createLocalBackup = useCallback(async () => {
    setCreatingLocalBackup(true)
    try {
      const backupDir = await api.dialog.pickBackupFolder()
      if (!backupDir) return
      if (draft) await save(draft)
      const r = await api.localBackup.create(backupDir)
      toast.success('本地备份已保存到本地文件夹', {
        description: `${r.name} · ${(r.bytes / 1024).toFixed(1)} KB`,
      })
    } catch (e: any) {
      toast.error('本地备份失败', { description: e?.message || '未知错误' })
    } finally {
      setCreatingLocalBackup(false)
    }
  }, [draft, save])

  const toggleAgent = useCallback((agent: string) => {
    setSelectedAgents((prev) => (prev.includes(agent) ? prev.filter((a) => a !== agent) : [...prev, agent]))
  }, [])

  const testNoteSummary = useCallback(async () => {
    if (!draft) return
    setTestingNoteSummary(true)
    try {
      const r = await api.noteSummary.test(draft, apiKey.trim() || undefined)
      if (r.ok) toast.success('小记总结模型连接成功', { description: r.message })
      else toast.error('连接失败', { description: r.message })
    } catch (e: any) {
      toast.error('连接失败', { description: e?.message || '未知错误' })
    } finally {
      setTestingNoteSummary(false)
    }
  }, [draft, apiKey])

  const installIntegration = useCallback(async () => {
    if (!draft) return
    if (!selectedAgents.length) {
      toast.warning('请先勾选要安装的 agent')
      return
    }
    setInstallingAgents(true)
    try {
      await save(draft)
      const r = await api.integration.install(selectedAgents)
      const nextCfg = await refreshConfig()
      setDraft(structuredClone(nextCfg))
      refreshIntegrationStatus()
      if (r.ok) {
        toast.success('AI 小记集成已安装', { description: `已配置 skill + MCP：${selectedAgents.join('、')}` })
      } else {
        toast.error('部分 agent 安装失败', { description: r.error || '请展开各 agent 状态或查看日志' })
      }
    } catch (e: any) {
      toast.error('安装失败', { description: e?.message || '未知错误' })
    } finally {
      setInstallingAgents(false)
    }
  }, [draft, save, refreshConfig, refreshIntegrationStatus, selectedAgents])

  const uninstallIntegration = useCallback(async () => {
    if (!selectedAgents.length) {
      toast.warning('请先勾选要卸载的 agent')
      return
    }
    setUninstallingAgents(true)
    try {
      const r = await api.integration.uninstall(selectedAgents)
      refreshIntegrationStatus()
      if (r.ok) {
        toast.success('AI 小记集成已卸载', { description: `已处理：${selectedAgents.join('、')}` })
      } else {
        toast.error('部分 agent 卸载失败', { description: r.error || '请查看日志' })
      }
    } catch (e: any) {
      toast.error('卸载失败', { description: e?.message || '未知错误' })
    } finally {
      setUninstallingAgents(false)
    }
  }, [refreshIntegrationStatus, selectedAgents])

  if (!draft) {
    return <div className="py-8 text-center text-sm text-muted-foreground">加载配置中…</div>
  }

  const prov = draft.ai.provider
  const sub = draft.ai[prov]
  const tempPct = Math.round((sub.temperature ?? 0.3) * 100)

  return (
    <div className="space-y-6 pb-20">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">AI 与输出设置</h2>
        <p className="text-sm text-muted-foreground">配置 LLM 后端、笔记、输出格式、并发与容错策略</p>
      </div>

      <Tabs defaultValue="general">
        <TabsListUnderline>
          <TabsTriggerUnderline value="general">通用</TabsTriggerUnderline>
          <TabsTriggerUnderline value="notes">笔记</TabsTriggerUnderline>
          <TabsTriggerUnderline value="ai">AI</TabsTriggerUnderline>
          <TabsTriggerUnderline value="output">输出</TabsTriggerUnderline>
          <TabsTriggerUnderline value="data">数据与同步</TabsTriggerUnderline>
        </TabsListUnderline>

        <TabsContent value="general" className="space-y-6 pt-6">
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
        </TabsContent>

        <TabsContent value="notes" className="space-y-6 pt-6">
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

      {/* AI 小记（Skill + MCP） */}
      <Card className="border-l-4 border-l-fuchsia-500">
        <CardHeader className="flex-row items-start justify-between gap-3">
          <div className="space-y-1">
            <CardTitle>AI 小记（Skill + MCP）</CardTitle>
            <p className="text-xs text-muted-foreground">
              在 Codex / Claude Code / ZCode 中安装 weeklog-ai-note skill；对话收尾时把清洗后的对话经 MCP 发回 WeekLog，由“小记总结模型”总结成一条中文小记并进入待处理池，确认后写入正式笔记。
            </p>
          </div>
          <Badge variant={mcpStatus?.running ? 'success' : draft.mcp.enabled ? 'destructive' : 'secondary'}>
            {mcpStatus?.running ? 'MCP 运行中' : draft.mcp.enabled ? 'MCP 未运行' : 'MCP 未启用'}
          </Badge>
        </CardHeader>
        <CardContent className="space-y-5">
          {/* 本地 MCP 服务 */}
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div className="space-y-0.5">
                <h4 className="flex items-center gap-2 text-sm font-semibold"><PlugZap className="size-4" />本地 MCP 服务</h4>
                <p className="text-xs text-muted-foreground">仅监听 127.0.0.1 回环地址，使用 Bearer token 校验；各 agent 通过此地址回传对话。</p>
              </div>
              <Switch checked={draft.mcp.enabled} onCheckedChange={(v) => patch((c) => { c.mcp.enabled = v })} />
            </div>
            <div className="flex flex-wrap gap-4">
              <div className="min-w-[120px] space-y-1.5">
                <Label>本地端口</Label>
                <Input
                  type="number"
                  min={1024}
                  max={65535}
                  value={draft.mcp.port}
                  onChange={(e) => patch((c) => { c.mcp.port = Number(e.target.value) || 17300 })}
                />
              </div>
              <div className="min-w-[260px] flex-1 space-y-1.5">
                <Label>接口地址</Label>
                <p className="truncate rounded-md bg-muted px-3 py-2 font-mono text-xs">
                  {mcpStatus?.endpoint || `http://127.0.0.1:${draft.mcp.port}/mcp`}
                </p>
              </div>
            </div>
            {mcpStatus?.error && (
              <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
                {mcpStatus.error}
              </div>
            )}
          </div>

          <Separator />

          {/* 小记总结模型 */}
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div className="space-y-0.5">
                <h4 className="flex items-center gap-2 text-sm font-semibold"><Brain className="size-4" />小记总结模型</h4>
                <p className="text-xs text-muted-foreground">把对话总结成一条中文小记。留空字段回退主 AI 配置；可在“API Key”区单独设置 noteSummary 密钥。</p>
              </div>
              <Switch checked={draft.noteSummary.enabled} onCheckedChange={(v) => patch((c) => { c.noteSummary.enabled = v })} />
            </div>
            <div className="flex flex-wrap gap-4">
              <div className="min-w-[160px] space-y-1.5">
                <Label>提供商</Label>
                <Select
                  value={draft.noteSummary.provider || 'inherit'}
                  onValueChange={(v) => patch((c) => { c.noteSummary.provider = v === 'inherit' ? '' : (v as NoteSummaryConfig['provider']) })}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="inherit">跟随主 AI</SelectItem>
                    <SelectItem value="openai">OpenAI</SelectItem>
                    <SelectItem value="anthropic">Anthropic</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="min-w-[200px] flex-1 space-y-1.5">
                <Label>模型</Label>
                <Input
                  value={draft.noteSummary.model}
                  placeholder="留空回退主 AI 模型"
                  onChange={(e) => patch((c) => { c.noteSummary.model = e.target.value })}
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>Base URL（可选）</Label>
              <Input
                value={draft.noteSummary.baseUrl}
                placeholder="留空使用默认 / 主 AI 地址"
                onChange={(e) => patch((c) => { c.noteSummary.baseUrl = e.target.value })}
              />
            </div>
            <div className="flex flex-wrap gap-4">
              <div className="min-w-[120px] space-y-1.5">
                <Label>温度</Label>
                <Input
                  type="number"
                  step={0.1}
                  min={0}
                  max={2}
                  value={draft.noteSummary.temperature}
                  onChange={(e) => patch((c) => { c.noteSummary.temperature = Number(e.target.value) })}
                />
              </div>
              <div className="min-w-[120px] space-y-1.5">
                <Label>最大 token</Label>
                <Input
                  type="number"
                  min={1}
                  value={draft.noteSummary.maxTokens}
                  onChange={(e) => patch((c) => { c.noteSummary.maxTokens = Number(e.target.value) || 800 })}
                />
              </div>
              <div className="min-w-[160px] space-y-1.5">
                <Label>触发最小字符数</Label>
                <Input
                  type="number"
                  min={0}
                  value={draft.noteSummary.triggerMinChars}
                  onChange={(e) => patch((c) => { c.noteSummary.triggerMinChars = Number(e.target.value) || 0 })}
                />
              </div>
            </div>
            <div>
              <Button type="button" variant="outline" onClick={testNoteSummary} disabled={testingNoteSummary}>
                {testingNoteSummary ? <RefreshCw className="animate-spin" /> : <Zap />}
                测试连接
              </Button>
            </div>
          </div>

          <Separator />

          {/* 一键安装到 AI Agent */}
          <div className="space-y-3">
            <div className="space-y-0.5">
              <h4 className="flex items-center gap-2 text-sm font-semibold"><Bot className="size-4" />一键安装到 AI Agent</h4>
              <p className="text-xs text-muted-foreground">写入 skill 并在所选 agent 中注册 WeekLog MCP 服务；安装会自动清理旧版 hook 工件（修改前已备份原配置）。</p>
            </div>
            <div className="flex flex-wrap items-center gap-6 pt-1">
              {AGENT_OPTIONS.map((a) => {
                const st = integrationStatus?.agents?.[a.id]
                return (
                  <label key={a.id} className="flex cursor-pointer items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="size-4 accent-violet-600"
                      checked={selectedAgents.includes(a.id)}
                      onChange={() => toggleAgent(a.id)}
                    />
                    {a.label}
                    {st?.skillInstalled && st?.mcpRegistered ? (
                      <Badge variant="success">已安装</Badge>
                    ) : st?.skillInstalled || st?.mcpRegistered ? (
                      <Badge variant="secondary">部分</Badge>
                    ) : st?.present ? (
                      <Badge variant="secondary">未安装</Badge>
                    ) : (
                      <Badge variant="outline">未检测到</Badge>
                    )}
                  </label>
                )
              })}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" onClick={installIntegration} disabled={installingAgents || !selectedAgents.length}>
                {installingAgents ? <RefreshCw className="animate-spin" /> : <Zap />}
                一键安装
              </Button>
              <Button type="button" variant="outline" onClick={uninstallIntegration} disabled={uninstallingAgents || !selectedAgents.length}>
                {uninstallingAgents ? <RefreshCw className="animate-spin" /> : <Trash2 />}
                卸载
              </Button>
              <Button type="button" variant="ghost" onClick={refreshIntegrationStatus}>
                <RefreshCw />
                刷新状态
              </Button>
            </div>
          </div>

          <p className="text-xs text-muted-foreground">
            Token 仅保存在本机密钥存储中，不在界面展示明文。一键安装会把 endpoint + token 写入各 agent 的 skill 目录与 MCP 配置；对话总结在 WeekLog 内完成，API Key 不会外泄给 agent。
          </p>
        </CardContent>
      </Card>
        </TabsContent>

        <TabsContent value="ai" className="space-y-6 pt-6">
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

      {/* 写作偏好：报告生成时注入系统提示词 */}
      <Card>
        <CardHeader>
          <CardTitle>写作偏好</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-muted-foreground">
            AI 生成日报/周报时将严格遵守这些规则。在对话里润色报告后点「记住这个调整」也会自动写入此处。
          </p>
          <div className="flex gap-2">
            <Input
              value={newPref}
              onChange={(e) => setNewPref(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addPref()}
              placeholder="如：用「灰度发布」代替「上线」；不要以「完成了」开头"
            />
            <Button onClick={addPref} disabled={!newPref.trim()} className="bg-violet-600 text-white hover:bg-violet-600/90">
              添加
            </Button>
          </div>
          {prefs.length === 0 ? (
            <div className="rounded-md border border-dashed p-4 text-center text-xs text-muted-foreground">
              暂无写作偏好
            </div>
          ) : (
            <div className="space-y-2">
              {prefs.map((p) => (
                <div key={p.id} className="flex items-center gap-2 rounded-md border bg-card p-2.5">
                  <Switch checked={p.enabled} onCheckedChange={(v) => togglePref(p.id, v)} />
                  <span className={cn('flex-1 text-sm', !p.enabled && 'text-muted-foreground line-through')}>{p.rule}</span>
                  <Button variant="ghost" size="sm" onClick={() => removePref(p.id)} className="h-7 px-2 text-muted-foreground hover:text-destructive">
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
        </TabsContent>

        <TabsContent value="output" className="space-y-6 pt-6">
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
                  <SelectItem value="compact">紧凑文本（无换行）</SelectItem>
                  <SelectItem value="text">格式化文本（有换行，推荐）</SelectItem>
                  <SelectItem value="md">Markdown</SelectItem>
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
        </TabsContent>

        <TabsContent value="data" className="space-y-6 pt-6">
      {/* 本地备份 */}
      <Card className="border-l-4 border-l-emerald-500">
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Download className="size-4" />本地备份</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="space-y-1">
              <h4 className="text-sm font-semibold">下载备份到本机</h4>
              <p className="text-xs text-muted-foreground">生成包含笔记、报告历史、AI 记忆和配置偏好的 zip 文件，保存到系统下载目录</p>
            </div>
            <Button type="button" variant="outline" onClick={createLocalBackup} disabled={creatingLocalBackup}>
              {creatingLocalBackup ? <RefreshCw className="animate-spin" /> : <Download />}
              下载备份
            </Button>
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
          {draft.webdav.enabled && (
            <>
              <div className="flex flex-wrap gap-4">
                <div className="flex-[2] space-y-1.5">
                  <Label>WebDAV 服务器 URL</Label>
                  <Input
                    value={draft.webdav.url}
                    onChange={(e) => patch((c) => { c.webdav.url = e.target.value })}
                    placeholder="https://dav.example.com/weeklog/"
                  />
                </div>
                <div className="flex-1 space-y-1.5">
                  <Label>用户名</Label>
                  <Input
                    value={draft.webdav.username}
                    onChange={(e) => patch((c) => { c.webdav.username = e.target.value })}
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
                    className="flex-1"
                  />
                  <Button variant="outline" type="button" onClick={() => setShowWebdavPass((s) => !s)}>
                    {showWebdavPass ? <EyeOff /> : <Eye />}
                    {showWebdavPass ? '隐藏' : '显示'}
                  </Button>
                  <Button variant="outline" type="button" onClick={testWebdav} disabled={testingWebdav || !draft.webdav.url}>
                    {testingWebdav ? <RefreshCw className="animate-spin" /> : <Zap />}
                    测试
                  </Button>
                  <Button variant="outline" type="button" onClick={clearWebdavPassword} disabled={!hasStoredWebdavPassword}>
                    <Trash2 />
                    清除
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  {webdavPassword ? '✓ 已输入新密码，保存后生效' : hasStoredWebdavPassword ? '✓ 已保存密码（不回显明文）' : '未保存密码'}
                </p>
              </div>
              <Separator />
              <div className="grid gap-4 md:grid-cols-[1fr_180px]">
                <div className="space-y-1.5">
                  <Label>自动备份</Label>
                  <Select
                    value={draft.webdav.autoSync === 'off' ? 'off' : 'push'}
                    onValueChange={(v) => patch((c) => { c.webdav.autoSync = v as Config['webdav']['autoSync'] })}
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="push">退出时自动备份</SelectItem>
                      <SelectItem value="off">关闭自动备份（仅手动）</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label>保留备份数</Label>
                  <Input
                    type="number"
                    min={1}
                    max={99}
                    value={draft.webdav.backupRetention ?? 10}
                    onChange={(e) => patch((c) => { c.webdav.backupRetention = Math.max(1, Number(e.target.value) || 10) })}
                  />
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="default" type="button" onClick={backupNow} disabled={webdavBusy}>
                  {webdavBusy ? <RefreshCw className="animate-spin" /> : <Download />}
                  立即备份
                </Button>
                <Button variant="outline" type="button" onClick={openBackupDialog} disabled={webdavBusy}>
                  <ArchiveRestore />
                  恢复备份
                </Button>
                {webdavStatus?.lastBackup && (
                  <span className="text-xs text-muted-foreground">
                    最近备份：{new Date(webdavStatus.lastBackup).toLocaleString()}
                  </span>
                )}
                {webdavStatus?.lastRestore && (
                  <span className="text-xs text-muted-foreground">
                    最近恢复：{new Date(webdavStatus.lastRestore).toLocaleString()}
                  </span>
                )}
              </div>
              <Dialog open={backupDialogOpen} onOpenChange={setBackupDialogOpen}>
                <DialogContent className="max-h-[80vh] max-w-2xl overflow-y-auto">
                  <DialogHeader>
                    <DialogTitle>选择备份文件</DialogTitle>
                  </DialogHeader>
                  <div className="space-y-3">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-sm text-muted-foreground">选择一个远端压缩备份恢复到本机。</p>
                      <Button variant="outline" size="sm" type="button" onClick={loadBackups} disabled={loadingBackups}>
                        <RefreshCw className={cn('size-3', loadingBackups && 'animate-spin')} />
                        刷新
                      </Button>
                    </div>
                    {backups.length === 0 ? (
                      <div className="rounded-md border p-8 text-center text-sm text-muted-foreground">
                        {loadingBackups ? '正在读取备份列表…' : '暂无远端备份'}
                      </div>
                    ) : (
                      <div className="space-y-2">
                        {backups.map((item) => (
                          <label
                            key={item.name}
                            className={cn(
                              'flex cursor-pointer items-start gap-3 rounded-md border p-3 transition-colors hover:bg-muted/50',
                              selectedBackup === item.name && 'border-primary bg-primary/5'
                            )}
                          >
                            <input
                              type="radio"
                              className="mt-1"
                              checked={selectedBackup === item.name}
                              onChange={() => setSelectedBackup(item.name)}
                            />
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="truncate font-mono text-xs font-medium">{item.name}</span>
                                {item.deviceName && <Badge variant="secondary">{item.deviceName}</Badge>}
                              </div>
                              <p className="mt-1 text-xs text-muted-foreground">
                                {(item.createdAt || item.lastModified) ? new Date(item.createdAt || item.lastModified).toLocaleString() : '未知时间'}
                                {item.size ? ` · ${(item.size / 1024).toFixed(1)} KB` : ''}
                              </p>
                            </div>
                          </label>
                        ))}
                      </div>
                    )}
                    <div className="flex justify-end gap-2">
                      <Button variant="outline" type="button" onClick={() => setBackupDialogOpen(false)}>取消</Button>
                      <Button type="button" onClick={restoreBackup} disabled={!selectedBackup || webdavBusy}>
                        {webdavBusy ? <RefreshCw className="animate-spin" /> : <ArchiveRestore />}
                        恢复备份
                      </Button>
                    </div>
                  </div>
                </DialogContent>
              </Dialog>
            </>
          )}
        </CardContent>
      </Card>

      {/* 网络代理 */}
      <Card className="border-l-4 border-l-indigo-500">
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Globe className="size-4" />网络代理</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <RadioGroup
            value={draft.proxy?.mode ?? 'system'}
            onValueChange={(v) => patch((c) => { c.proxy = { ...(c.proxy || { mode: 'system', url: '' }), mode: v as Config['proxy']['mode'] } })}
            className="grid gap-2"
          >
            <div className="flex items-center gap-2">
              <RadioGroupItem value="system" id="proxy-mode-system" />
              <Label htmlFor="proxy-mode-system" className="cursor-pointer font-normal">跟随系统代理（默认）</Label>
            </div>
            <div className="flex items-center gap-2">
              <RadioGroupItem value="custom" id="proxy-mode-custom" />
              <Label htmlFor="proxy-mode-custom" className="cursor-pointer font-normal">自定义代理</Label>
            </div>
            <div className="flex items-center gap-2">
              <RadioGroupItem value="off" id="proxy-mode-off" />
              <Label htmlFor="proxy-mode-off" className="cursor-pointer font-normal">关闭（直连）</Label>
            </div>
          </RadioGroup>

          {(draft.proxy?.mode ?? 'system') === 'custom' && (
            <div className="space-y-1.5">
              <Label>代理 URL</Label>
              <Input
                value={draft.proxy?.url ?? ''}
                onChange={(e) => patch((c) => { c.proxy = { ...(c.proxy || { mode: 'custom', url: '' }), url: e.target.value } })}
                placeholder="http://127.0.0.1:7890"
                className="font-mono"
              />
              <p className="text-xs leading-relaxed text-muted-foreground">
                支持 http / https / socks 代理。可含凭证：<code className="rounded bg-muted px-1 py-0.5 font-mono">http://user:pass@host:port</code>
              </p>
            </div>
          )}

          {(draft.proxy?.mode ?? 'system') === 'system' && (
            <p className="text-xs leading-relaxed text-muted-foreground">
              读取系统环境变量 <code className="rounded bg-muted px-1 py-0.5 font-mono">HTTPS_PROXY</code> / <code className="rounded bg-muted px-1 py-0.5 font-mono">HTTP_PROXY</code>；未设置时直连。Clash / V2Ray 等通常会自动设置这些变量。
            </p>
          )}

          <p className="text-xs leading-relaxed text-muted-foreground">
            覆盖 AI 对话、模型下载、应用更新检查、WebDAV 同步等所有出站请求。保存后立即生效。
          </p>
        </CardContent>
      </Card>

      {/* AI 记忆系统 */}
      <Card className="border-l-4 border-l-amber-500">
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Brain className="size-4" />AI 记忆系统</CardTitle>
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
          {draft.memory.enabled && (
            <>
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
                              : '⚠ 未下载（模型不会自动下载）'
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
                      {memStatus?.source === 'local' && (
                        <div className="flex flex-wrap gap-1.5 pt-1">
                          <Button
                            variant="outline"
                            size="sm"
                            type="button"
                            className="h-7 px-2 text-xs"
                            onClick={downloadMemoryModel}
                            disabled={downloadingMemModel}
                          >
                            {downloadingMemModel ? <Loader2 className="size-3 animate-spin" /> : <Download className="size-3" />}
                            下载模型
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            type="button"
                            className="h-7 px-2 text-xs"
                            onClick={openMemoryModelFolder}
                          >
                            <FolderOpen className="size-3" />
                            打开模型文件夹
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            type="button"
                            className="h-7 px-2 text-xs text-destructive hover:text-destructive"
                            onClick={clearMemoryModel}
                            disabled={clearingMemModel || !memStatus.modelReady}
                          >
                            {clearingMemModel ? <Loader2 className="size-3 animate-spin" /> : <Trash2 className="size-3" />}
                            清理模型
                          </Button>
                        </div>
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
                  <h4 className="text-sm font-semibold">报告生成后自动产出记忆</h4>
                  <p className="text-xs text-muted-foreground">每次生成报告后，AI 自动压缩为一条长期记忆</p>
                </div>
                <Switch
                  checked={draft.memory.autoGenerate}
                  onCheckedChange={(v) => patch((c) => { c.memory.autoGenerate = v })}
                />
              </div>
              <div className="flex flex-wrap gap-4">
                <div className="min-w-[200px] space-y-1.5">
                  <Label>Embedding 来源</Label>
                  <Select
                    value={draft.memory.embeddingSource}
                    onValueChange={(v) => patch((c) => { c.memory.embeddingSource = v as Config['memory']['embeddingSource'] })}
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
                    disabled={draft.memory.embeddingSource !== 'local'}
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
                  />
                </div>
              </div>
              <Separator />
              <div className="flex flex-wrap items-center gap-2">
                <Dialog open={memDialogOpen} onOpenChange={setMemDialogOpen}>
                  <DialogTrigger asChild>
                    <Button variant="outline" type="button">
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
                  disabled={rebuildingMem}
                >
                  {rebuildingMem ? <RefreshCw className="animate-spin" /> : <RefreshCw />}
                  重建记忆
                </Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>
        </TabsContent>
      </Tabs>

      <div className="fixed bottom-12 right-8 z-30 flex items-center gap-2">
        {dirty && (
          <span className="flex items-center gap-1.5 rounded-full bg-amber-100 px-2.5 py-1 text-xs font-medium text-amber-700 shadow-sm dark:bg-amber-950/60 dark:text-amber-300">
            <span className="size-1.5 animate-pulse rounded-full bg-amber-500" />
            有未保存的修改
          </span>
        )}
        <Button
          onClick={handleSave}
          className={cn(
            'shadow-sm transition-colors',
            dirty && 'bg-amber-600 text-white ring-2 ring-amber-400/60 hover:bg-amber-600/90'
          )}
        >
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
