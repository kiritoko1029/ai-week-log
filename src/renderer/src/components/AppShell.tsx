import {
  LayoutDashboard,
  FileText,
  CalendarClock,
  StickyNote,
  FolderGit2,
  History,
  Settings,
  LineChart,
} from 'lucide-react'
import { useNav, type PageId } from '@/hooks/useNav'
import { useConfig } from '@/hooks/useConfig'
import { cn } from '@/lib/utils'

interface NavItem {
  id: PageId
  label: string
  icon: React.ReactNode
  badge?: number
  badgeClass?: string
}

interface NavSection {
  title: string
  items: NavItem[]
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const { page, navigate } = useNav()
  const { config } = useConfig()

  const repoCount = config?.repos.length ?? 0

  const sections: NavSection[] = [
    {
      title: '概览',
      items: [
        {
          id: 'dashboard',
          label: '仪表盘',
          icon: <LayoutDashboard className="h-[18px] w-[18px]" />,
        },
      ],
    },
    {
      title: '生成',
      items: [
        {
          id: 'generate',
          label: '生成周报 / 日报',
          icon: <FileText className="h-[18px] w-[18px]" />,
        },
        {
          id: 'daily',
          label: '今日日报',
          icon: <CalendarClock className="h-[18px] w-[18px]" />,
        },
      ],
    },
    {
      title: '笔记',
      items: [
        {
          id: 'notes',
          label: '笔记管理',
          icon: <StickyNote className="h-[18px] w-[18px]" />,
        },
      ],
    },
    {
      title: '管理',
      items: [
        {
          id: 'repos',
          label: '仓库管理',
          icon: <FolderGit2 className="h-[18px] w-[18px]" />,
          badge: repoCount,
        },
        {
          id: 'history',
          label: '历史记录',
          icon: <History className="h-[18px] w-[18px]" />,
        },
      ],
    },
    {
      title: '配置',
      items: [
        {
          id: 'settings',
          label: 'AI 与输出设置',
          icon: <Settings className="h-[18px] w-[18px]" />,
        },
      ],
    },
  ]

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      {/* 标题栏（可拖拽） */}
      <header
        data-app-region="drag"
        className="flex h-[38px] flex-shrink-0 items-center border-b bg-background/70 px-4 backdrop-blur"
      >
        <div className="flex min-w-[56px] items-center text-primary">
          <LineChart className="h-[15px] w-[15px]" />
        </div>
        <span className="flex-1 text-center text-xs font-semibold tracking-wide text-muted-foreground">
          WeekLog — Git 周报 / 日报生成工具
        </span>
        <div className="min-w-[56px]" />
      </header>

      <div className="flex flex-1 overflow-hidden">
        {/* 侧边栏 */}
        <aside className="flex w-[240px] flex-shrink-0 flex-col overflow-y-auto border-r bg-sidebar">
          <div className="border-b px-5 pb-4 pt-5">
            <h1 className="text-xl font-bold tracking-tight">WeekLog</h1>
            <span className="font-mono text-xs text-muted-foreground">v1.1.0 · 本地运行</span>
          </div>
          <nav className="flex-1 px-3 pb-3 pt-4">
            {sections.map((sec) => (
              <div key={sec.title} className="mb-4">
                <div className="px-3 pb-1.5 font-mono text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  {sec.title}
                </div>
                <ul className="space-y-0.5">
                  {sec.items.map((item) => {
                    const active = page === item.id
                    return (
                      <li key={item.id}>
                        <button
                          data-app-region="no-drag"
                          onClick={() => navigate(item.id)}
                          className={cn(
                            'flex w-full cursor-pointer items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                            active
                              ? 'bg-primary text-primary-foreground shadow-sm'
                              : 'text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground'
                          )}
                        >
                          {item.icon}
                          <span className="flex-1 text-left">{item.label}</span>
                          {item.badge != null && item.badge > 0 && (
                            <span
                              className={cn(
                                'rounded-full px-2 py-px font-mono text-[11px] font-semibold',
                                active ? 'bg-primary-foreground text-primary' : 'bg-muted text-muted-foreground'
                              )}
                            >
                              {item.badge}
                            </span>
                          )}
                        </button>
                      </li>
                    )
                  })}
                </ul>
              </div>
            ))}
          </nav>
        </aside>

        {/* 内容区 */}
        <main className="flex-1 overflow-y-auto">
          <div key={page} className="mx-auto max-w-[980px] animate-fade-in p-8">
            {children}
          </div>
        </main>
      </div>
    </div>
  )
}
