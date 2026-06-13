import { useState, useCallback, useRef } from 'react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { isoDate } from '@/lib/dates'
import type { GenerateRangeOpts, GenerateOptions, Report } from '@/types/weeklog'

interface GenerateRunState {
  busy: boolean
  progress: { done: number; total: number; project: string } | null
  status: string
  report: string
}

/** 通用生成流程：采集 → AI 融合 → 渲染，带进度订阅与历史保存 */
export function useGenerate() {
  const [state, setState] = useState<GenerateRunState>({
    busy: false,
    progress: null,
    status: '',
    report: '',
  })
  const offRef = useRef<(() => void) | null>(null)

  const run = useCallback(
    async (rangeOpts: GenerateRangeOpts, options: GenerateOptions, type: '周报' | '日报') => {
      setState({ busy: true, progress: null, status: '采集 commit + 加载笔记…', report: '' })
      offRef.current = api.onProgress((m) => {
        setState((s) => ({ ...s, progress: m, status: `AI 融合生成中… ${m.done}/${m.total}（${m.project}）` }))
      })
      try {
        const report: Report = await api.generate({ rangeOpts, options })
        offRef.current?.()
        offRef.current = null
        if (report.error) {
          setState((s) => ({ ...s, busy: false, status: `✗ ${report.error}`, report: '' }))
          toast.error(report.error)
          return
        }
        const m = report.meta || {}
        const status = `✓ 完成 · ${m.commitCount || 0} commits + ${m.noteCount || 0} 笔记 → ${m.bucketCount || 0} 段 · ${((m.durationMs || 0) / 1000).toFixed(1)}s${report.failedUnits.length ? ' · ' + report.failedUnits.length + ' 次降级' : ''}`
        setState({ busy: false, progress: null, status, report: report.text || '（无内容）' })
        // 保存历史
        await api.history.save({
          type,
          rangeStart: report.rangeStart ? isoDate(new Date(report.rangeStart)) : '',
          rangeEnd: report.rangeEnd ? isoDate(new Date(report.rangeEnd)) : '',
          text: report.text || '',
          meta: m,
        })
        toast.success(`${type}生成完成`)
      } catch (e) {
        offRef.current?.()
        offRef.current = null
        const msg = (e as Error).message
        setState((s) => ({ ...s, busy: false, status: `✗ ${msg}`, report: '' }))
        toast.error('生成失败', { description: msg })
      }
    },
    []
  )

  return { ...state, run }
}
