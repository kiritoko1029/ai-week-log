import { useState, useEffect, useCallback } from 'react'
import { api } from '@/lib/api'
import type { GenerateRangeOpts, GenerateOptions, HistoryEntry } from '@/types/weeklog'

/**
 * 查询当前选择范围（同日/同周）下是否已有报告。
 * 去重键为 (type, rangeStart)：由后端 collect 解析 rangeOpts 得到 rangeStart（与 history:save 写入的键一致），
 * 再在全量历史里精确匹配。这样"展示已有"与"覆盖写入"用的是同一把钥匙。
 *
 * @param type     '日报' | '周报'
 * @param rangeOpts 当前页面的范围选择（日报 {mode,date}，周报 {week}/{from,to}/{}）
 * @param options   生成选项（取 weekStart 用于周起始日计算，默认随 config）
 */
export function useExistingReport(
  type: '日报' | '周报',
  rangeOpts: GenerateRangeOpts,
  options?: Pick<GenerateOptions, 'weekStart'>
) {
  const [existing, setExisting] = useState<HistoryEntry | null>(null)
  const [loading, setLoading] = useState(false)

  const run = useCallback(async () => {
    setLoading(true)
    try {
      // 复用 collect 拿到后端 resolveRange 后的 rangeStart（YYYY-MM-DD），保证与 history:save 键一致
      const res = await api.collect({ rangeOpts, options: { weekStart: options?.weekStart } })
      const rangeStart = res.range?.from
      const list = await api.history.list()
      const match = rangeStart
        ? list.find((h) => h.type === type && h.rangeStart === rangeStart) || null
        : null
      setExisting(match)
    } catch {
      setExisting(null)
    } finally {
      setLoading(false)
    }
  }, [type, JSON.stringify(rangeOpts), options?.weekStart])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    api
      .collect({ rangeOpts, options: { weekStart: options?.weekStart } })
      .then(async (res) => {
        const rangeStart = res.range?.from
        const list = await api.history.list()
        const match = rangeStart
          ? list.find((h) => h.type === type && h.rangeStart === rangeStart) || null
          : null
        if (!cancelled) setExisting(match)
      })
      .catch(() => {
        if (!cancelled) setExisting(null)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [type, JSON.stringify(rangeOpts), options?.weekStart])

  return { existing, loading, refresh: run }
}
