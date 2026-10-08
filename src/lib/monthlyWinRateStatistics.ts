import { createWinRateHistorySeries, historySelectedDescriptors, historySelectedMonths } from './winRateHistory.ts'
import type { HistoryDatasetResult, WinRateHistorySelection, WinRateHistorySeries } from '../types/winRateHistory.ts'
import type { WinRateManifest } from '../types/winRates.ts'
import type {
  MonthlyWinRateStatistics,
  MonthlyWinRateStatisticsMode,
  MonthlyWinRateStatisticsRow,
  MonthlyWinRateStatisticsValues,
} from '../types/monthlyWinRateStatistics.ts'

interface PreparedMonth {
  row: MonthlyWinRateStatisticsRow
  values: Map<string, number>
}

/** Calculate unweighted descriptive statistics in integer hundredths before converting to percent. */
function calculateStatistics(values: readonly number[]): MonthlyWinRateStatisticsValues {
  if (values.length === 0) {
    return {
      meanPercent: null, medianPercent: null, standardDeviationPoints: null,
      minimumPercent: null, maximumPercent: null,
    }
  }
  const sorted = [...values].sort((left, right) => left - right)
  const count = sorted.length
  const mean = sorted.reduce((sum, value) => sum + value, 0) / count
  const middle = Math.floor(count / 2)
  const median = count % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
  // The denominator is N: these are the retained published character values, not an iid sample.
  const variance = sorted.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / count
  return {
    meanPercent: mean / 100,
    medianPercent: median / 100,
    standardDeviationPoints: count < 2 ? null : Math.sqrt(variance) / 100,
    minimumPercent: sorted[0] / 100,
    maximumPercent: sorted[count - 1] / 100,
  }
}

function prepareMonth(series: readonly WinRateHistorySeries[], index: number): PreparedMonth {
  const first = series[0].points[index]
  const empty: MonthlyWinRateStatisticsRow = {
    month: first.month, status: 'ready', listedCount: null, validCount: null,
    excludedMissingCount: null, excludedLowSampleCount: null, excludedNonCommonCount: null,
    characterIds: [], statistics: null, capturedAt: first.capturedAt, source: first.source,
  }
  const values = new Map<string, number>()
  if (first.status === 'unavailable' || first.status === 'error') {
    return { row: { ...empty, status: first.status }, values }
  }
  let listedCount = 0
  let excludedMissingCount = 0
  let excludedLowSampleCount = 0
  for (const item of series) {
    const point = item.points[index]
    if (point.status === 'unlisted') continue
    listedCount += 1
    if (point.percentHundredths === null) {
      excludedMissingCount += 1
    } else if (point.total?.lowSample) {
      excludedLowSampleCount += 1
    } else {
      values.set(item.characterId, point.percentHundredths)
    }
  }
  return {
    row: { ...empty, listedCount, excludedMissingCount, excludedLowSampleCount }, values,
  }
}

/**
 * Project all stable character IDs through the existing history validation and calendar.
 * Total values retain the selected edition, league and control; matchup cells are never averaged.
 */
export function createMonthlyWinRateStatistics(
  manifest: WinRateManifest,
  selection: WinRateHistorySelection,
  results: readonly HistoryDatasetResult[],
  mode: MonthlyWinRateStatisticsMode,
): MonthlyWinRateStatistics {
  if (mode !== 'monthly' && mode !== 'common') throw new Error('集計対象の指定が正しくありません。')
  const characters = new Map<string, { characterId: string; name: string }>()
  for (const result of results) {
    if (result.status !== 'ready' || !Array.isArray(result.dataset?.fighters)) continue
    for (const fighter of result.dataset.fighters) {
      if (!fighter || typeof fighter.characterId !== 'string' || typeof fighter.name !== 'string') continue
      if (!characters.has(fighter.characterId)) characters.set(fighter.characterId, {
        characterId: fighter.characterId, name: fighter.name,
      })
    }
  }
  let prepared: PreparedMonth[]
  if (characters.size > 0) {
    const series = createWinRateHistorySeries(manifest, selection, [...characters.values()], results)
    prepared = series[0].points.map((_, index) => prepareMonth(series, index))
  } else {
    // No published fighter can exist in a valid ready dataset without contributing a stable ID.
    // Keep registered failures and calendar gaps using the same selection helpers as history.
    const descriptors = historySelectedDescriptors(manifest, selection)
    prepared = historySelectedMonths(selection).map((month): PreparedMonth => ({
      row: {
        month, status: descriptors.has(month) ? 'error' : 'unavailable',
        listedCount: null, validCount: null, excludedMissingCount: null,
        excludedLowSampleCount: null, excludedNonCommonCount: null,
        characterIds: [], statistics: null, capturedAt: null, source: null,
      },
      values: new Map(),
    }))
  }
  const commonUnavailable = prepared.some(({ row }) => row.status !== 'ready')
  const commonIds = commonUnavailable ? null
    : [...prepared[0].values.keys()].filter((id) => prepared.every(({ values }) => values.has(id)))
  const commonSet = commonIds === null ? null : new Set(commonIds)
  const rows = prepared.map(({ row, values }): MonthlyWinRateStatisticsRow => {
    if (row.status !== 'ready') return row
    if (mode === 'common' && commonSet === null) return { ...row, status: 'incomplete' }
    const entries = [...values].filter(([id]) => mode === 'monthly' || commonSet!.has(id))
    return {
      ...row,
      validCount: entries.length,
      excludedNonCommonCount: values.size - entries.length,
      characterIds: entries.map(([id]) => id),
      statistics: calculateStatistics(entries.map(([, value]) => value)),
    }
  })
  return { mode, commonCharacterCount: commonIds?.length ?? null, commonUnavailable, rows }
}

/** Display only: round half up to two decimals without rounding any calculation inputs. */
export function formatMonthlyStatistic(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '算出できません'
  const scaled = Math.abs(value) * 100
  const tolerance = Number.EPSILON * Math.max(1, scaled) * 4
  const rounded = Math.round(scaled + tolerance)
  return `${value < 0 && rounded !== 0 ? '-' : ''}${(rounded / 100).toFixed(2)}`
}
