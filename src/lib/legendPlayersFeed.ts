import { parseLegendPlayersDataset, parseLegendPlayersDescriptor, parseLegendPlayersManifest, parseLegendRankedMatchSupplement } from './legendPlayers.ts'
import type { LegendPlayersDataset, LegendPlayersDescriptor, LegendPlayersManifest, LegendRankedMatchSupplement } from '../types/legendPlayers.ts'
import { createPublishedDataFeed, type PublishedDataFeedOptions, type PublishedDataPublication } from './publishedDataFeed.ts'

export type LegendPlayersPublication = PublishedDataPublication<LegendPlayersManifest>

export function createLegendPlayersFeed(options: PublishedDataFeedOptions = {}) {
  const feed = createPublishedDataFeed<LegendPlayersDescriptor, LegendPlayersManifest, LegendPlayersDataset>({
    label: 'プレイヤー一覧',
    localPath: 'data/legend-players/',
    historyBaseUrl: 'https://raw.githubusercontent.com/gonchiman/sf6/refs/heads/codex/legend-analysis-history/public/players/',
    parseManifest: parseLegendPlayersManifest,
    parseDescriptor: parseLegendPlayersDescriptor,
    parseDataset: parseLegendPlayersDataset,
  }, options)
  const fetchData = options.fetch ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args))
  const completed = new Map<string, LegendRankedMatchSupplement>()

  async function loadRankedMatchSupplement(publication: LegendPlayersPublication, descriptor: LegendPlayersDescriptor,
    signal: AbortSignal): Promise<LegendRankedMatchSupplement | null> {
    const ranking = await feed.loadDataset(publication, descriptor)
    if (ranking.schemaVersion !== 4 || publication.source !== 'history') return null
    const url = new URL(`../../match-counts/${ranking.id}.json`, publication.baseUrl).href
    const cached = completed.get(url)
    if (cached) return parseLegendRankedMatchSupplement(cached, ranking)
    const response = await fetchData(url, {
      cache: 'no-store', credentials: 'omit', signal: AbortSignal.any([signal, AbortSignal.timeout(options.timeoutMs ?? 10_000)]),
    })
    if (response.status === 404) return null
    if (!response.ok) throw new Error('対戦数データを読み込めませんでした。')
    const supplement = parseLegendRankedMatchSupplement(await response.json(), ranking)
    completed.set(url, supplement)
    return supplement
  }

  return { ...feed, loadRankedMatchSupplement }
}

export const legendPlayersFeed = createLegendPlayersFeed()
