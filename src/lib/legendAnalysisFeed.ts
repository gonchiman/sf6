import { parseLegendAnalysisDataset, parseLegendAnalysisDescriptor, parseLegendAnalysisManifest } from './legendAnalysis.ts'
import type { LegendAnalysisDataset, LegendAnalysisDescriptor, LegendAnalysisManifest } from '../types/legendAnalysis.ts'
import { createPublishedDataFeed, type PublishedDataFeedOptions, type PublishedDataPublication } from './publishedDataFeed.ts'

export type LegendAnalysisPublication = PublishedDataPublication<LegendAnalysisManifest>

export function createLegendAnalysisFeed(options: PublishedDataFeedOptions = {}) {
  return createPublishedDataFeed<LegendAnalysisDescriptor, LegendAnalysisManifest, LegendAnalysisDataset>({
    label: 'レジェンド分析',
    localPath: 'data/legend-analysis/',
    historyBaseUrl: 'https://raw.githubusercontent.com/gonchiman/sf6/refs/heads/codex/legend-analysis-history/public/',
    parseManifest: parseLegendAnalysisManifest,
    parseDescriptor: parseLegendAnalysisDescriptor,
    parseDataset: parseLegendAnalysisDataset,
  }, options)
}

export const legendAnalysisFeed = createLegendAnalysisFeed()
