import { useState, useEffect, useCallback } from 'react'
import { Eye, EyeOff, FolderOpen, Save, Trash2 } from 'lucide-react'
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
import { cn } from '@/lib/utils'
import type { Config } from '@/types/weeklog'

export function SettingsPage() {
  const { config, save } = useConfig()
  const [draft, setDraft] = useState<Config | null>(null)
  const [notesDirDisplay, setNotesDirDisplay] = useState('—')
  const [showKey, setShowKey] = useState(false)
  const [apiKey, setApiKey] = useState('')
  const [keyAvailable, setKeyAvailable] = useState(true)

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
    await save(draft)
    const sr = await api.shortcut.apply()
    if (sr && !sr.ok) toast.warning('快捷键可能被占用，已回退默认')
    else toast.success('设置已保存')
  }, [draft, apiKey, recorder.accel, save])

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
