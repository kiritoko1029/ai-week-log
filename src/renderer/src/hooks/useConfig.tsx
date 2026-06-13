import { createContext, useContext, useState, useCallback, useEffect } from 'react'
import { api } from '@/lib/api'
import type { Config } from '@/types/weeklog'

interface ConfigContextValue {
  config: Config | null
  loading: boolean
  /** 重新从主进程读取配置 */
  refresh: () => Promise<Config>
  /** 保存配置并刷新本地状态 */
  save: (cfg: Config) => Promise<Config>
}

const ConfigContext = createContext<ConfigContextValue | null>(null)

export function ConfigProvider({ children }: { children: React.ReactNode }) {
  const [config, setConfig] = useState<Config | null>(null)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    const cfg = await api.config.get()
    setConfig(cfg)
    setLoading(false)
    return cfg
  }, [])

  const save = useCallback(async (cfg: Config) => {
    const saved = await api.config.save(cfg)
    setConfig(saved)
    return saved
  }, [])

  useEffect(() => {
    refresh().catch(() => setLoading(false))
  }, [refresh])

  return <ConfigContext.Provider value={{ config, loading, refresh, save }}>{children}</ConfigContext.Provider>
}

export function useConfig(): ConfigContextValue {
  const ctx = useContext(ConfigContext)
  if (!ctx) throw new Error('useConfig 必须在 ConfigProvider 内使用')
  return ctx
}
