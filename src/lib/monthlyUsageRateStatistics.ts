import { calculatePercentageStatistics } from './percentageStatistics.ts'
import { prepareUsageRateHistory, usageRateHistoryRequestKey } from './usageRateHistory.ts'
import type { UsageRateHistoryResult, UsageRateManifest } from '../types/usageRates.ts'
import type {
  MonthlyUsageRateStatistics, MonthlyUsageRateStatisticsMode, MonthlyUsageRateStatisticsRow,
  MonthlyUsageRateStatisticsSelection, MonthlyUsageRateStatisticsValues,
} from '../types/monthlyUsageRateStatistics.ts'

interface PreparedMonth {
  row: MonthlyUsageRateStatisticsRow
  values: Map<string, number>
}

function calculateUsageStatistics(values: readonly number[]): MonthlyUsageRateStatisticsValues {
  const statistics = calculatePercentageStatistics(values, 1000)
  const { meanPercent: mean, standardDeviationPoints: deviation } = statistics
  const coefficient = mean !== null && deviation !== null && mean > 0
    && Number.isFinite(mean) && Number.isFinite(deviation) ? deviation / mean : null
  return {
    ...statistics,
    coefficientOfVariation: coefficient !== null && Number.isFinite(coefficient) ? coefficient : null,
  }
}

/** Validate the entire requested population before loading or aggregating any league. */
export function assertMonthlyUsageRateStatisticsSelection(
  manifest: UsageRateManifest, selection: MonthlyUsageRateStatisticsSelection,
): void {
  if (!['combined', 'classic', 'modern'].includes(selection.controlType)
    || (selection.edition === 'master' && selection.controlType !== 'combined')) {
    throw new Error('操作タイプの指定が正しくありません。')
  }
  // Reuse the usage history's source, manifest, edition, league and calendar validation.
  usageRateHistoryRequestKey(manifest, selection)
}

function prepareMonth(
  prepared: ReturnType<typeof prepareUsageRateHistory>[number],
  selection: MonthlyUsageRateStatisticsSelection,
): PreparedMonth {
  const empty: MonthlyUsageRateStatisticsRow = {
    month: prepared.month, status: prepared.status, listedCount: null, validCount: null,
    excludedMissingCount: null, excludedNonCommonCount: null, characterIds: [], statistics: null,
    publishedTotalPercent: null, capturedAt: null, generatedAt: null, source: null,
  }
  const values = new Map<string, number>()
  if (prepared.status !== 'ready') return { row: empty, values }
  const dataset = prepared.dataset
  const control = selection.controlType === 'combined' ? 'all' : selection.controlType
  const distribution = dataset.distributions.find(item => item.controlType === control)
  if (!distribution) return { row: { ...empty, status: 'unavailable' }, values }
  let excludedMissingCount = 0
  for (const entry of distribution.entries) {
    if (entry.percentThousandths === null) excludedMissingCount += 1
    else values.set(entry.characterId, entry.percentThousandths)
  }
  return {
    row: {
      ...empty, listedCount: distribution.entries.length, excludedMissingCount,
      publishedTotalPercent: values.size === 0 ? null : [...values.values()].reduce((sum, value) => sum + value, 0) / 1000,
      capturedAt: dataset.capturedAt, generatedAt: dataset.generatedAt, source: dataset.source,
      ...(distribution.totalMismatch ? { totalMismatch: distribution.totalMismatch } : {}),
    },
    values,
  }
}

/** Describe published character distributions without inferring counts, zero filling or normalization. */
export function createMonthlyUsageRateStatistics(
  manifest: UsageRateManifest,
  selection: MonthlyUsageRateStatisticsSelection,
  results: readonly UsageRateHistoryResult[],
  mode: MonthlyUsageRateStatisticsMode,
): MonthlyUsageRateStatistics {
  if (mode !== 'monthly' && mode !== 'common') throw new Error('集計対象の指定が正しくありません。')
  assertMonthlyUsageRateStatisticsSelection(manifest, selection)
  const prepared = prepareUsageRateHistory(manifest, selection, results).map(month => prepareMonth(month, selection))
  const commonUnavailable = prepared.some(({ row }) => row.status !== 'ready')
  const commonIds = commonUnavailable ? null
    : [...prepared[0].values.keys()].filter(id => prepared.every(({ values }) => values.has(id)))
  const commonSet = commonIds === null ? null : new Set(commonIds)
  const rows = prepared.map(({ row, values }): MonthlyUsageRateStatisticsRow => {
    if (row.status !== 'ready') return row
    if (mode === 'common' && commonSet === null) return { ...row, status: 'incomplete' }
    const retained = [...values].filter(([id]) => mode === 'monthly' || commonSet!.has(id))
    return {
      ...row, validCount: retained.length, excludedNonCommonCount: values.size - retained.length,
      characterIds: retained.map(([id]) => id),
      statistics: calculateUsageStatistics(retained.map(([, value]) => value)),
    }
  })
  return { mode, commonCharacterCount: commonIds?.length ?? null, commonUnavailable, rows }
}
