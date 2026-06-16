import { useState, useCallback, useEffect, useRef } from 'react'
import {
  Send,
  Square,
  Plus,
  Trash2,
  MessageSquare,
  Pencil,
  Brain,
  FileText,
  StickyNote,
  ChevronRight,
  CalendarClock,
  Check,
  GitCommit,
  ArrowRight,
  Loader2,
} from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { useConfig } from '@/hooks/useConfig'
import { useNav } from '@/hooks/useNav'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Markdown } from '@/components/Markdown'
import type { ChatSessionMeta, ChatMessage, ChatRef, ChatReport, ChatStreamPayload } from '@/types/weeklog'

const SUGGESTIONS = ['上周我主要做了什么？', '最近在做哪些项目？', '这个月修复了哪些问题？']

/** 输入区快捷生成项 */
const QUICK_REPORTS: {
  label: string
  reportType: 'daily' | 'weekly'
  when: string
  icon: typeof FileText
}[] = [
  { label: '今日日报', reportType: 'daily', when: 'today', icon: CalendarClock },
  { label: '本周周报', reportType: 'weekly', when: 'this_week', icon: FileText },
  { label: '上周周报', reportType: 'weekly', when: 'last_week', icon: FileText },
]

type ReportProgress = { stage?: string; done?: number; total?: number; project?: string }

function progressLabel(p: ReportProgress): string {
  if (p.stage === '理解中') return '理解意图中…'
  if (p.stage === '采集中') return '采集 commit + 笔记…'
  if (p.total) return `AI 融合生成中… ${p.done || 0}/${p.total}${p.project ? '（' + p.project + '）' : ''}`
  return '生成报告中…'
}

/** 引用来源小标签（鼠标悬停看摘要） */
function RefBadges({ refs }: { refs?: ChatRef[] }) {
  if (!refs || refs.length === 0) return null
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {refs.map((r, i) => {
        const Icon = r.kind === 'memory' ? Brain : r.kind === 'report' ? FileText : StickyNote
        return (
          <span
            key={i}
            title={r.snippet}
            className="inline-flex max-w-[220px] items-center gap-1 truncate rounded-md border bg-muted/50 px-2 py-0.5 text-[11px] text-muted-foreground"
          >
            <Icon className="size-3 shrink-0" />
            <span className="truncate">{r.label}</span>
          </span>
        )
      })}
    </div>
  )
}

