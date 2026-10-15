import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from 'react'
import { balanceAdjustmentDetailHash, parseHashRoute, type AppRoute } from '../lib/routes'
import { BalanceAdjustmentDetailPage } from './BalanceAdjustmentDetailPage'
import { BalanceAdjustmentsPage } from './BalanceAdjustmentsPage'

type BalanceRoute = Extract<AppRoute, { page: 'balance-adjustments' | 'balance-adjustment-detail' }>
type ListPosition = {
  top: number
  trigger: HTMLElement | null
  tables: { element: HTMLElement; top: number; left: number }[]
}

const RETURN_STATE_KEY = 'sf6BalanceAdjustmentReturn'

/** Keep the overview alive while its separate detail page is open. */
export function BalanceAdjustmentPages({ route, onRouteChange }: {
  route: BalanceRoute
  onRouteChange: () => void
}) {
  const detailId = route.page === 'balance-adjustment-detail' ? route.adjustmentId : null
  const [listVisited, setListVisited] = useState(route.page === 'balance-adjustments')
  const [returnToken] = useState(() => crypto.randomUUID())
  const listRef = useRef<HTMLDivElement>(null)
  const detailRef = useRef<HTMLDivElement>(null)
  const positionRef = useRef<ListPosition | null>(null)
  const previousDetailId = useRef<string | null>(null)

  const capturePosition = (trigger?: HTMLElement) => {
    const list = listRef.current
    if (!list || list.hidden) return
    const active = trigger ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null)
    positionRef.current = {
      top: window.scrollY,
      trigger: active && list.contains(active) ? active : null,
      tables: [...list.querySelectorAll<HTMLElement>('.balance-adjustment-scroll, .balance-adjustment-count-chart-scroll')].map(element => ({
        element, top: element.scrollTop, left: element.scrollLeft,
      })),
    }
  }

  useEffect(() => {
    const previous = window.history.scrollRestoration
    window.history.scrollRestoration = 'manual'
    return () => { window.history.scrollRestoration = previous }
  }, [])

  useEffect(() => {
    if (route.page !== 'balance-adjustments') return
    setListVisited(true)
    let captured = false
    // popstate precedes native restoration of the table's scroll position.
    // Do not overwrite that snapshot in the subsequent hashchange event.
    const leavingList = () => {
      if (captured || parseHashRoute(window.location.hash).page !== 'balance-adjustment-detail') return
      capturePosition()
      captured = true
    }
    window.addEventListener('popstate', leavingList)
    window.addEventListener('hashchange', leavingList)
    return () => {
      window.removeEventListener('popstate', leavingList)
      window.removeEventListener('hashchange', leavingList)
    }
  }, [route.page])

  useLayoutEffect(() => {
    const wasDetail = previousDetailId.current !== null
    const changedDetail = previousDetailId.current !== detailId
    previousDetailId.current = detailId
    if (detailId !== null && changedDetail) {
      detailRef.current?.querySelector<HTMLAnchorElement>('.balance-adjustment-back-link')?.focus({ preventScroll: true })
      window.scrollTo({ top: 0, behavior: 'instant' })
      return
    }
    if (detailId !== null || !wasDetail) return
    if (!positionRef.current) {
      window.scrollTo({ top: 0, behavior: 'instant' })
      return
    }
    const position = positionRef.current
    const restore = () => {
      if (!listRef.current || listRef.current.hidden) return
      if (position.trigger?.isConnected) position.trigger.focus({ preventScroll: true })
      for (const table of position.tables) {
        if (!table.element.isConnected) continue
        table.element.scrollTop = table.top
        table.element.scrollLeft = table.left
      }
      window.scrollTo({ top: position.top, behavior: 'instant' })
    }
    restore()
    const frame = window.requestAnimationFrame(restore)
    return () => window.cancelAnimationFrame(frame)
  }, [detailId])

  const openDetail = (event: MouseEvent<HTMLAnchorElement>, adjustmentId: string, scope: string | null) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    capturePosition(event.currentTarget)
    window.history.pushState({ [RETURN_STATE_KEY]: returnToken }, '', balanceAdjustmentDetailHash(adjustmentId, scope))
    onRouteChange()
  }

  const backToList = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    if (!positionRef.current || window.history.state?.[RETURN_STATE_KEY] !== returnToken) return
    event.preventDefault()
    window.history.back()
  }

  const changeScope = (scope: string | null) => {
    if (route.page !== 'balance-adjustment-detail') return
    window.history.replaceState(window.history.state, '', balanceAdjustmentDetailHash(route.adjustmentId, scope))
    onRouteChange()
  }

  return <section className="balance-adjustment-pages" aria-label={detailId === null ? 'バトル変更一覧' : 'バトル変更詳細'}>
    <div ref={listRef} hidden={detailId !== null}>
      {(listVisited || detailId === null) && <BalanceAdjustmentsPage onOpenDetail={openDetail} />}
    </div>
    {route.page === 'balance-adjustment-detail' && <div ref={detailRef}>
      <BalanceAdjustmentDetailPage adjustmentId={route.adjustmentId} scope={route.scope} onScopeChange={changeScope} onBack={backToList} />
    </div>}
  </section>
}
