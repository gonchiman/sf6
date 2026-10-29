import { parseRankDistributionDataset, parseRankDistributionDescriptor, parseRankDistributionManifest } from './rankDistribution.ts'
import type { RankDistributionDataset, RankDistributionDescriptor, RankDistributionManifest } from '../types/rankDistribution.ts'
import { createPublishedDataFeed, type PublishedDataFeedOptions, type PublishedDataPublication } from './publishedDataFeed.ts'

export type RankDistributionPublication = PublishedDataPublication<RankDistributionManifest>

export function createRankDistributionFeed(options: PublishedDataFeedOptions = {}) {
  return createPublishedDataFeed<RankDistributionDescriptor, RankDistributionManifest, RankDistributionDataset>({
    label: 'ランク分布',
    localPath: 'data/rank-distribution/',
    historyBaseUrl: 'https://raw.githubusercontent.com/gonchiman/sf6/refs/heads/codex/rank-distribution-history/data/',
    parseManifest: parseRankDistributionManifest,
    parseDescriptor: parseRankDistributionDescriptor,
    parseDataset: parseRankDistributionDataset,
  }, options)
}

export const rankDistributionFeed = createRankDistributionFeed()
