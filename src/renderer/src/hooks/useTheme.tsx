import { createContext, useContext, useEffect, useState, useCallback } from 'react'
import { api } from '@/lib/api'

export type Theme = 'auto' | 'light' | 'dark'
export type ResolvedTheme = 'light' | 'dark'

interface ThemeContextValue {
  /** 用户选择的主题（auto/light/dark） */
  theme: Theme
  /** 实际解析后的主题 */
  resolved: ResolvedTheme
  /** 设置主题（同时持久化到 config + 同步原生外观 + 缓存到 localStorage） */
  setTheme: (t: Theme) => Promise<void>
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

const THEME_KEY = 'weeklog:theme'

function systemDark(): boolean {
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

function resolveTheme(t: Theme): ResolvedTheme {
  if (t === 'dark') return 'dark'
  if (t === 'light') return 'light'
  return systemDark() ? 'dark' : 'light'
}

function applyResolved(resolved: ResolvedTheme) {
  const root = document.documentElement
  if (resolved === 'dark') root.classList.add('dark')
  else root.classList.remove('dark')
  try {
    localStorage.setItem(THEME_KEY, currentThemeFromDOM())
  } catch {}
}

/** 从 localStorage 读取缓存的"选择"（auto/light/dark） */
function currentThemeFromDOM(): Theme {
  try {
    const t = localStorage.getItem(THEME_KEY) as Theme | null
    if (t === 'light' || t === 'dark' || t === 'auto') return t
  } catch {}
  return 'auto'
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(() => currentThemeFromDOM())
  const [resolved, setResolved] = useState<ResolvedTheme>(() => resolveTheme(currentThemeFromDOM()))

  // 应用 dark class
  useEffect(() => {
    setResolved(resolveTheme(theme))
  }, [theme])

  useEffect(() => {
    applyResolved(resolved)
  }, [resolved])

  // auto 模式下，系统主题变化时实时刷新
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => {
      if (theme === 'auto') {
        setResolved(resolveTheme('auto'))
      }
    }
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [theme])

  // 从 config 校正（首屏 theme-init.js 用缓存先行，此处用真实配置覆盖）
  useEffect(() => {
    let cancelled = false
    api.config.get().then((cfg) => {
      if (cancelled) return
      const t = (cfg.ui && cfg.ui.theme) || 'auto'
      try {
        localStorage.setItem(THEME_KEY, t)
      } catch {}
      setThemeState(t)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const setTheme = useCallback(async (t: Theme) => {
    setThemeState(t)
    try {
      localStorage.setItem(THEME_KEY, t)
    } catch {}
    // 同步原生外观（标题栏/窗口底色）
    try {
      await api.ui.setTheme(t)
    } catch {}
  }, [])

  return (
    <ThemeContext.Provider value={{ theme, resolved, setTheme }}>{children}</ThemeContext.Provider>
  )
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme 必须在 ThemeProvider 内使用')
  return ctx
}
