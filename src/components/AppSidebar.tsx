import { useEffect, useRef } from 'react'
import { APP_NAV_ITEMS, HOME_HREF, type NavigationPage } from '../lib/navigation'

type AppSidebarProps = {
  activePage: NavigationPage
  open: boolean
  onClose: () => void
}

export function AppSidebar({ activePage, open, onClose }: AppSidebarProps) {
  const sidebarRef = useRef<HTMLElement>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return

    const frame = window.requestAnimationFrame(() => closeButtonRef.current?.focus())
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return

      const controls = sidebarRef.current?.querySelectorAll<HTMLElement>('a[href], button:not([disabled])')
      const first = controls?.[0]
      const last = controls?.[controls.length - 1]
      if (!first || !last) return

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.cancelAnimationFrame(frame)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [open])

  return (
    <>
      <aside
        ref={sidebarRef}
        className={`app-sidebar ${open ? 'open' : ''}`}
        id="app-sidebar"
        role={open ? 'dialog' : undefined}
        aria-modal={open ? true : undefined}
        aria-label="メインナビゲーション"
      >
        <div className="sidebar-header">
          <a className="site-brand" href={HOME_HREF} onClick={onClose} aria-label="スト6 バランス分析 ホーム">
            <span className="brand-mark" aria-hidden="true">6</span>
            <span className="brand-copy">
              <span className="eyebrow">STREET FIGHTER 6</span>
              <span className="brand-title">バランス分析</span>
            </span>
          </a>
          <button ref={closeButtonRef} className="sidebar-close" type="button" onClick={onClose} aria-label="メニューを閉じる">
            <span aria-hidden="true">×</span>
          </button>
        </div>

        <nav className="sidebar-nav" aria-label="メインページ">
          {APP_NAV_ITEMS.map((item, index) => (
            <a
              key={item.id}
              className={`sidebar-nav-link ${item.id === activePage ? 'active' : ''}`}
              href={item.href}
              aria-current={item.id === activePage ? 'page' : undefined}
              onClick={onClose}
            >
              <span className="sidebar-nav-index" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>
              <span className="sidebar-nav-title">{item.label}</span>
            </a>
          ))}
        </nav>
      </aside>
      <button
        className={`sidebar-backdrop ${open ? 'visible' : ''}`}
        type="button"
        tabIndex={-1}
        onClick={onClose}
        aria-hidden={!open}
        aria-label="メニューを閉じる"
      />
    </>
  )
}
