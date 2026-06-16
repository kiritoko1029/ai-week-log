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
  return (
    <div
      className={cn(
        codeSurface,
        'min-h-[120px] overflow-x-auto whitespace-pre-wrap p-8 shadow-sm',
        className
      )}
    >
      {text || <span className="text-slate-500">{placeholder}</span>}
    </div>
  )
}
