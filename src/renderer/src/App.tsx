import { useNav } from '@/hooks/useNav'
import { AppShell } from '@/components/AppShell'
import { Statusbar } from '@/components/Statusbar'
import { DashboardPage } from '@/pages/DashboardPage'
import { GeneratePage } from '@/pages/GeneratePage'
import { DailyPage } from '@/pages/DailyPage'
import { ChatPage } from '@/pages/ChatPage'
import { NotesPage } from '@/pages/NotesPage'
import { ReposPage } from '@/pages/ReposPage'
import { HistoryPage } from '@/pages/HistoryPage'
import { SettingsPage } from '@/pages/SettingsPage'

// macOS hiddenInset 标题栏会浮在内容之上，需要为交通灯按钮预留空间
// navigator.platform 在 Electron 渲染进程可用（'MacIntel'）
const isMac =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/i.test(navigator.platform)

export function App() {
  const { page } = useNav()
  return (
    // 整体为一列：AppShell 占满剩余空间 + Statusbar 固定 32px
    // 关键：用 h-screen + flex-col，AppShell 用 flex-1 + min-h-0，
    // 这样 AppShell 内部溢出会被自身 overflow 吸收，不再把 Statusbar 顶出视口、产生整页滚动条
    <div className="flex h-screen flex-col overflow-hidden">
      <AppShell isMac={isMac}>
        {page === 'dashboard' && <DashboardPage />}
        {page === 'generate' && <GeneratePage />}
        {page === 'daily' && <DailyPage />}
        {page === 'chat' && <ChatPage />}
        {page === 'notes' && <NotesPage />}
        {page === 'repos' && <ReposPage />}
        {page === 'history' && <HistoryPage />}
        {page === 'settings' && <SettingsPage />}
      </AppShell>
      <Statusbar />
    </div>
  )
}
