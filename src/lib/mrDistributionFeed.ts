import { parseMrDistributionDataset, parseMrDistributionDescriptor, parseMrDistributionManifest } from './mrDistribution.ts'
import type { MrDistributionDataset, MrDistributionDescriptor, MrDistributionManifest } from '../types/mrDistribution.ts'
import { createPublishedDataFeed, type PublishedDataFeedOptions, type PublishedDataPublication } from './publishedDataFeed.ts'

export type MrDistributionPublication = PublishedDataPublication<MrDistributionManifest>

export function createMrDistributionFeed(options: PublishedDataFeedOptions = {}) {
  return createPublishedDataFeed<MrDistributionDescriptor, MrDistributionManifest, MrDistributionDataset>({
    label: 'MR分布',
    localPath: 'data/mr-distribution/',
    historyBaseUrl: 'https://raw.githubusercontent.com/gonchiman/sf6/refs/heads/codex/mr-distribution-history/public/',
    parseManifest: parseMrDistributionManifest,
    parseDescriptor: parseMrDistributionDescriptor,
    parseDataset: parseMrDistributionDataset,
  }, options)
}

export const mrDistributionFeed = createMrDistributionFeed()
