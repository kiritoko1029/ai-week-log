import { useState } from 'react'
import { Copy, Check } from 'lucide-react'
import { toast } from 'sonner'
import { cn, codeSurface } from '@/lib/utils'

/** 暗色终端风预览框，用于展示生成的周报/日报文本 */
export function ReportPreview({
  text,
  placeholder = '点击「生成」后此处显示结果…',
  className,
}: {
  text: string
  placeholder?: string
  className?: string
}) {
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    if (!text) return
    try {
      await navigator.clipboard?.writeText(text)
      toast.success('已复制到剪贴板')
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch (e) {
      toast.error('复制失败', { description: (e as Error)?.message || '未知错误' })
    }
  }

  return (
    <div className={cn(codeSurface, 'group relative shadow-sm', className)}>
      <button
        type="button"
        onClick={copy}
        disabled={!text}
        aria-label="复制报告"
        className={cn(
          'absolute right-3 top-3 inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs opacity-0 transition-opacity focus:opacity-100',
          'text-slate-300 hover:bg-white/10 hover:text-white disabled:pointer-events-none disabled:opacity-30',
          'group-hover:opacity-100'
        )}
      >
        {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
        {copied ? '已复制' : '复制'}
      </button>
      <div className="min-h-[120px] overflow-x-auto whitespace-pre-wrap p-8">
        {text || <span className="text-slate-500">{placeholder}</span>}
      </div>
    </div>
  )
}
