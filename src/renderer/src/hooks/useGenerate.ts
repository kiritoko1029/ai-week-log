import { useState, useCallback, useRef, useMemo } from 'react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { isoDate } from '@/lib/dates'
import { useTasks } from '@/hooks/useTasks'
import type { GenerateRangeOpts, GenerateOptions, Report } from '@/types/weeklog'

/**
 * 生成报告流程。
 *
 * 关键改进：busy / progress / status 从全局任务系统（useTasks）派生，
 * 切换页面再回来时不会丢失进度——任务在主进程持久。
 * report 文本保存在本地 state，完成后填入；切换页面会丢文本，
 * 但状态栏任务面板仍显示「完成」，报告可在历史记录里找回。
 */
export function useGenerate() {
  const { tasks } = useTasks()
  // 最近一个 generate 任务（running 优先，否则最近一条）
  const generateTask = useMemo(() => {
    const running = tasks.find((t) => t.kind === 'generate' && t.status === 'running')
    return running || tasks.find((t) => t.kind === 'generate')
  }, [tasks])

  const busy = generateTask?.status === 'running'
  const progress = generateTask?.progress
    ? { done: generateTask.progress.done, total: generateTask.progress.total, project: generateTask.progress.label }
    : null

  const [report, setReport] = useState('')
  const [localStatus, setLocalStatus] = useState('')

  // 从任务派生 status 展示文本（任务存在时优先用任务状态）
  const status = useMemo(() => {
    if (!generateTask) return localStatus
    if (generateTask.status === 'running') return generateTask.detail || generateTask.title
    if (generateTask.status === 'done') {
      const r = generateTask.result as { commitCount?: number; noteCount?: number; bucketCount?: number; durationMs?: number } | null
      if (r) return `✓ 完成 · ${r.commitCount || 0} commits + ${r.noteCount || 0} 笔记 → ${r.bucketCount || 0} 段 · ${((r.durationMs || 0) / 1000).toFixed(1)}s`
      return '✓ 完成'
    }
    if (generateTask.status === 'error') return `✗ ${generateTask.error || '失败'}`
    return localStatus
  }, [generateTask, localStatus])

  const offRef = useRef<(() => void) | null>(null)

  const run = useCallback(
    async (rangeOpts: GenerateRangeOpts, options: GenerateOptions, type: '周报' | '日报') => {
      setLocalStatus('采集 commit + 加载笔记…')
      setReport('')
      // 兼容旧 progress 订阅（主进程仍会发，避免 listener 泄漏）
      offRef.current = api.onProgress(() => {})
      try {
        const result: Report = await api.generate({
          rangeOpts,
          options: { ...options, _reportType: type } as GenerateOptions & { _reportType?: string },
        })
        offRef.current?.()
        offRef.current = null
        if (result.error) {
          setLocalStatus(`✗ ${result.error}`)
          toast.error(result.error)
          return
        }
        const m = result.meta || {}
        setLocalStatus(`✓ 完成 · ${m.commitCount || 0} commits + ${m.noteCount || 0} 笔记 → ${m.bucketCount || 0} 段 · ${((m.durationMs || 0) / 1000).toFixed(1)}s${result.failedUnits.length ? ' · ' + result.failedUnits.length + ' 次降级' : ''}`)
        setReport(result.text || '（无内容）')
        await api.history.save({
          type,
          rangeStart: result.rangeStart ? isoDate(new Date(result.rangeStart)) : '',
          rangeEnd: result.rangeEnd ? isoDate(new Date(result.rangeEnd)) : '',
          text: result.text || '',
          meta: m,
        })
        toast.success(`${type}生成完成`)
      } catch (e) {
        offRef.current?.()
        offRef.current = null
        const msg = (e as Error).message
        setLocalStatus(`✗ ${msg}`)
        toast.error('生成失败', { description: msg })
      }
    },
    []
  )

  return { busy, progress, status, report, run }
}
