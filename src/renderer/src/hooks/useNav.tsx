import { createContext, useContext, useState, useCallback } from 'react'

export type PageId =
  | 'dashboard'
  | 'generate'
  | 'daily'
  | 'notes'
  | 'repos'
  | 'history'
  | 'settings'

interface NavContextValue {
  page: PageId
  navigate: (p: PageId) => void
}

const NavContext = createContext<NavContextValue | null>(null)

export function NavProvider({ children }: { children: React.ReactNode }) {
  const [page, setPage] = useState<PageId>('dashboard')
  const navigate = useCallback((p: PageId) => setPage(p), [])
  return <NavContext.Provider value={{ page, navigate }}>{children}</NavContext.Provider>
}

export function useNav(): NavContextValue {
  const ctx = useContext(NavContext)
  if (!ctx) throw new Error('useNav 必须在 NavProvider 内使用')
  return ctx
}
