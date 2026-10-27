import { parseLegendAnalysisDataset, parseLegendAnalysisDescriptor, parseLegendAnalysisManifest } from './legendAnalysis.ts'
import type { LegendAnalysisDataset, LegendAnalysisDescriptor, LegendAnalysisManifest } from '../types/legendAnalysis.ts'

export type LegendAnalysisPublication = {
  manifest: LegendAnalysisManifest
  source: 'history' | 'bundled'
  baseUrl: string
}

const HISTORY_BASE_URL = 'https://raw.githubusercontent.com/gonchiman/sf6/refs/heads/codex/legend-analysis-history/public/'
const trailingSlash = (value: string): string => value.endsWith('/') ? value : `${value}/`

/** Keep a publication and every capture read from it on the same validated source. */
export function createLegendAnalysisFeed(options: {
  fetch?: typeof fetch
  localBaseUrl?: string
  historyBaseUrl?: string
  timeoutMs?: number
} = {}) {
  const fetchData = options.fetch ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args))
  const bases = {
    history: trailingSlash(options.historyBaseUrl ?? HISTORY_BASE_URL),
    bundled: trailingSlash(options.localBaseUrl ?? `${trailingSlash(import.meta.env?.BASE_URL ?? '/')}data/legend-analysis/`),
  }
  const timeoutMs = options.timeoutMs ?? 10_000
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) throw new Error('読込の制限時間が不正です。')
  let publicationRequest: Promise<LegendAnalysisPublication> | null = null
  const datasetRequests = new Map<string, Promise<LegendAnalysisDataset>>()

  async function readJson(url: string, refresh = false): Promise<unknown> {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort()
        reject(new Error('レジェンド分析データの読込が時間内に完了しませんでした。'))
      }, timeoutMs)
    })
    try {
      const request = (async () => {
        const response = await fetchData(url, { cache: refresh ? 'no-store' : 'default', credentials: 'omit', signal: controller.signal })
        if (!response.ok) throw new Error('レジェンド分析データを読み込めませんでした。もう一度お試しください。')
        return response.json() as Promise<unknown>
      })()
      // Bound the body read too, including transports that do not honor abort.
      return await Promise.race([request, deadline])
    } finally {
      clearTimeout(timer)
    }
  }

  async function loadDataset(publication: LegendAnalysisPublication, descriptor: LegendAnalysisDescriptor): Promise<LegendAnalysisDataset> {
    if (!['history', 'bundled'].includes(publication.source) || publication.baseUrl !== bases[publication.source]) {
      throw new Error('レジェンド分析データの取得元が一致しません。')
    }
    const manifest = parseLegendAnalysisManifest(publication.manifest)
    const expected = parseLegendAnalysisDescriptor(descriptor)
    const listed = manifest.datasets.find(item => item.id === expected.id)
    if (!listed || JSON.stringify(listed) !== JSON.stringify(expected)) throw new Error('レジェンド分析の取得記録が一覧と一致しません。')
    const key = JSON.stringify([publication.source, publication.baseUrl, manifest.generatedAt, expected])
    const cached = datasetRequests.get(key)
    if (cached) return cached
    const url = `${publication.baseUrl}${expected.path}?v=${encodeURIComponent(expected.captureEndedAt)}&published=${encodeURIComponent(manifest.generatedAt)}`
    const request = readJson(url).then(value => {
      const dataset = parseLegendAnalysisDataset(value, expected)
      if (dataset.source.url !== manifest.source.url || dataset.generatedAt > manifest.generatedAt) {
        throw new Error('レジェンド分析データの出典または日時が一覧と一致しません。')
      }
      return dataset
    }).catch(error => {
      if (datasetRequests.get(key) === request) datasetRequests.delete(key)
      throw error
    })
    datasetRequests.set(key, request)
    return request
  }

  async function readPublication(source: LegendAnalysisPublication['source']): Promise<LegendAnalysisPublication> {
    const baseUrl = bases[source]
    const manifest = parseLegendAnalysisManifest(await readJson(`${baseUrl}index.json`, true))
    const publication = { manifest, source, baseUrl }
    const latest = [...manifest.datasets].sort((a, b) => b.captureEndedAt.localeCompare(a.captureEndedAt) || a.id.localeCompare(b.id))[0]
    // A new index alone is insufficient: verify the capture that the page will initially show.
    if (latest) await loadDataset(publication, latest)
    return publication
  }

  function loadPublication(): Promise<LegendAnalysisPublication> {
    if (publicationRequest) return publicationRequest
    const request = readPublication('history').catch(() => readPublication('bundled')).finally(() => {
      if (publicationRequest === request) publicationRequest = null
    })
    publicationRequest = request
    return request
  }

  return { loadPublication, loadDataset }
}

export const legendAnalysisFeed = createLegendAnalysisFeed()
