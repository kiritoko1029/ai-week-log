import { cn } from '@/lib/utils'

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
  return (
    <div
      className={cn(
        'min-h-[120px] overflow-x-auto whitespace-pre-wrap rounded-md border bg-zinc-950 p-8 font-mono text-sm leading-[1.85] text-slate-200 shadow-sm',
        className
      )}
    >
      {text || <span className="text-slate-500">{placeholder}</span>}
    </div>
  )
}
