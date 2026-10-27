import { useCallback, useEffect, useRef, useState } from 'react'
import { createPublishedDataController, initialPublishedDataState, type PublishedDataFeed } from './publishedDataController'
import { startPublishedDataRefresh, type PublishedDataPublication } from './publishedDataRefresh'

/** Keep the feed instance stable; dataset display and comparison stay with the consuming page. */
export function usePublishedData<P extends PublishedDataPublication>(feed: PublishedDataFeed<P>) {
  const [state, setState] = useState(initialPublishedDataState<P>)
  const controllerRef = useRef<ReturnType<typeof createPublishedDataController<P>> | null>(null)

  useEffect(() => {
    const controller = createPublishedDataController(feed, setState)
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

  const setSelectedId = useCallback((id: string | null) => controllerRef.current?.setSelectedId(id), [])
  const retry = useCallback(() => { void controllerRef.current?.refresh() }, [])
  return { ...state, setSelectedId, retry }
}
