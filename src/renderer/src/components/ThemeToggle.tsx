import { Monitor, Moon, Sun } from 'lucide-react'
import { useTheme, type Theme } from '@/hooks/useTheme'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { cn } from '@/lib/utils'

/** 三态主题切换：浅色 / 深色 / 跟随系统 */
export function ThemeToggle({ className }: { className?: string }) {
  const { theme, setTheme } = useTheme()
  const items: { value: Theme; label: string; icon: React.ReactNode }[] = [
    { value: 'light', label: '浅色', icon: <Sun className="h-3.5 w-3.5" /> },
    { value: 'dark', label: '深色', icon: <Moon className="h-3.5 w-3.5" /> },
    { value: 'auto', label: '系统', icon: <Monitor className="h-3.5 w-3.5" /> },
  ]
  return (
    <ToggleGroup
      type="single"
      value={theme}
      onValueChange={(v) => {
        if (v) setTheme(v as Theme)
      }}
      className={cn('w-fit', className)}
    >
      {items.map((it) => (
        <ToggleGroupItem key={it.value} value={it.value} className="gap-1">
          {it.icon}
          {it.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}
