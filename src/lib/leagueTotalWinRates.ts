import { createWinRateHistoryPoints, createWinRateHistorySeries } from './winRateHistory.ts'
import { WIN_RATE_EDITIONS, WIN_RATE_EDITION_LEAGUES, WIN_RATE_EDITION_OPERATION_MODES } from './winRateConditions.ts'
import type { LeagueStatisticsDatasetResults } from '../types/monthlyWinRateStatisticsComparison.ts'
import type { HistoryControlType, HistoryDatasetResult, WinRateHistorySelection } from '../types/winRateHistory.ts'
import type { WinRateManifest } from '../types/winRates.ts'
import type {
  LeagueTotalWinRateMetadata, LeagueTotalWinRateRow, LeagueTotalWinRates,
  LeagueTotalWinRateSelection, LeagueTotalWinRateSort,
} from '../types/leagueTotalWinRates.ts'

function historySelection(selection: LeagueTotalWinRateSelection, league: string, controlType: HistoryControlType): WinRateHistorySelection {
  return { edition: selection.edition, league, controlType, fromMonth: selection.month, toMonth: selection.month }
}

/** Keep each league's published Total and population; never average across leagues or matchup cells. */
export function createLeagueTotalWinRates(
  manifest: WinRateManifest,
  selection: LeagueTotalWinRateSelection,
  results: readonly LeagueStatisticsDatasetResults[],
): LeagueTotalWinRates {
  if (!WIN_RATE_EDITIONS.includes(selection.edition)
    || !WIN_RATE_EDITION_OPERATION_MODES[selection.edition].includes(selection.operationMode)) {
    throw new Error('統計または操作タイプの指定が正しくありません。')
  }
  const leagues = [...WIN_RATE_EDITION_LEAGUES[selection.edition]]
  const controls: HistoryControlType[] = selection.operationMode === 'combined' ? ['combined'] : ['classic', 'modern']
  const resultsByLeague = new Map<string, HistoryDatasetResult[]>()
  for (const item of results) {
    const entries = resultsByLeague.get(item.league) ?? []
    entries.push(...item.results)
    resultsByLeague.set(item.league, entries)
  }
  const metadata: LeagueTotalWinRateMetadata[] = leagues.map(league => {
    const entries = resultsByLeague.get(league) ?? []
    // A character-independent projection checks the descriptor and the entire dataset
    // before any fighter can enter the cross-league roster, including with an empty roster.
    const point = createWinRateHistoryPoints(manifest, historySelection(selection, league, controls[0]), '', entries)[0]
    if (point.status === 'unavailable') return { league, status: 'unavailable' }
    if (point.status === 'error') return { league, status: 'error' }
    const result = entries.find(item => item.month === selection.month && item.status === 'ready')
    return result?.status === 'ready' ? { league, status: 'ready', result } : { league, status: 'error' }
  })
  const characters = new Map<string, { characterId: string; name: string }>()
  for (const item of metadata) {
    if (!item.result) continue
    for (const fighter of item.result.dataset.fighters) {
      if (!characters.has(fighter.characterId)) characters.set(fighter.characterId, {
        characterId: fighter.characterId, name: fighter.name,
      })
    }
  }
  const roster = [...characters.values()]
  // Both control projections reuse the same validated separate-operation source file.
  const projections = controls.map(control => leagues.map(league => createWinRateHistorySeries(
    manifest, historySelection(selection, league, control), roster, resultsByLeague.get(league) ?? [],
  )))
  return {
    leagues, metadata,
    rows: roster.flatMap((character, characterIndex) => controls.map((control, controlIndex) => ({
      key: `${character.characterId}:${control}`,
      ...character,
      controlType: control === 'combined' ? null : control,
      values: leagues.map((_, leagueIndex) => projections[controlIndex][leagueIndex][characterIndex].points[0]),
    }))),
  }
}

/** Values sort before all missing states in either direction; ties retain official order. */
export function sortLeagueTotalWinRateRows(
  rows: readonly LeagueTotalWinRateRow[],
  leagues: readonly string[],
  sort: LeagueTotalWinRateSort,
): LeagueTotalWinRateRow[] {
  const column = sort.league === null ? -1 : leagues.indexOf(sort.league)
  if (column < 0) return [...rows]
  const direction = sort.direction === 'ascending' ? 1 : -1
  return rows.map((row, index) => {
    const point = row.values[column]
    return { row, index, value: point?.status === 'value' ? point.percentHundredths : null }
  }).sort((left, right) => {
    if (left.value === null) return right.value === null ? left.index - right.index : 1
    if (right.value === null) return -1
    return (left.value - right.value) * direction || left.index - right.index
  }).map(item => item.row)
}