/** 可折叠的思考过程区块 */
function ThinkingBlock({
  text,
  streaming = false,
  defaultOpen = false,
}: {
  text: string
  streaming?: boolean
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  if (!text) return null
  return (
    <div className="mb-1.5 w-full max-w-[85%] overflow-hidden rounded-lg border bg-muted/30">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted/50"
      >
        <Brain className={cn('size-3.5', streaming && 'animate-pulse')} />
        <span>{streaming ? '思考中…' : '思考过程'}</span>
        <ChevronRight className={cn('ml-auto size-3.5 transition-transform', open && 'rotate-90')} />
      </button>
      {open && (
        <div className="border-t px-3 py-2">
          <Markdown content={text} className="text-xs text-muted-foreground" />
        </div>
      )}
    </div>
  )
}

/** 报告卡片：强调色头部 + 图标 + 存档徽章 + Markdown 正文 + meta 底栏 */
function ReportCard({ report, content }: { report: ChatReport; content: string }) {
  const { navigate } = useNav()
  const isWeekly = report.reportType === 'weekly'
  const Icon = isWeekly ? FileText : CalendarClock
  const meta = report.meta || {}
  const range =
    report.rangeStart === report.rangeEnd ? report.rangeStart : `${report.rangeStart} – ${report.rangeEnd}`
  return (
    <div className="w-full max-w-[94%] overflow-hidden rounded-xl border bg-card shadow-sm">
      {/* 头部 */}
      <div className="flex items-center gap-3 border-b bg-gradient-to-r from-violet-500/10 via-violet-500/[0.04] to-transparent px-4 py-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-violet-600 text-white shadow-sm">
          <Icon className="size-[18px]" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold">{isWeekly ? '周报' : '日报'}</span>
            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
              <Check className="size-3" />
              已存档
            </span>
          </div>
          <div className="mt-0.5 font-mono text-xs text-muted-foreground">{range}</div>
        </div>
      </div>
      {/* 正文 */}
      <div className="max-h-[440px] overflow-y-auto px-4 py-3">
        <Markdown content={content} />
      </div>
      {/* meta 底栏 */}
      <div className="flex items-center justify-between gap-2 border-t bg-muted/30 px-4 py-2 text-xs text-muted-foreground">
        <div className="flex items-center gap-3">
          {meta.commitCount != null && (
            <span className="flex items-center gap-1">
              <GitCommit className="size-3" />
              {meta.commitCount} commits
            </span>
          )}
          {meta.noteCount != null && (
            <span className="flex items-center gap-1">
              <StickyNote className="size-3" />
              {meta.noteCount} 笔记
            </span>
          )}
        </div>
        <button
          onClick={() => navigate('history')}
          className="flex shrink-0 items-center gap-1 font-medium text-violet-600 transition-colors hover:text-violet-500"
        >
          在历史记录查看
          <ArrowRight className="size-3" />
        </button>
      </div>
    </div>
  )
}

export function ChatPage() {
  const { config } = useConfig()
  const [sessions, setSessions] = useState<ChatSessionMeta[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [streamText, setStreamText] = useState('')
  const [streamThinking, setStreamThinking] = useState('')
  const [streamRefs, setStreamRefs] = useState<ChatRef[]>([])
  const [reportProgress, setReportProgress] = useState<ReportProgress | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameText, setRenameText] = useState('')

  const activeIdRef = useRef<string | null>(null)
  const streamMsgIdRef = useRef<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    activeIdRef.current = activeId
  }, [activeId])

  const loadSessions = useCallback(async () => {
    const list = await api.chat.sessions()
    setSessions(list)
    return list
  }, [])

  const resetStream = useCallback(() => {
    setStreamText('')
    setStreamThinking('')
    setStreamRefs([])
    setReportProgress(null)
  }, [])

  const openSession = useCallback(
    async (id: string) => {
      setActiveId(id)
      activeIdRef.current = id
      resetStream()
      const s = await api.chat.getSession(id)
      setMessages(s?.messages || [])
    },
    [resetStream]
  )

  // 初始化：加载会话列表，选中最近一个
  useEffect(() => {
    ;(async () => {
      const list = await loadSessions()
      if (list.length) await openSession(list[0].id)
    })()
  }, [loadSessions, openSession])

  // 中断/出错：后端已落盘已生成的部分，这里清流式态并重新拉取该会话
  const finalizeInterrupted = useCallback(() => {
    setStreaming(false)
    resetStream()
    streamMsgIdRef.current = null
    const id = activeIdRef.current
    if (id) {
      api.chat.getSession(id).then((s) => {
        if (s && activeIdRef.current === id) setMessages(s.messages || [])
      })
    }
  }, [resetStream])

  // 订阅流式事件（mount 一次，用 ref 读最新态避免闭包陈旧）
  useEffect(() => {
    const off = api.chat.onStream((p: ChatStreamPayload) => {
      if (p.msgId !== streamMsgIdRef.current) return
      if (p.type === 'refs') {
        setStreamRefs(p.refs)
      } else if (p.type === 'thinking') {
        setStreamThinking((t) => t + p.text)
      } else if (p.type === 'delta') {
        setStreamText((t) => t + p.text)
      } else if (p.type === 'report_progress') {
        setReportProgress({ stage: p.stage, done: p.done, total: p.total, project: p.project })
      } else if (p.type === 'done' || p.type === 'report_done') {
        if (p.sessionId === activeIdRef.current) setMessages((m) => [...m, p.message])
        setStreaming(false)
        resetStream()
        streamMsgIdRef.current = null
        loadSessions()
      } else if (p.type === 'aborted') {
        finalizeInterrupted()
      } else if (p.type === 'error') {
        toast.error('生成失败', { description: p.message })
        finalizeInterrupted()
      }
    })
    return off
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadSessions, finalizeInterrupted, resetStream])

  // 自动滚到底
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }, [messages, streamText, streamThinking, reportProgress, streaming])

  /** 确保有活动会话，返回 sessionId */
  const ensureSession = useCallback(async () => {
    let sid = activeIdRef.current
    if (!sid) {
      const s = await api.chat.createSession()
      sid = s.id
      setActiveId(sid)
      activeIdRef.current = sid
      setMessages([])
      await loadSessions()
    }
    return sid
  }, [loadSessions])

  const pushLocalUser = useCallback((content: string) => {
    const userMsg: ChatMessage = {
      id: 'local_' + Date.now().toString(36),
      role: 'user',
      content,
      createdAt: new Date().toISOString(),
    }
    setMessages((m) => [...m, userMsg])
  }, [])

  const send = useCallback(async () => {
    const content = input.trim()
    if (!content || streaming) return
    const sid = await ensureSession()
    pushLocalUser(content)
    setInput('')
    setStreaming(true)
    resetStream()
    const r = await api.chat.send(sid, content)
    if (r.error) {
      toast.error('发送失败', { description: r.error })
      setStreaming(false)
      return
    }
    streamMsgIdRef.current = r.msgId || null
  }, [input, streaming, ensureSession, pushLocalUser, resetStream])

  const quickGenerate = useCallback(
    async (reportType: 'daily' | 'weekly', when: string, label: string) => {
      if (streaming) return
      const sid = await ensureSession()
      pushLocalUser('生成' + label)
      setStreaming(true)
      resetStream()
      setReportProgress({ stage: '采集中' })
      const r = await api.chat.generate(sid, reportType, when)
      if (r.error) {
        toast.error('生成失败', { description: r.error })
        setStreaming(false)
        setReportProgress(null)
        return
      }
      streamMsgIdRef.current = r.msgId || null
    },
    [streaming, ensureSession, pushLocalUser, resetStream]
  )

  const stop = useCallback(async () => {
    if (streamMsgIdRef.current) await api.chat.cancel(streamMsgIdRef.current)
  }, [])

  const newChat = useCallback(async () => {
    const s = await api.chat.createSession()
    await loadSessions()
    setActiveId(s.id)
    activeIdRef.current = s.id
    setMessages([])
    resetStream()
  }, [loadSessions, resetStream])

  const removeSession = useCallback(
    async (id: string, e: React.MouseEvent) => {
      e.stopPropagation()
      await api.chat.deleteSession(id)
      const list = await loadSessions()
      if (id === activeIdRef.current) {
        if (list.length) await openSession(list[0].id)
        else {
          setActiveId(null)
          activeIdRef.current = null
          setMessages([])
        }
      }
    },
    [loadSessions, openSession]
  )

  const startRename = useCallback((s: ChatSessionMeta, e: React.MouseEvent) => {
    e.stopPropagation()
    setRenamingId(s.id)
    setRenameText(s.title)
  }, [])

  const saveRename = useCallback(async () => {
    const id = renamingId
    if (!id) return
    const title = renameText.trim()
    setRenamingId(null)
    if (title) {
      await api.chat.renameSession(id, title)
      await loadSessions()
    }
  }, [renamingId, renameText, loadSessions])

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      send()
    }
  }

  const empty = messages.length === 0 && !streaming

  return (
    <div className="flex h-[calc(100vh-150px)] min-h-[420px] gap-4">
      {/* 会话列表 */}
      <aside className="flex w-56 flex-shrink-0 flex-col rounded-lg border bg-card">
        <div className="flex items-center justify-between border-b px-3 py-2.5">
          <span className="text-sm font-semibold">对话</span>
          <Button variant="ghost" onClick={newChat} className="h-7 gap-1 px-2 text-xs">
            <Plus className="size-3.5" />
            新建
          </Button>
        </div>
        <div className="flex-1 space-y-0.5 overflow-y-auto p-2">
          {sessions.length === 0 && (
            <p className="px-2 py-6 text-center text-xs text-muted-foreground">还没有对话</p>
          )}
          {sessions.map((s) => {
            const active = s.id === activeId
            return (
              <div
                key={s.id}
                onClick={() => openSession(s.id)}
                className={cn(
                  'group flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1.5 text-sm transition-colors',
                  active ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'
                )}
              >
                {renamingId === s.id ? (
                  <input
                    autoFocus
                    value={renameText}
                    onChange={(e) => setRenameText(e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                    onBlur={saveRename}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') saveRename()
                      else if (e.key === 'Escape') setRenamingId(null)
                    }}
                    className="min-w-0 flex-1 rounded bg-background px-1 text-foreground outline-none ring-1 ring-ring"
                  />
                ) : (
                  <>
                    <MessageSquare className="size-3.5 shrink-0 opacity-60" />
                    <span className="flex-1 truncate">{s.title}</span>
                    <button
                      onClick={(e) => startRename(s, e)}
                      className="shrink-0 opacity-0 transition-opacity hover:opacity-100 group-hover:opacity-70"
                      title="重命名"
                    >
                      <Pencil className="size-3" />
                    </button>
                    <button
                      onClick={(e) => removeSession(s.id, e)}
                      className="shrink-0 opacity-0 transition-opacity hover:opacity-100 group-hover:opacity-70"
                      title="删除"
                    >
                      <Trash2 className="size-3" />
                    </button>
                  </>
                )}
              </div>
            )
          })}
        </div>
      </aside>

      {/* 聊天区 */}
      <main className="flex min-w-0 flex-1 flex-col rounded-lg border bg-card">
        <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto p-4">
          {empty ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
              <div className="rounded-full bg-muted p-3">
                <MessageSquare className="size-6 text-muted-foreground" />
              </div>
              <div>
                <p className="text-sm font-medium">问问你的工作记录，或让 AI 生成报告</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  基于本地记忆、周报 / 日报与笔记作答；也能「帮我生成本周周报」
                </p>
              </div>
              {config && !config.memory?.enabled && (
                <p className="max-w-sm text-xs text-amber-600">
                  AI 记忆未启用，将仅用报告 / 笔记兜底。可在「设置」开启并重建记忆以获得更准的检索。
                </p>
              )}
              <div className="mt-2 flex max-w-md flex-wrap justify-center gap-2">
                {SUGGESTIONS.map((q) => (
                  <button
                    key={q}
                    onClick={() => setInput(q)}
                    className="rounded-full border px-3 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  >
                    {q}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <>
              {messages.map((m) =>
                m.role === 'user' ? (
                  <div key={m.id} className="flex justify-end">
                    <div className="max-w-[80%] whitespace-pre-wrap rounded-lg rounded-br-sm bg-violet-600 px-3.5 py-2 text-sm text-white">
                      {m.content}
                    </div>
                  </div>
                ) : m.report ? (
                  <div key={m.id} className="flex w-full flex-col items-start">
                    <ReportCard report={m.report} content={m.content} />
                  </div>
                ) : (
                  <div key={m.id} className="flex w-full flex-col items-start">
                    {m.reasoning && <ThinkingBlock text={m.reasoning} />}
                    <div className="max-w-[85%] rounded-lg rounded-bl-sm bg-muted px-3.5 py-2 text-foreground">
                      <Markdown content={m.content} />
                    </div>
                    <RefBadges refs={m.refs} />
                  </div>
                )
              )}
              {streaming && (
                <div className="flex w-full flex-col items-start">
                  {reportProgress ? (
                    <div className="flex max-w-[85%] items-center gap-2 rounded-lg rounded-bl-sm border border-violet-500/20 bg-violet-500/5 px-3.5 py-2.5 text-sm text-foreground">
                      <Loader2 className="size-4 shrink-0 animate-spin text-violet-600" />
                      <span>{progressLabel(reportProgress)}</span>
                    </div>
                  ) : (
                    <>
                      {streamThinking && <ThinkingBlock text={streamThinking} streaming defaultOpen />}
                      {streamText ? (
                        <div className="max-w-[85%] rounded-lg rounded-bl-sm bg-muted px-3.5 py-2 text-foreground">
                          <Markdown content={streamText} />
                        </div>
                      ) : (
                        !streamThinking && (
                          <div className="max-w-[85%] rounded-lg rounded-bl-sm bg-muted px-3.5 py-2 text-sm text-muted-foreground">
                            思考中…
                          </div>
                        )
                      )}
                      <RefBadges refs={streamRefs} />
                    </>
                  )}
                </div>
              )}
            </>
          )}
        </div>

        {/* 输入区 */}
        <div className="border-t p-3">
          {/* 快捷生成 */}
          <div className="mb-2 flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] text-muted-foreground">快捷生成</span>
            {QUICK_REPORTS.map((q) => (
              <button
                key={q.label}
                onClick={() => quickGenerate(q.reportType, q.when, q.label)}
                disabled={streaming}
                className="inline-flex items-center gap-1 rounded-full border bg-background px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:border-violet-400 hover:text-violet-600 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <q.icon className="size-3" />
                {q.label}
              </button>
            ))}
          </div>
          <div className="flex items-end gap-2">
            <Textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKey}
              placeholder="问问你的工作记录，或说「帮我生成本周周报」…"
              rows={2}
              className="max-h-32 min-h-[44px] flex-1 resize-none"
            />
            {streaming ? (
              reportProgress ? (
                <Button disabled variant="outline" className="h-11 shrink-0 gap-1.5">
                  <Loader2 className="size-4 animate-spin" />
                  生成中
                </Button>
              ) : (
                <Button onClick={stop} variant="outline" className="h-11 shrink-0 gap-1.5">
                  <Square className="size-4" />
                  停止
                </Button>
              )
            ) : (
              <Button
                onClick={send}
                disabled={!input.trim()}
                className="h-11 shrink-0 gap-1.5 bg-violet-600 text-white hover:bg-violet-600/90"
              >
                <Send className="size-4" />
                发送
              </Button>
            )}
          </div>
          <p className="mt-1.5 px-1 text-[11px] text-muted-foreground">
            Enter 发送 · Shift+Enter 换行 · 报告基于真实 commit + 笔记，自动存入历史
          </p>
        </div>
      </main>
    </div>
  )
}
