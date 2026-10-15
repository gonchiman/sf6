import { assertMonthlyUsageRateStatisticsSelection, createMonthlyUsageRateStatistics } from './monthlyUsageRateStatistics.ts'
import { loadUsageRateDataset, loadUsageRateHistory, USAGE_RATE_EDITION_SOURCES } from './usageRates.ts'
import type {
  LeagueUsageStatisticsDatasetResults, LeagueUsageStatisticsSeries, MonthlyUsageRateStatisticsMode,
  MonthlyUsageRateStatisticsSelection,
} from '../types/monthlyUsageRateStatistics.ts'
import type { UsageRateDataset, UsageRateDatasetDescriptor, UsageRateManifest } from '../types/usageRates.ts'

type DatasetLoader = (descriptor: UsageRateDatasetDescriptor) => Promise<UsageRateDataset>

function selectedLeagues(
  manifest: UsageRateManifest, selection: MonthlyUsageRateStatisticsSelection, leagues: readonly string[],
): string[] {
  assertMonthlyUsageRateStatisticsSelection(manifest, selection)
  const unique = [...new Set(leagues)]
  for (const league of unique) assertMonthlyUsageRateStatisticsSelection(manifest, { ...selection, league })
  return unique
}

/** One global queue spans every selected league, including requests queued after a failure. */
function limitDatasetLoader(loader: DatasetLoader): DatasetLoader {
  let active = 0
  const pending: Array<() => void> = []
  return async descriptor => {
    await new Promise<void>(resolve => {
      const start = () => { active += 1; resolve() }
      if (active < 4) start()
      else pending.push(start)
    })
    try {
      return await loader(descriptor)
    } finally {
      active -= 1
      pending.shift()?.()
    }
  }
}

export async function loadMonthlyUsageStatisticsComparison(
  manifest: UsageRateManifest,
  selection: MonthlyUsageRateStatisticsSelection,
  leagues: readonly string[],
  loader?: DatasetLoader,
): Promise<LeagueUsageStatisticsDatasetResults[]> {
  const unique = selectedLeagues(manifest, selection, leagues)
  const expectedSource = selection.edition === 'master' ? USAGE_RATE_EDITION_SOURCES.master : manifest.source
  // Keep the existing loader's publication-version and source-aware cache identity.
  const limited = limitDatasetLoader(loader ?? (descriptor => loadUsageRateDataset(descriptor, manifest.generatedAt, expectedSource)))
  return Promise.all(unique.map(async league => ({
    league, results: await loadUsageRateHistory(manifest, { ...selection, league }, limited),
  })))
}

/** Preserve independent league distributions and common-character sets; never pool percentages. */
export function createMonthlyUsageStatisticsComparison(
  manifest: UsageRateManifest,
  selection: MonthlyUsageRateStatisticsSelection,
  leagueResults: readonly LeagueUsageStatisticsDatasetResults[],
  mode: MonthlyUsageRateStatisticsMode,
): LeagueUsageStatisticsSeries[] {
  if (mode !== 'monthly' && mode !== 'common') throw new Error('集計対象の指定が正しくありません。')
  const resultsByLeague = new Map<string, LeagueUsageStatisticsDatasetResults>()
  for (const result of leagueResults) if (!resultsByLeague.has(result.league)) resultsByLeague.set(result.league, result)
  return selectedLeagues(manifest, selection, [...resultsByLeague.keys()]).map(league => ({
    league,
    statistics: createMonthlyUsageRateStatistics(manifest, { ...selection, league }, resultsByLeague.get(league)!.results, mode),
  }))
}
