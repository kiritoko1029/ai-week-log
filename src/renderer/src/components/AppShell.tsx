import { useState } from 'react'
import {
  LayoutDashboard,
  FileText,
  CalendarClock,
  StickyNote,
  FolderGit2,
  History,
  Settings,
  LineChart,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
} from 'lucide-react'
import { useNav, type PageId } from '@/hooks/useNav'
import { useConfig } from '@/hooks/useConfig'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

/** GitHub mark（lucide-react 本版本无品牌图标，内联官方 mark SVG） */
function GithubIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" className={className} aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  )
}

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

export function AppShell({ children, isMac }: { children: React.ReactNode; isMac?: boolean }) {
  const { page, navigate } = useNav()
  const { config } = useConfig()
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(false)

  const repoCount = config?.repos.length ?? 0
  const sidebarToggleLabel = sidebarCollapsed ? '展开侧边栏' : '收起侧边栏'

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
      title: '助手',
      items: [
        {
          id: 'chat',
          label: 'AI 问答',
          icon: <MessageSquare className="h-[18px] w-[18px]" />,
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
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {/* 标题栏（可拖拽） */}
      {/* macOS hiddenInset 下交通灯按钮浮在内容之上，需在左侧预留约 80px 空间 */}
      <header
        data-app-region="drag"
        className={cn(
          'flex h-[38px] flex-shrink-0 items-center border-b bg-background/70 backdrop-blur',
          isMac ? 'pl-[80px] pr-4' : 'px-4'
        )}
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
        <TooltipProvider delayDuration={120}>
          <aside
            className={cn(
              'flex flex-shrink-0 flex-col overflow-y-auto border-r bg-sidebar transition-[width] duration-200 ease-out',
              sidebarCollapsed ? 'w-[72px]' : 'w-[240px]'
            )}
          >
            <div className={cn('border-b pb-4 pt-5', sidebarCollapsed ? 'px-3' : 'px-5')}>
              <div
                className={cn(
                  'flex items-center',
                  sidebarCollapsed ? 'flex-col gap-2' : 'justify-between gap-2'
                )}
              >
                <div
                  className={cn(
                    'flex min-w-0 items-center gap-2 text-primary',
                    sidebarCollapsed && 'justify-center'
                  )}
                >
                  {sidebarCollapsed && <LineChart className="h-[18px] w-[18px]" />}
                  <h1 className={cn('text-xl font-bold tracking-tight text-foreground', sidebarCollapsed && 'sr-only')}>
                    WeekLog
                  </h1>
                </div>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      data-app-region="no-drag"
                      type="button"
                      onClick={() => setSidebarCollapsed((value) => !value)}
                      aria-label={sidebarToggleLabel}
                      aria-pressed={sidebarCollapsed}
                      title={sidebarToggleLabel}
                      className="inline-flex h-8 w-8 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {sidebarCollapsed ? (
                        <PanelLeftOpen className="h-4 w-4" />
                      ) : (
                        <PanelLeftClose className="h-4 w-4" />
                      )}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="right">{sidebarToggleLabel}</TooltipContent>
                </Tooltip>
              </div>
            </div>
            <nav className={cn('flex-1 pb-3 pt-4', sidebarCollapsed ? 'px-2' : 'px-3')}>
              {sections.map((sec) => (
                <div key={sec.title} className={cn(sidebarCollapsed ? 'mb-1' : 'mb-4')}>
                  <div
                    className={cn(
                      'px-3 pb-1.5 font-mono text-[11px] font-semibold uppercase tracking-wider text-muted-foreground',
                      sidebarCollapsed && 'sr-only'
                    )}
                  >
                    {sec.title}
                  </div>
                  <ul className="space-y-0.5">
                    {sec.items.map((item) => {
                      const active = page === item.id
                      const navButton = (
                        <button
                          data-app-region="no-drag"
                          type="button"
                          onClick={() => navigate(item.id)}
                          aria-label={item.label}
                          className={cn(
                            'relative flex w-full cursor-pointer items-center rounded-md text-sm font-medium transition-colors',
                            sidebarCollapsed ? 'justify-center px-0 py-2.5' : 'gap-3 px-3 py-2',
                            active
                              ? 'bg-primary text-primary-foreground shadow-sm'
                              : 'text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground'
                          )}
                        >
                          {item.icon}
                          <span className={cn('flex-1 text-left', sidebarCollapsed && 'sr-only')}>{item.label}</span>
                          {item.badge != null && item.badge > 0 && (
                            <span
                              className={cn(
                                sidebarCollapsed
                                  ? 'absolute -right-1 -top-1 flex size-5 items-center justify-center rounded-full p-0 font-mono text-[10px] font-semibold'
                                  : 'rounded-full px-2 py-px font-mono text-[11px] font-semibold',
                                active ? 'bg-primary-foreground text-primary' : 'bg-muted text-muted-foreground'
                              )}
                            >
                              {item.badge}
                            </span>
                          )}
                        </button>
                      )
                      return (
                        <li key={item.id}>
                          {sidebarCollapsed ? (
                            <Tooltip>
                              <TooltipTrigger asChild>{navButton}</TooltipTrigger>
                              <TooltipContent side="right">{item.label}</TooltipContent>
                            </Tooltip>
                          ) : (
                            navButton
                          )}
                        </li>
                      )
                    })}
                  </ul>
                </div>
              ))}
            </nav>
            <div
              className={cn(
                'flex flex-shrink-0 border-t py-3',
                sidebarCollapsed ? 'flex-col items-center gap-2 px-2' : 'items-center gap-2 px-5'
              )}
            >
              <span className={cn('font-mono text-xs text-muted-foreground', sidebarCollapsed && 'sr-only')}>
                v{__APP_VERSION__}
              </span>
              {sidebarCollapsed ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      data-app-region="no-drag"
                      type="button"
                      onClick={() => api.shell.openExternal('https://github.com/kiritoko1029/ai-week-log')}
                      className="inline-flex h-8 w-8 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                      title="GitHub 仓库"
                      aria-label="GitHub 仓库"
                    >
                      <GithubIcon className="h-3.5 w-3.5" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="right">GitHub 仓库</TooltipContent>
                </Tooltip>
              ) : (
                <button
                  data-app-region="no-drag"
                  type="button"
                  onClick={() => api.shell.openExternal('https://github.com/kiritoko1029/ai-week-log')}
                  className="text-muted-foreground transition-colors hover:text-foreground"
                  title="GitHub 仓库"
                  aria-label="GitHub 仓库"
                >
                  <GithubIcon className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          </aside>
        </TooltipProvider>

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
