import { Toaster as Sonner } from 'sonner'
import { useTheme } from '@/hooks/useTheme'

/** shadcn 风格的 Sonner toaster，跟随当前主题 */
export function Toaster() {
  const { resolved } = useTheme()
  return (
    <Sonner
      theme={resolved === 'dark' ? 'dark' : 'light'}
      position="bottom-right"
      richColors
      closeButton
      toastOptions={{
        classNames: {
          toast: 'group font-sans',
        },
      }}
    />
  )
}
