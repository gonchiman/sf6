import { useCallback, useEffect, useRef, useState } from 'react'
import type { SteamPlayerCountRangeSelection } from '../types/steamPlayerCount.ts'
import { createSteamPlayerCountController, initialSteamPlayerCountState, steamPlayerCountFeed, type SteamPlayerCountFeed } from './steamPlayerCountFeed.ts'
import { startPublishedDataRefresh } from './publishedDataRefresh.ts'

const selectionKey = (selection: SteamPlayerCountRangeSelection | null): string => typeof selection === 'string' ? selection
  : selection ? JSON.stringify([selection.from, selection.to]) : '7d'

export function useSteamPlayerCount(selection: SteamPlayerCountRangeSelection | null = null, feed: SteamPlayerCountFeed = steamPlayerCountFeed) {
  const key = selectionKey(selection)
  const [snapshot, setSnapshot] = useState(() => ({ feed, key, state: initialSteamPlayerCountState(selection) }))
  const controllerRef = useRef<{ feed: SteamPlayerCountFeed; controller: ReturnType<typeof createSteamPlayerCountController> } | null>(null)
  const selectionRef = useRef(selection)
  selectionRef.current = selection
  useEffect(() => {
    const controller = createSteamPlayerCountController(feed,
      state => setSnapshot({ feed, key: selectionKey(controller.getSelection()), state }), selectionRef.current)
    controllerRef.current = { feed, controller }
    setSnapshot({ feed, key: selectionKey(controller.getSelection()), state: controller.getState() })
    void controller.refresh()
    const stopRefresh = startPublishedDataRefresh(() => { void controller.refresh() })
    return () => {
      controller.dispose()
      stopRefresh()
      if (controllerRef.current?.controller === controller) controllerRef.current = null
    }
  }, [feed])
  useEffect(() => {
    if (controllerRef.current?.feed === feed) controllerRef.current.controller.setRange(selectionRef.current)
  }, [feed, key])
  const refresh = useCallback(() => {
    if (controllerRef.current?.feed === feed) void controllerRef.current.controller.refresh()
  }, [feed])
  // Effects run after rendering: a newly selected title or period must not show the previous values.
  const state = snapshot.feed === feed && snapshot.key === key ? snapshot.state : initialSteamPlayerCountState(selection)
  return { ...state, refresh }
}
