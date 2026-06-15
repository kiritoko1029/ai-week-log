import { useState, useMemo, useEffect, useRef } from 'react'
import { ChevronDown, Search, FolderGit2, Check } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'

export interface ProjectOption {
  /** 实际值（repo.name），空字符串表示通用 */
  value: string
  /** 展示文本 */
  label: string
}

/**
 * 项目下拉选择，带搜索筛选。
 *
 * 用 Radix Select 时无法在弹层内放可输入的搜索框（键盘/焦点会被劫持），
 * 故改用受控 Dialog + Input 实现 combobox 语义：触发器外观与原生 Select 一致，
 * 打开后顶部是搜索框，下方是过滤后的项目列表。
 */
export function ProjectSelect({
  value,
  onChange,
  options,
  placeholder = '请选择',
  miscLabel = '日常工作（通用）',
}: {
  value: string
  onChange: (v: string) => void
  options: ProjectOption[]
  placeholder?: string
  miscLabel?: string
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  // 打开时清空搜索词并自动聚焦输入框
  useEffect(() => {
    if (open) {
      setQuery('')
      // Dialog 动画后再聚焦，避免抖动
      const t = setTimeout(() => inputRef.current?.focus(), 60)
      return () => clearTimeout(t)
    }
  }, [open])

  const selectedLabel = useMemo(() => {
    if (!value) return miscLabel
    return options.find((o) => o.value === value)?.label ?? value
  }, [value, options, miscLabel])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return options
    return options.filter(
      (o) => o.label.toLowerCase().includes(q) || o.value.toLowerCase().includes(q)
    )
  }, [options, query])

  const pick = (v: string) => {
    onChange(v)
    setOpen(false)
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex h-9 w-full items-center justify-between whitespace-nowrap rounded-md border border-input bg-background px-3 py-2 text-sm shadow-xs ring-offset-background placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 cursor-pointer [&>span]:line-clamp-1"
      >
        <span className={cn(value ? '' : 'text-muted-foreground')}>{selectedLabel || placeholder}</span>
        <ChevronDown className="h-4 w-4 opacity-50" />
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-[400px] gap-0 p-0">
          {/* 无障碍标题（视觉隐藏） */}
          <DialogTitle className="sr-only">选择项目</DialogTitle>
          <div className="border-b p-3">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={`搜索项目（共 ${options.length} 个）`}
                className="pl-8"
              />
            </div>
          </div>
          <div className="max-h-[300px] overflow-y-auto p-1">
            {/* 通用项始终置顶、不参与过滤 */}
            <button
              type="button"
              onClick={() => pick('')}
              className={cn(
                'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm outline-none hover:bg-accent hover:text-accent-foreground',
                !value && 'bg-accent text-accent-foreground'
              )}
            >
              <Check className={cn('h-4 w-4', !value ? 'opacity-100' : 'opacity-0')} />
              <span>{miscLabel}</span>
            </button>

            {filtered.length > 0 && <div className="my-1 h-px bg-muted" />}

            {filtered.map((o) => (
              <button
                key={o.value}
                type="button"
                onClick={() => pick(o.value)}
                className={cn(
                  'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm outline-none hover:bg-accent hover:text-accent-foreground',
                  value === o.value && 'bg-accent text-accent-foreground'
                )}
              >
                <Check className={cn('h-4 w-4 flex-shrink-0', value === o.value ? 'opacity-100' : 'opacity-0')} />
                <FolderGit2 className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
                <span className="truncate">{o.label}</span>
              </button>
            ))}

            {filtered.length === 0 && (
              <div className="py-6 text-center text-xs text-muted-foreground">
                没有匹配「{query}」的项目
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
