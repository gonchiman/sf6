import { useCallback, useEffect, useRef, useState } from 'react'
import type { SteamPlayerCountDateRange } from '../types/steamPlayerCount.ts'
import { createSteamPlayerCountController, initialSteamPlayerCountState, steamPlayerCountFeed, type SteamPlayerCountFeed } from './steamPlayerCountFeed.ts'
import { startPublishedDataRefresh } from './publishedDataRefresh.ts'

export function useSteamPlayerCount(range: SteamPlayerCountDateRange | null = null, feed: SteamPlayerCountFeed = steamPlayerCountFeed) {
  const [state, setState] = useState(() => initialSteamPlayerCountState(range))
  const controllerRef = useRef<ReturnType<typeof createSteamPlayerCountController> | null>(null)
  const rangeRef = useRef(range)
  rangeRef.current = range
  useEffect(() => {
    const controller = createSteamPlayerCountController(feed, setState, rangeRef.current)
    controllerRef.current = controller
    setState(controller.getState())
    void controller.refresh()
    const stopRefresh = startPublishedDataRefresh(() => { void controller.refresh() })
    return () => {
      controller.dispose()
      stopRefresh()
      if (controllerRef.current === controller) controllerRef.current = null
    }
  }, [feed])
  useEffect(() => { controllerRef.current?.setRange(rangeRef.current) }, [range?.from, range?.to])
  const refresh = useCallback(() => { void controllerRef.current?.refresh() }, [])
  return { ...state, refresh }
}
