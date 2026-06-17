import { useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { useConfig } from '@/hooks/useConfig'
import { useNav } from '@/hooks/useNav'
import { cn } from '@/lib/utils'
import { AlertCircle, CheckCircle2, Download, GitBranch, KeyRound, RefreshCw, Sparkles } from 'lucide-react'
import { TaskIndicator } from '@/components/TaskIndicator'
import { GithubIcon } from '@/components/GithubIcon'
import type { UpdateStatus } from '@/types/weeklog'

export function Statusbar() {
  const { config } = useConfig()
  const { navigate } = useNav()
  const [gitOk, setGitOk] = useState<boolean | null>(null)
  const [keyOk, setKeyOk] = useState<boolean | null>(null)
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null)

  useEffect(() => {
    api.env.gitOk().then(setGitOk).catch(() => setGitOk(false))
  }, [])

  useEffect(() => {
    if (!config) return
    api.env.apiKeyStatus().then(setKeyOk).catch(() => setKeyOk(false))
  }, [config])

  useEffect(() => {
    api.updates.status().then(setUpdateStatus).catch(() => {})
    const off = api.updates.onUpdate((payload) => {
      if (payload.type === 'status') setUpdateStatus(payload.status)
    })
    return off
  }, [])

  const prov = config?.ai.provider ?? '—'
  const model = config ? config.ai[config.ai.provider].model : '—'
  const repoCount = config?.repos.length ?? 0
  const updateText = statusbarUpdateText(updateStatus)
  const UpdateIcon = statusbarUpdateIcon(updateStatus)

  return (
    <footer className="flex h-8 items-center gap-3 border-t bg-background/80 px-4 text-xs text-muted-foreground backdrop-blur font-mono">
      <span className="flex items-center gap-1.5">
        <span
          className={cn(
            'inline-block h-1.5 w-1.5 rounded-full',
            gitOk ? 'bg-emerald-500' : gitOk === false ? 'bg-red-500' : 'bg-muted-foreground'
          )}
        />
        {gitOk ? `${repoCount} 个仓库 · git 就绪` : gitOk === false ? 'git 不可用（请安装 git）' : '检测中…'}
      </span>
      <span className="text-border">·</span>
      <span className="flex items-center gap-1">
        <GitBranch className="h-3 w-3" />
        {prov}
      </span>
      <span className="text-border">·</span>
      <span>{model}</span>
      <span className="text-border">·</span>
      <span className="flex items-center gap-1">
        <KeyRound className="h-3 w-3" />
        {keyOk ? 'Key 已配置' : keyOk === false ? 'Key 未配置' : '检测中'}
      </span>
      {config?.notes.enabled && (
        <>
          <span className="text-border">·</span>
          <span className="text-violet-500 dark:text-violet-400">笔记已开启</span>
        </>
      )}
      <span className="ml-auto flex items-center gap-3">
        <TaskIndicator />
        <span>WeekLog v{__APP_VERSION__}</span>
        {updateText && UpdateIcon && (
          <button
            data-app-region="no-drag"
            onClick={() => navigate('settings')}
            className={cn(
              'inline-flex h-5 items-center gap-1 rounded border px-1.5 text-[10px] transition-colors',
              statusbarUpdateTone(updateStatus)
            )}
            title="打开设置页查看应用更新"
            aria-label="打开设置页查看应用更新"
          >
            <UpdateIcon className={cn('h-3 w-3', updateStatus?.phase === 'checking' && 'animate-spin')} />
            <span>{updateText}</span>
          </button>
        )}
        <button
          data-app-region="no-drag"
          onClick={() => api.shell.openExternal('https://github.com/kiritoko1029/ai-week-log')}
          className="text-muted-foreground transition-colors hover:text-foreground"
          title="GitHub 仓库"
          aria-label="GitHub 仓库"
        >
          <GithubIcon className="h-3.5 w-3.5" />
        </button>
      </span>
    </footer>
  )
}

function statusbarUpdateText(status: UpdateStatus | null) {
  if (!status) return ''
  if (status.phase === 'checking') return '检查更新'
  if (status.phase === 'available') return status.latestVersion ? `发现 v${status.latestVersion}` : '发现更新'
  if (status.phase === 'downloading') return `${Math.round(status.progress?.percent || 0)}%`
  if (status.phase === 'downloaded') return '待安装'
  if (status.phase === 'error') return '更新失败'
  return ''
}

function statusbarUpdateIcon(status: UpdateStatus | null) {
  if (!status) return null
  if (status.phase === 'checking') return RefreshCw
  if (status.phase === 'available') return Sparkles
  if (status.phase === 'downloading') return Download
  if (status.phase === 'downloaded') return CheckCircle2
  if (status.phase === 'error') return AlertCircle
  return null
}

function statusbarUpdateTone(status: UpdateStatus | null) {
  if (status?.phase === 'available' || status?.phase === 'downloaded') {
    return 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 hover:bg-emerald-500/15 dark:text-emerald-300'
  }
  if (status?.phase === 'error') {
    return 'border-red-500/40 bg-red-500/10 text-red-600 hover:bg-red-500/15 dark:text-red-300'
  }
  return 'border-border bg-muted/40 text-muted-foreground hover:text-foreground'
}
