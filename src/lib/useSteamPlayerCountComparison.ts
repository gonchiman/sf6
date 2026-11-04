import { useCallback, useEffect, useRef, useState } from 'react'
import type { SteamPlayerCountAppId, SteamPlayerCountRangeSelection } from '../types/steamPlayerCount.ts'
import { createSteamPlayerCountComparisonController, initialSteamPlayerCountComparisonState, steamPlayerCountComparisonAppIds } from './steamPlayerCountComparisonFeed.ts'
import { startPublishedDataRefresh } from './publishedDataRefresh.ts'

const selectionKey = (selection: SteamPlayerCountRangeSelection) => typeof selection === 'string' ? selection : JSON.stringify([selection.from, selection.to])

export function useSteamPlayerCountComparison(appIds: readonly SteamPlayerCountAppId[], selection: SteamPlayerCountRangeSelection) {
  const ids = steamPlayerCountComparisonAppIds(appIds), gameKey = ids.join(','), rangeKey = selectionKey(selection)
  const [snapshot, setSnapshot] = useState(() => ({ gameKey, rangeKey, state: initialSteamPlayerCountComparisonState(selection) }))
  const controllerRef = useRef<{ gameKey: string; controller: ReturnType<typeof createSteamPlayerCountComparisonController> } | null>(null)
  const selectionRef = useRef(selection)
  selectionRef.current = selection
  useEffect(() => {
    const controller = createSteamPlayerCountComparisonController(gameKey.split(',').map(Number) as SteamPlayerCountAppId[],
      state => setSnapshot({ gameKey, rangeKey: selectionKey(controller.getSelection()), state }), selectionRef.current)
    controllerRef.current = { gameKey, controller }
    setSnapshot({ gameKey, rangeKey: selectionKey(controller.getSelection()), state: controller.getState() })
    void controller.refresh()
    const stopRefresh = startPublishedDataRefresh(() => { void controller.refresh() })
    return () => {
      controller.dispose(); stopRefresh()
      if (controllerRef.current?.controller === controller) controllerRef.current = null
    }
  }, [gameKey])
  useEffect(() => {
    if (controllerRef.current?.gameKey === gameKey) controllerRef.current.controller.setRange(selectionRef.current)
  }, [gameKey, rangeKey])
  const refresh = useCallback(() => {
    if (controllerRef.current?.gameKey === gameKey) void controllerRef.current.controller.refresh()
  }, [gameKey])
  const state = snapshot.gameKey === gameKey && snapshot.rangeKey === rangeKey ? snapshot.state : initialSteamPlayerCountComparisonState(selection)
  return { ...state, refresh }
}
