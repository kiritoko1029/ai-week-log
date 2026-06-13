import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/globals.css'
import { App } from './App'
import { ThemeProvider } from '@/hooks/useTheme'
import { ConfigProvider } from '@/hooks/useConfig'
import { NavProvider } from '@/hooks/useNav'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Toaster } from '@/components/ui/sonner'

const root = document.getElementById('root')!
createRoot(root).render(
  <StrictMode>
    <ThemeProvider>
      <ConfigProvider>
        <TooltipProvider delayDuration={200}>
          <NavProvider>
            <App />
            <Toaster />
          </NavProvider>
        </TooltipProvider>
      </ConfigProvider>
    </ThemeProvider>
  </StrictMode>
)
