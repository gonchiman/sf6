import type { UsageRateBaselinePoint } from '../types/usageRateBaseline.ts'
import type { UsageRateHistorySelection } from '../types/usageRateHistory.ts'
import type { UsageRateHistoryResult, UsageRateManifest, UsageRateSelection } from '../types/usageRates.ts'
import { prepareUsageRateHistory, usageRateHistoryRequestKey } from './usageRateHistory.ts'
import { usageRateSelectedMonths } from './usageRates.ts'

/** The roster source is fixed, independent of the displayed character, rank, controls or edition. */
export function usageRateBaselineSelection(selection: UsageRateSelection): UsageRateHistorySelection {
  const selected: UsageRateHistorySelection = {
    edition: 'general', league: 'ALL', fromMonth: selection.fromMonth, toMonth: selection.toMonth,
  }
  usageRateSelectedMonths(selected)
  return selected
}

/** Reuse the monthly loader/cache's publication and source-aware request identity. */
export function usageRateBaselineRequestKey(manifest: UsageRateManifest, selection: UsageRateSelection): string {
  return usageRateHistoryRequestKey(manifest, usageRateBaselineSelection(selection))
}

/** Keep missing baseline months empty instead of borrowing another month or a filtered roster. */
export function createUsageRateBaselineHistory(
  manifest: UsageRateManifest,
  selection: UsageRateSelection,
  results: readonly UsageRateHistoryResult[],
): UsageRateBaselinePoint[] {
  return prepareUsageRateHistory(manifest, usageRateBaselineSelection(selection), results).map((prepared): UsageRateBaselinePoint => {
    const empty = {
      month: prepared.month, characterCount: null, value: null,
      capturedAt: null, generatedAt: null, source: null,
    }
    if (prepared.status !== 'ready') return { ...empty, status: prepared.status }
    const dataset = prepared.dataset
    const distribution = dataset.distributions.find(item => item.controlType === 'all')
    // The shared validator already rejects empty/duplicate rosters. Every published entry
    // counts here, even when its percentage is zero or missing.
    const characterCount = distribution?.entries.length ?? 0
    if (characterCount === 0) return { ...empty, status: 'error' }
    return {
      month: prepared.month, status: 'value', characterCount, value: 100 / characterCount,
      capturedAt: dataset.capturedAt, generatedAt: dataset.generatedAt, source: dataset.source,
    }
  })
}
