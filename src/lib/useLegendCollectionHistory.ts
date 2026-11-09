import { useEffect, useRef, useState } from 'react'
import {
  LEGEND_COLLECTION_HISTORY_PATH, parseLegendCollectionHistory, type LegendCollectionRun,
} from './legendCollectionHistory'
import { startPublishedDataRefresh } from './publishedDataRefresh'

const historyUrl =
  `https://raw.githubusercontent.com/gonchiman/sf6/refs/heads/codex/legend-analysis-history/${LEGEND_COLLECTION_HISTORY_PATH}`

type HistoryState = { status: 'loading' | 'ready' | 'error'; runs: readonly LegendCollectionRun[] }

export function useLegendCollectionHistory() {
  const [state, setState] = useState<HistoryState>({ status: 'loading', runs: [] })
  const refreshRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    let active = true
    let request: AbortController | null = null

    async function refresh() {
      if (!active || request) return
      const controller = new AbortController()
      request = controller
      try {
        const response = await fetch(historyUrl, {
          credentials: 'omit', cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
        })
        if (response.status === 404) {
          if (active) setState(previous => previous.runs.length ? { ...previous, status: 'error' } : { status: 'ready', runs: [] })
          return
        }
        if (!response.ok) throw new Error('取得履歴の読込失敗')
        const { runs } = parseLegendCollectionHistory(await response.json())
        if (active) setState(previous => {
          const latest = previous.runs[0]
          if (latest && (!runs[0] || runs[0].endedAt < latest.endedAt)) return { ...previous, status: 'error' }
          return { status: 'ready', runs }
        })
      } catch {
        if (active) setState(previous => ({ ...previous, status: 'error' }))
      } finally {
        request = null
      }
    }

    refreshRef.current = refresh
    void refresh()
    const stopRefresh = startPublishedDataRefresh(() => { void refresh() })
    return () => {
      active = false
      request?.abort()
      stopRefresh()
      refreshRef.current = null
    }
  }, [])

  return { ...state, retry: () => refreshRef.current?.() }
}
