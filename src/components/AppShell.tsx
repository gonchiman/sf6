import { useEffect, useRef, useState, type ReactNode } from 'react'
import { HOME_HREF, type NavigationPage } from '../lib/navigation'
import { AppSidebar } from './AppSidebar'
import '../navigation.css'

const SIDEBAR_DRAWER_QUERY = '(max-width: 1140px)'

type AppShellProps = {
  activePage: NavigationPage
  title: string
  children: ReactNode
}

export function AppShell({ activePage, title, children }: AppShellProps) {
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const sidebarToggleRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!sidebarOpen) return

    const drawerMedia = window.matchMedia(SIDEBAR_DRAWER_QUERY)
    if (!drawerMedia.matches) {
      setSidebarOpen(false)
      return
    }

    const previousOverflow = document.body.style.overflow
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopImmediatePropagation()
      setSidebarOpen(false)
      window.requestAnimationFrame(() => sidebarToggleRef.current?.focus())
    }
    const handleDesktopChange = (event: MediaQueryListEvent) => {
      if (event.matches) return
      setSidebarOpen(false)
      window.requestAnimationFrame(() => {
        document.querySelector<HTMLAnchorElement>('.sidebar-nav-link.active')?.focus()
      })
    }

    document.body.style.overflow = 'hidden'
    window.addEventListener('keydown', handleKeyDown, { capture: true })
    drawerMedia.addEventListener('change', handleDesktopChange)
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', handleKeyDown, { capture: true })
      drawerMedia.removeEventListener('change', handleDesktopChange)
    }
  }, [sidebarOpen])

  const closeSidebar = () => {
    if (!sidebarOpen) return
    setSidebarOpen(false)
    if (window.matchMedia(SIDEBAR_DRAWER_QUERY).matches) {
      window.requestAnimationFrame(() => sidebarToggleRef.current?.focus())
    }
  }

  return (
    <div className="app-shell">
      <AppSidebar activePage={activePage} open={sidebarOpen} onClose={closeSidebar} />

      <div className="app-main" inert={sidebarOpen ? true : undefined}>
        <header className="mobile-topbar">
          <button
            ref={sidebarToggleRef}
            className="sidebar-toggle"
            type="button"
            aria-controls="app-sidebar"
            aria-expanded={sidebarOpen}
            onClick={() => setSidebarOpen(true)}
          >
            <span className="sidebar-toggle-icon" aria-hidden="true"><i /><i /><i /></span>
            <span>メニュー</span>
          </button>
          <span className="mobile-page-title">{title}</span>
          <a className="mobile-brand-mark" href={HOME_HREF} aria-label="スト6 バランス分析 ホーム">6</a>
        </header>

        <main className="app-content" id={activePage}>
          <header className="page-header">
            <h1>{title}</h1>
          </header>
          {children}
        </main>
      </div>
    </div>
  )
}
