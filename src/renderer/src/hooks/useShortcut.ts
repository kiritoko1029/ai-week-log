import { useState, useCallback } from 'react'
import { api } from '@/lib/api'

const SHORTCUT_DEFAULT = 'CommandOrControl+Shift+L'

/** 判断是否 Mac，影响 accelerator 可读标签 */
const isMac = typeof navigator !== 'undefined' && navigator.platform.includes('Mac')

/** Electron accelerator → 人类可读标签 */
export function accelToLabel(accel: string): string {
  return (accel || '')
    .split('+')
    .map((p) => {
      if (p === 'CommandOrControl' || p === 'CmdOrCtrl') return isMac ? '⌘' : 'Ctrl'
      if (p === 'Control' || p === 'Ctrl') return 'Ctrl'
      if (p === 'Command' || p === 'Cmd' || p === 'Meta') return isMac ? '⌘' : 'Win'
      if (p === 'Alt' || p === 'Option') return isMac ? '⌥' : 'Alt'
      if (p === 'Shift') return isMac ? '⇧' : 'Shift'
      return p.length === 1 ? p.toUpperCase() : p
    })
    .join(isMac ? '' : ' + ')
}

/** 键盘事件 → Electron accelerator（要求至少一个修饰键） */
function normalizeKey(key: string, code: string): string | null {
  if (!key) return null
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(key)) return null
  if (/^[a-z]$/i.test(key)) return key.toUpperCase()
  if (/^Digit(\d)$/.test(code)) return code.slice(5)
  if (/^F([1-9]|1\d|2[0-4])$/.test(key)) return key
  if (key === 'Enter') return 'Return'
  if (key === ' ') return 'Space'
  if (key === 'Tab') return 'Tab'
  if (key === 'ArrowUp') return 'Up'
  if (key === 'ArrowDown') return 'Down'
  if (key === 'ArrowLeft') return 'Left'
  if (key === 'ArrowRight') return 'Right'
  if (['Comma', 'Period', 'Slash', 'Semicolon', 'Quote', 'Minus', 'Equal'].includes(code)) return code
  return null
}

function eventToAccel(e: React.KeyboardEvent): string | null {
  const key = normalizeKey(e.key, e.code)
  if (!key) return null
  const parts: string[] = []
  if (e.ctrlKey) parts.push('Control')
  if (e.metaKey) parts.push('Command')
  if (e.altKey) parts.push('Alt')
  if (e.shiftKey) parts.push('Shift')
  if (!parts.length) return null
  parts.push(key)
  return parts.join('+')
}

/** 快捷键录制 hook：聚焦输入框后按下组合键即捕获 */
export function useShortcutRecorder(initial: string) {
  const [accel, setAccel] = useState(initial || SHORTCUT_DEFAULT)

  const reset = useCallback(() => setAccel(SHORTCUT_DEFAULT), [])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      e.preventDefault()
      if (e.key === 'Escape') {
        ;(e.target as HTMLInputElement).blur()
        return
      }
      if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return
      const a = eventToAccel(e)
      if (a) setAccel(a)
    },
    []
  )

  /** 录制期间临时停用全局快捷键 */
  const onFocus = useCallback(() => api.shortcut.suspend().catch(() => {}), [])
  const onBlur = useCallback(() => api.shortcut.resume().catch(() => {}), [])

  return { accel, setAccel, reset, handleKeyDown, onFocus, onBlur, SHORTCUT_DEFAULT }
}
