import { Button } from '@renderer/components/ui/button'
import { platform } from '@renderer/utils/init'
import WindowControls from '@renderer/components/window-controls'
import { cn } from '@renderer/lib/utils'
import React from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { ChevronLeft } from 'lucide-react'

// Every page reachable from the sidebar. These are top-level sections, so the
// header must not show a "back" arrow on them.
const sidebarPaths = new Set([
  '/home',
  '/telegram',
  '/zapret',
  '/hosts',
  '/logs',
  '/settings',
  '/about'
])
const isMac = platform === 'darwin'

interface Props {
  title?: React.ReactNode
  header?: React.ReactNode
  children?: React.ReactNode
  contentClassName?: string
  showBackButton?: boolean
}

const BasePage: React.FC<Props> = (props) => {
  const location = useLocation()
  const navigate = useNavigate()
  const isSubPage = !sidebarPaths.has(location.pathname)

  return (
    <div className="w-full h-full">
      <div className="sticky top-0 z-40 h-14.25 w-full">
        <div className="app-drag px-2 pt-3 pb-2 flex justify-between h-14.25">
          <div className="title h-full text-lg leading-8 flex items-center gap-1">
            {(isSubPage || props.showBackButton) && (
              <Button
                size="icon-sm"
                variant="ghost"
                className="app-nodrag"
                aria-label="Назад"
                onClick={() => navigate(-1)}
              >
                <ChevronLeft className="size-5" />
              </Button>
            )}
            {props.title}
          </div>
          <div className="header flex gap-1 h-full items-center app-nodrag">
            {props.header}
            {!isMac && <WindowControls />}
          </div>
        </div>
      </div>
      <div
        className={cn(
          'content h-[calc(100vh-57px)] overflow-y-auto custom-scrollbar',
          props.contentClassName
        )}
      >
        {props.children}
      </div>
    </div>
  )
}

export default BasePage
