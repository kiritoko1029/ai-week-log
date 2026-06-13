import { useNav } from '@/hooks/useNav'
import { AppShell } from '@/components/AppShell'
import { Statusbar } from '@/components/Statusbar'
import { DashboardPage } from '@/pages/DashboardPage'
import { GeneratePage } from '@/pages/GeneratePage'
import { DailyPage } from '@/pages/DailyPage'
import { NotesPage } from '@/pages/NotesPage'
import { ReposPage } from '@/pages/ReposPage'
import { HistoryPage } from '@/pages/HistoryPage'
import { SettingsPage } from '@/pages/SettingsPage'

export function App() {
  const { page } = useNav()
  return (
    <>
      <AppShell>
        {page === 'dashboard' && <DashboardPage />}
        {page === 'generate' && <GeneratePage />}
        {page === 'daily' && <DailyPage />}
        {page === 'notes' && <NotesPage />}
        {page === 'repos' && <ReposPage />}
        {page === 'history' && <HistoryPage />}
        {page === 'settings' && <SettingsPage />}
      </AppShell>
      <Statusbar />
    </>
  )
}
