import { useCallback, useEffect, useRef, useState } from 'react'
import type { SteamPlayerCountDateRange } from '../types/steamPlayerCount.ts'
import { createSteamPlayerCountController, initialSteamPlayerCountState, steamPlayerCountFeed, type SteamPlayerCountFeed } from './steamPlayerCountFeed.ts'
import { startPublishedDataRefresh } from './publishedDataRefresh.ts'

export function useSteamPlayerCount(range: SteamPlayerCountDateRange | null = null, feed: SteamPlayerCountFeed = steamPlayerCountFeed) {
  const [snapshot, setSnapshot] = useState(() => ({ feed, state: initialSteamPlayerCountState(range) }))
  const controllerRef = useRef<{ feed: SteamPlayerCountFeed; controller: ReturnType<typeof createSteamPlayerCountController> } | null>(null)
  const rangeRef = useRef(range)
  rangeRef.current = range
  useEffect(() => {
    const controller = createSteamPlayerCountController(feed, state => setSnapshot({ feed, state }), rangeRef.current)
    controllerRef.current = { feed, controller }
    setSnapshot({ feed, state: controller.getState() })
    void controller.refresh()
    const stopRefresh = startPublishedDataRefresh(() => { void controller.refresh() })
    return () => {
      controller.dispose()
      stopRefresh()
      if (controllerRef.current?.controller === controller) controllerRef.current = null
    }
  }, [feed])
  useEffect(() => {
    if (controllerRef.current?.feed === feed) controllerRef.current.controller.setRange(rangeRef.current)
  }, [feed, range?.from, range?.to])
  const refresh = useCallback(() => {
    if (controllerRef.current?.feed === feed) void controllerRef.current.controller.refresh()
  }, [feed])
  // Effects run after rendering: never pair a newly selected title with the previous feed's values.
  const state = snapshot.feed === feed ? snapshot.state : initialSteamPlayerCountState(range)
  return { ...state, refresh }
}
