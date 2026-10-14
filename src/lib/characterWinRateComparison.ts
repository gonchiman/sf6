import { createCharacterLeagueWinRates } from './characterLeagueWinRates.ts'
import { editionOf, WIN_RATE_EDITIONS, WIN_RATE_EDITION_LEAGUES, WIN_RATE_EDITION_OPERATION_MODES } from './winRateConditions.ts'
import type { TotalWinRateSort } from './totalWinRates.ts'
import type { CharacterWinRateComparison, CharacterWinRateComparisonRow } from '../types/characterWinRateComparison.ts'
import type { LeagueTotalWinRates, LeagueTotalWinRateSelection } from '../types/leagueTotalWinRates.ts'
import type { WinRateHistoryPoint } from '../types/winRateHistory.ts'

/** Project one league's published points, pairing controls by stable character ID. */
export function createCharacterWinRateComparison(
  comparison: LeagueTotalWinRates,
  selection: LeagueTotalWinRateSelection,
  league: string,
  sort: TotalWinRateSort = 'descending',
): CharacterWinRateComparison {
  const column = comparison.leagues.indexOf(league)
  if (!WIN_RATE_EDITIONS.includes(selection.edition)
    || !WIN_RATE_EDITION_OPERATION_MODES[selection.edition].includes(selection.operationMode)
    || column < 0 || !WIN_RATE_EDITION_LEAGUES[selection.edition].includes(league)) {
    throw new Error('統計・リーグまたは操作タイプの指定が正しくありません。')
  }
  if (!['official', 'ascending', 'descending'].includes(sort)) throw new Error('並び順の指定が正しくありません。')
  const metadata = comparison.metadata.find(item => item.league === league)
  const dataset = metadata?.status === 'ready' ? metadata.result?.dataset : undefined
  if (dataset && (editionOf(dataset) !== selection.edition || dataset.month !== selection.month
    || dataset.league !== league || dataset.operationMode !== selection.operationMode)) {
    throw new Error('選択した条件と勝率データが一致しません。')
  }
  const absentPoint = (): WinRateHistoryPoint => ({
    month: selection.month,
    status: metadata?.status === 'ready' ? 'unlisted' : metadata?.status === 'error' ? 'error' : 'unavailable',
    total: null,
    percentHundredths: null,
    capturedAt: dataset?.capturedAt ?? null,
    source: dataset?.source ?? null,
  })
  const characters = new Map<string, { characterId: string; name: string }>()
  for (const row of comparison.rows) {
    if (!characters.has(row.characterId)) characters.set(row.characterId, { characterId: row.characterId, name: row.name })
  }
  const rows: CharacterWinRateComparisonRow[] = [...characters.values()].map((character, order) => {
    const projected = createCharacterLeagueWinRates(comparison, selection, character.characterId, character.name)
    return {
      characterId: projected.characterId, name: projected.characterName, order,
      series: projected.series.map(series => ({ controlType: series.controlType, point: series.points[column] ?? absentPoint() })),
    }
  })
  // The first series is the official combined value, or classic in separate mode.
  // Modern values never substitute for a missing classic value or contribute to an average.
  const value = (row: CharacterWinRateComparisonRow) => {
    const point = row.series[0].point
    return point.status === 'value' && point.percentHundredths !== null && Number.isFinite(point.percentHundredths)
      ? point.percentHundredths : null
  }
  if (sort !== 'official') {
    const direction = sort === 'ascending' ? 1 : -1
    rows.sort((left, right) => {
      const leftValue = value(left)
      const rightValue = value(right)
      if (leftValue === null) return rightValue === null ? left.order - right.order : 1
      if (rightValue === null) return -1
      return (leftValue - rightValue) * direction || left.order - right.order
    })
  }
  return { league, operationMode: selection.operationMode, rows }
}
