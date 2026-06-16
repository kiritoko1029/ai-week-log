import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { api } from '@/lib/api'
import { cn, codeSurface } from '@/lib/utils'

/**
 * 轻量 Markdown 渲染（GFM：表格 / 任务列表 / 删除线）。
 * 元素样式手工映射到设计 token，避免引入 @tailwindcss/typography；
 * 代码块复用 codeSurface；链接走 shell.openExternal（仅 http/https）。
 */
const COMPONENTS: Components = {
  p: ({ children }) => <p className="my-1.5 leading-relaxed first:mt-0 last:mb-0">{children}</p>,
  ul: ({ children }) => <ul className="my-1.5 ml-5 list-disc space-y-0.5">{children}</ul>,
  ol: ({ children }) => <ol className="my-1.5 ml-5 list-decimal space-y-0.5">{children}</ol>,
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
  h1: ({ children }) => <h1 className="mb-1.5 mt-3 text-base font-semibold first:mt-0">{children}</h1>,
  h2: ({ children }) => <h2 className="mb-1.5 mt-3 text-base font-semibold first:mt-0">{children}</h2>,
  h3: ({ children }) => <h3 className="mb-1 mt-2 text-sm font-semibold first:mt-0">{children}</h3>,
  strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
  blockquote: ({ children }) => (
    <blockquote className="my-1.5 border-l-2 border-border pl-3 text-muted-foreground">{children}</blockquote>
  ),
  a: ({ href, children }) => (
    <a
      onClick={(e) => {
        e.preventDefault()
        if (href) api.shell.openExternal(href)
      }}
      className="cursor-pointer text-violet-600 underline underline-offset-2 hover:text-violet-500"
    >
      {children}
    </a>
  ),
  hr: () => <hr className="my-3 border-border" />,
  pre: ({ children }) => <pre className={cn(codeSurface, 'my-2 overflow-x-auto p-3')}>{children}</pre>,
  code: ({ className, children }) => {
    const text = String(children ?? '')
    // 行内代码：无语言 class 且单行
    if (!className && !text.includes('\n')) {
      return (
        <code className="rounded bg-foreground/10 px-1 py-0.5 font-mono text-[0.85em]">{children}</code>
      )
    }
    return <code className={cn('font-mono', className)}>{children}</code>
  },
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto">
      <table className="w-full border-collapse text-xs">{children}</table>
    </div>
  ),
  th: ({ children }) => <th className="border border-border px-2 py-1 text-left font-semibold">{children}</th>,
  td: ({ children }) => <td className="border border-border px-2 py-1">{children}</td>,
}

export function Markdown({ content, className }: { content: string; className?: string }) {
  return (
    <div className={cn('text-sm', className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>
        {content}
      </ReactMarkdown>
    </div>
  )
}
