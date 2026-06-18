import { createContext, useContext, useState, useCallback, useRef } from 'react'

export type PageId =
  | 'dashboard'
  | 'generate'
  | 'daily'
  | 'chat'
  | 'notes'
  | 'repos'
  | 'history'
  | 'logs'
  | 'settings'

/** 跨页传递的数据载荷（如「把报告送入对话润色」携带的报告文本） */
export interface ReportRefinePayload {
  kind: 'reportRefine'
  reportText: string
  reportType: '日报' | '周报'
  rangeStart?: string
  rangeEnd?: string
  historyId?: string
}

export type NavPayload = ReportRefinePayload

interface NavContextValue {
  page: PageId
  navigate: (p: PageId, payload?: NavPayload) => void
  /** 消费一次导航载荷（读取后即清空，供目标页挂载时取用） */
  consumePayload: () => NavPayload | null
}

const NavContext = createContext<NavContextValue | null>(null)

export function NavProvider({ children }: { children: React.ReactNode }) {
  const [page, setPage] = useState<PageId>('dashboard')
  // 用 ref 承载载荷：因 AppShell 用 key={page} 强制重挂载，载荷必须在被重挂载的子树之上，
  // 且 consume 后立即清空，避免重复消费
  const payloadRef = useRef<NavPayload | null>(null)
  const navigate = useCallback((p: PageId, payload?: NavPayload) => {
    if (payload) payloadRef.current = payload
    setPage(p)
  }, [])
  const consumePayload = useCallback(() => {
    const p = payloadRef.current
    payloadRef.current = null
    return p
  }, [])
  return (
    <NavContext.Provider value={{ page, navigate, consumePayload }}>
      {children}
    </NavContext.Provider>
  )
}

export function useNav(): NavContextValue {
  const ctx = useContext(NavContext)
  if (!ctx) throw new Error('useNav 必须在 NavProvider 内使用')
  return ctx
}
