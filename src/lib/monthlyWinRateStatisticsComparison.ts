import { createMonthlyWinRateStatistics } from './monthlyWinRateStatistics.ts'
import { historySelectedDescriptors, historySelectedMonths, loadWinRateHistory } from './winRateHistory.ts'
import { loadWinRateDataset } from './winRates.ts'
import type { MonthlyWinRateStatisticsMode } from '../types/monthlyWinRateStatistics.ts'
import type { LeagueStatisticsDatasetResults, LeagueStatisticsSeries } from '../types/monthlyWinRateStatisticsComparison.ts'
import type { WinRateHistorySelection } from '../types/winRateHistory.ts'
import type { WinRateDataset, WinRateDatasetDescriptor, WinRateManifest } from '../types/winRates.ts'

type DatasetLoader = (descriptor: WinRateDatasetDescriptor) => Promise<WinRateDataset>

function selectedLeagues(
  manifest: WinRateManifest, selection: WinRateHistorySelection, leagues: readonly string[],
): string[] {
  historySelectedMonths(selection)
  const unique = [...new Set(leagues)]
  // Validate every requested population before starting any of its requests.
  for (const league of unique) historySelectedDescriptors(manifest, { ...selection, league })
  return unique
}

/** Share four loader slots across all leagues while retaining the history loader's validation. */
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

export async function loadMonthlyStatisticsComparison(
  manifest: WinRateManifest,
  selection: WinRateHistorySelection,
  leagues: readonly string[],
  loader: DatasetLoader = loadWinRateDataset,
): Promise<LeagueStatisticsDatasetResults[]> {
  const unique = selectedLeagues(manifest, selection, leagues)
  const limitedLoader = limitDatasetLoader(loader)
  return Promise.all(unique.map(async league => ({
    league, results: await loadWinRateHistory(manifest, { ...selection, league }, limitedLoader),
  })))
}

/** Calculate each league independently; never pool percentages or intersect different leagues. */
export function createMonthlyStatisticsComparison(
  manifest: WinRateManifest,
  selection: WinRateHistorySelection,
  leagueResults: readonly LeagueStatisticsDatasetResults[],
  mode: MonthlyWinRateStatisticsMode,
): LeagueStatisticsSeries[] {
  if (mode !== 'monthly' && mode !== 'common') throw new Error('集計対象の指定が正しくありません。')
  const resultsByLeague = new Map<string, LeagueStatisticsDatasetResults>()
  for (const result of leagueResults) if (!resultsByLeague.has(result.league)) resultsByLeague.set(result.league, result)
  const leagues = selectedLeagues(manifest, selection, [...resultsByLeague.keys()])
  return leagues.map(league => ({
    league,
    statistics: createMonthlyWinRateStatistics(manifest, { ...selection, league }, resultsByLeague.get(league)!.results, mode),
  }))
}
