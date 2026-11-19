import React, { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { platform } from '@renderer/utils/init'
import {
  windowClose,
  windowIsMaximized,
  windowMaximize,
  windowMinimize
} from '@renderer/utils/ipc'

const WindowControls: React.FC = () => {
  const [isMaximized, setIsMaximized] = useState(false)
  const [isFocused, setIsFocused] = useState(document.hasFocus())
  const [suppressHover, setSuppressHover] = useState<'close' | 'minimize' | null>(null)
  const isMac = platform === 'darwin'

  useEffect(() => {
    windowIsMaximized().then(setIsMaximized).catch(() => void 0)

    const offMaximize = window.skipnet.on('window-maximized', () => setIsMaximized(true))
    const offUnmaximize = window.skipnet.on('window-unmaximized', () => setIsMaximized(false))

    const onFocus = (): void => setIsFocused(true)
    const onBlur = (): void => setIsFocused(false)
    window.addEventListener('focus', onFocus)
    window.addEventListener('blur', onBlur)

    const onAnyPointerMove = (): void => setSuppressHover(null)
    document.addEventListener('pointermove', onAnyPointerMove, { passive: true })

    return () => {
      offMaximize()
      offUnmaximize()
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('blur', onBlur)
      document.removeEventListener('pointermove', onAnyPointerMove)
    }
  }, [])

  const handleMinimize = (e: React.MouseEvent<HTMLButtonElement>): void => {
    setSuppressHover('minimize')
    e.currentTarget.blur()
    void windowMinimize().catch((err: unknown) => {
      toast.error('Не удалось свернуть окно', {
        description: err instanceof Error ? err.message : String(err)
      })
    })
  }
  const handleMaximize = async (): Promise<void> => {
    try {
      await windowMaximize()
      setIsMaximized(Boolean(await windowIsMaximized()))
    } catch (err) {
      toast.error('Не удалось изменить размер окна', {
        description: err instanceof Error ? err.message : String(err)
      })
    }
  }
  const handleClose = (e: React.MouseEvent<HTMLButtonElement>): void => {
    setSuppressHover('close')
    e.currentTarget.blur()
    void windowClose().catch((err: unknown) => {
      toast.error('Не удалось закрыть окно', {
        description: err instanceof Error ? err.message : String(err)
      })
    })
  }

  // Cleared when the cursor actually leaves the button — at that point real
  // :hover is gone too and we can re-enable the normal hover styling.
  const clearSuppressed = (): void => setSuppressHover(null)

  const closeBtn = (
    <button
      key="close"
      className={`wc-btn wc-close${suppressHover === 'close' ? ' wc-suppress-hover' : ''}`}
      onClick={handleClose}
      onPointerLeave={clearSuppressed}
      onPointerMove={clearSuppressed}
      aria-label="Закрыть окно"
    >
      <svg viewBox="0 0 10 10" fill="none">
        <path
          d="M1.5 1.5L8.5 8.5M8.5 1.5L1.5 8.5"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
        />
      </svg>
    </button>
  )

  const minimizeBtn = (
    <button
      key="minimize"
      className={`wc-btn wc-minimize${suppressHover === 'minimize' ? ' wc-suppress-hover' : ''}`}
      onClick={handleMinimize}
      onPointerLeave={clearSuppressed}
      onPointerMove={clearSuppressed}
      aria-label="Свернуть окно"
    >
      <svg viewBox="0 0 10 10" fill="none">
        <path d="M1.5 5H8.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      </svg>
    </button>
  )

  const maximizeBtn = (
    <button
      key="maximize"
      className="wc-btn wc-maximize"
      onClick={handleMaximize}
      aria-label={isMaximized ? 'Восстановить окно' : 'Развернуть окно'}
    >
      {isMaximized ? (
        <svg viewBox="0 0 10 10" fill="none">
          <path
            d="M3 1H8.5A.5.5 0 0 1 9 1.5V7"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <rect x="1" y="3" width="6" height="6" rx="0.5" stroke="currentColor" strokeWidth="1.2" />
        </svg>
      ) : (
        <svg viewBox="0 0 10 10" fill="none">
          <rect
            x="1.5"
            y="1.5"
            width="7"
            height="7"
            rx="0.5"
            stroke="currentColor"
            strokeWidth="1.3"
          />
        </svg>
      )}
    </button>
  )

  const buttons = isMac
    ? [closeBtn, minimizeBtn, maximizeBtn]
    : [minimizeBtn, maximizeBtn, closeBtn]

  return (
    <div className={`wc-group app-nodrag ${isMac ? `wc-mac${!isFocused ? ' wc-blurred' : ''}` : 'wc-win'}`}>{buttons}</div>
  )
}

export default WindowControls
