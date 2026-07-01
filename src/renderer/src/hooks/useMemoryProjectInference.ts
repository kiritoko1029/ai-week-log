import { useEffect, useRef, useState } from 'react'
import { api } from '@/lib/api'
import type { MemoryInferResult } from '@/types/weeklog'

export interface UseMemoryProjectInferenceOptions {
  text: string
  memoryEnabled?: boolean
  minChars?: number
  debounceMs?: number
}

export function useMemoryProjectInference({
  text,
  memoryEnabled,
  minChars = 4,
  debounceMs = 800,
}: UseMemoryProjectInferenceOptions) {
  const [enabled, setEnabled] = useState<boolean>(memoryEnabled ?? false)
  const [result, setResult] = useState<MemoryInferResult | null>(null)
  const [inferring, setInferring] = useState(false)
  const requestIdRef = useRef(0)

  useEffect(() => {
    if (typeof memoryEnabled === 'boolean') {
      setEnabled(memoryEnabled)
      return
    }
    let active = true
    api.config.get()
      .then((cfg) => {
        if (active) setEnabled(!!cfg.memory?.enabled)
      })
      .catch(() => {
        if (active) setEnabled(false)
      })
    return () => {
      active = false
    }
  }, [memoryEnabled])

  useEffect(() => {
    const trimmed = text.trim()
    const latestRequestId = requestIdRef.current + 1
    requestIdRef.current = latestRequestId

    if (!enabled || trimmed.length < minChars) {
      setResult(null)
      setInferring(false)
      return
    }

    setInferring(true)
    const timer = setTimeout(async () => {
      try {
        const next = await api.memory.inferProject(trimmed)
        if (requestIdRef.current === latestRequestId) {
          setResult(next.error ? null : next)
        }
      } catch {
        if (requestIdRef.current === latestRequestId) {
          setResult(null)
        }
      } finally {
        if (requestIdRef.current === latestRequestId) {
          setInferring(false)
        }
      }
    }, debounceMs)

    return () => clearTimeout(timer)
  }, [text, enabled, minChars, debounceMs])

  return {
    memoryEnabled: enabled,
    inferring,
    result,
    hasSuggestion: !!(result?.project && (result.confidence || 0) > 0.3),
  }
}
