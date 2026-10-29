import { useCallback, useEffect, useMemo, useState } from 'react'
import type { SampleSurveyRun } from '../types/sampleSurvey'
import { sampleSurveyResultsFeed } from './sampleSurveyResults'
import { usePublishedData } from './usePublishedData'

const READ_ERROR = '標本調査の結果を読み込めません。'

/** Static published aggregates only. Collection commands and the local service are never contacted. */
export function useSampleSurveyResults() {
  const { status, publication, selectedId, setSelectedId, refreshError, retry } = usePublishedData(sampleSurveyResultsFeed)
  const descriptors = useMemo(() => [...(publication?.manifest.datasets ?? [])]
    .sort((a, b) => b.captureEndedAt.localeCompare(a.captureEndedAt) || a.id.localeCompare(b.id)), [publication])
  const descriptor = descriptors.find(item => item.id === selectedId) ?? null
  const requestKey = publication && descriptor
    ? JSON.stringify([publication.source, publication.baseUrl, publication.manifest.generatedAt, descriptor]) : null
  const [loaded, setLoaded] = useState<{ key: string | null; run: SampleSurveyRun | null; error: string | null }>({ key: null, run: null, error: null })
  const [retryRevision, setRetryRevision] = useState(0)
  const refresh = useCallback(() => {
    // A successful publication refresh can keep the same object; retry a failed selection independently.
    setLoaded(previous => previous.error ? { key: null, run: null, error: null } : previous)
    setRetryRevision(previous => previous + 1)
    retry()
  }, [retry])

  useEffect(() => {
    let active = true
    if (publication && descriptor && requestKey) {
      void sampleSurveyResultsFeed.loadDataset(publication, descriptor).then(run => {
        if (active) setLoaded({ key: requestKey, run, error: null })
      }).catch(() => {
        if (active) setLoaded({ key: requestKey, run: null, error: READ_ERROR })
      })
    }
    return () => { active = false }
  }, [publication, descriptor, requestKey, retryRevision])

  const current = requestKey !== null && loaded.key === requestKey ? loaded : null
  return {
    descriptors, selectedId, setSelectedId, run: current?.run ?? null,
    loading: status === 'loading' || !!requestKey && !current,
    error: status === 'error' ? READ_ERROR : current?.error ?? null,
    refresh,
    updatedAt: descriptors.length ? publication!.manifest.generatedAt : null,
    refreshError: refreshError ? '結果を更新できませんでした。前回の結果を表示しています。'
      : publication?.source === 'bundled' && descriptors.length ? '最新データを確認できません。同梱データを表示しています。' : null,
  }
}
