import { parseLegendPlayersDataset, parseLegendPlayersDescriptor, parseLegendPlayersManifest } from './legendPlayers.ts'
import type { LegendPlayersDataset, LegendPlayersDescriptor, LegendPlayersManifest } from '../types/legendPlayers.ts'
import { createPublishedDataFeed, type PublishedDataFeedOptions, type PublishedDataPublication } from './publishedDataFeed.ts'

export type LegendPlayersPublication = PublishedDataPublication<LegendPlayersManifest>

export function createLegendPlayersFeed(options: PublishedDataFeedOptions = {}) {
  return createPublishedDataFeed<LegendPlayersDescriptor, LegendPlayersManifest, LegendPlayersDataset>({
    label: 'プレイヤー一覧',
    localPath: 'data/legend-players/',
    historyBaseUrl: 'https://raw.githubusercontent.com/gonchiman/sf6/refs/heads/codex/legend-analysis-history/public/players/',
    parseManifest: parseLegendPlayersManifest,
    parseDescriptor: parseLegendPlayersDescriptor,
    parseDataset: parseLegendPlayersDataset,
  }, options)
}

export const legendPlayersFeed = createLegendPlayersFeed()
