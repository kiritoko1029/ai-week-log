import { useState, useEffect, useCallback, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { LineChart, X, Check } from 'lucide-react'
import './styles/globals.css'
import { api } from '@/lib/api'
import { useMemoryProjectInference } from '@/hooks/useMemoryProjectInference'
import { todayISO } from '@/lib/dates'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { MemoryProjectHint } from '@/components/MemoryProjectHint'

function QuickNoteApp() {
  const [text, setText] = useState('')
  const [project, setProject] = useState('')
  const [projects, setProjects] = useState<{ name: string; label: string }[]>([])
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [statusMsg, setStatusMsg] = useState('Enter 保存 · Esc 关闭')
  const memoryInfer = useMemoryProjectInference({ text })

  // 主题同步（读 config）
  const applyTheme = useCallback(async () => {
    try {
      const c = await api.config.get()
      const t = (c.ui && c.ui.theme) || 'auto'
      const dark =
        t === 'dark' || (t === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches)
      document.documentElement.classList.toggle('dark', dark)
    } catch {}
  }, [])

  const loadProjects = useCallback(async () => {
    try {
      const c = await api.config.get()
      setProjects((c.repos || []).map((r) => ({ name: r.name, label: r.alias || r.name })).filter((p) => p.name))
    } catch {
      setProjects([])
    }
  }, [])

  const submit = useCallback(async () => {
    const content = text.trim()
    if (!content) return
    setStatus('saving')
    setStatusMsg('保存中…')
    try {
      const r = await api.notes.add({ date: todayISO(), project, content })
      setStatus('saved')
      setStatusMsg(`✓ 已保存 · ${r.file || 'notes'}`)
      setText('')
      setTimeout(() => {
        api.quicknote.hide()
        setStatus('idle')
        setStatusMsg('Enter 保存 · Esc 关闭')
      }, 650)
    } catch (e) {
      setStatus('error')
      setStatusMsg(`✗ ${(e as Error).message || '保存失败'}`)
    }
  }, [text, project])

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        submit()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        api.quicknote.hide()
      }
    },
    [submit]
  )

  // 每次唤起：清空 + 聚焦 + 复位 + 刷新
  useEffect(() => {
    const off = api.quicknote.onShow(() => {
      setText('')
      setStatus('idle')
      setStatusMsg('Enter 保存 · Esc 关闭')
      loadProjects()
      applyTheme()
      setTimeout(() => document.getElementById('qn-input')?.focus(), 0)
    })
    loadProjects()
    applyTheme()
    return off
  }, [loadProjects, applyTheme])

  return (
    <div className="fixed inset-0 flex h-[176px] flex-col overflow-hidden bg-background">
      {/* 标题栏（可拖拽） */}
      <div
        data-app-region="drag"
        className="flex items-center gap-2 border-b px-3 py-2"
      >
        <LineChart className="h-[18px] w-[18px] text-primary" />
        <div className="flex-1 truncate text-xs font-semibold">
          快速记笔记 <span className="font-normal text-muted-foreground">· 随时补全非代码工作</span>
        </div>
        <button
          data-app-region="no-drag"
          onClick={() => api.quicknote.hide()}
          className="flex h-[26px] w-[26px] cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          aria-label="关闭"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* 主体 */}
      <div className="flex flex-col gap-2.5 p-3">
        <Textarea
          id="qn-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="例如：参加架构评审，确认了订单服务拆分方案…"
          autoFocus
          className="h-16 min-h-16 resize-none overflow-hidden leading-5"
        />
        <div className="flex items-center gap-2">
          <select
            value={project || '__misc__'}
            onChange={(e) => setProject(e.target.value === '__misc__' ? '' : e.target.value)}
            className="h-9 w-[180px] shrink-0 cursor-pointer truncate rounded-md border border-input bg-background px-3 py-2 text-sm shadow-xs outline-none ring-offset-background transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            aria-label="选择项目"
          >
            <option value="__misc__">日常工作（通用）</option>
            {projects.map((p) => (
              <option key={p.name} value={p.name}>{p.label}</option>
            ))}
          </select>
          <Button size="sm" onClick={submit} className="bg-violet-600 hover:bg-violet-600/90">
            <Check />
            保存
          </Button>
          <MemoryProjectHint
            compact
            inferring={memoryInfer.inferring}
            result={memoryInfer.result}
            currentProject={project}
            onApply={setProject}
          />
          <span className="ml-auto text-right font-mono text-[11px] text-muted-foreground">{statusMsg}</span>
        </div>
      </div>
    </div>
  )
}

const root = document.getElementById('root')!
createRoot(root).render(
  <StrictMode>
    <QuickNoteApp />
  </StrictMode>
)
