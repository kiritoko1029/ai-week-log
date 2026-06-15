import { useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { useConfig } from '@/hooks/useConfig'
import { cn } from '@/lib/utils'
import { GitBranch, KeyRound } from 'lucide-react'
import { TaskIndicator } from '@/components/TaskIndicator'

export function Statusbar() {
  const { config } = useConfig()
  const [gitOk, setGitOk] = useState<boolean | null>(null)
  const [keyOk, setKeyOk] = useState<boolean | null>(null)

  useEffect(() => {
    api.env.gitOk().then(setGitOk).catch(() => setGitOk(false))
  }, [])

  useEffect(() => {
    if (!config) return
    api.env.apiKeyStatus().then(setKeyOk).catch(() => setKeyOk(false))
  }, [config])

  const prov = config?.ai.provider ?? '—'
  const model = config ? config.ai[config.ai.provider].model : '—'
  const repoCount = config?.repos.length ?? 0

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
        <span>WeekLog v1.2.1</span>
      </span>
    </footer>
  )
}
