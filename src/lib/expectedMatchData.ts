import { EXPECTED_MATCH_RANK_THRESHOLDS } from './expectedMatches.ts'
import { createWinRateHistoryPoints, createWinRateHistorySeries, loadWinRateHistory } from './winRateHistory.ts'
import { editionOf } from './winRateConditions.ts'
import type { HistoryDatasetResult, HistoryControlType } from '../types/winRateHistory.ts'
import type { WinRateDataset, WinRateDatasetDescriptor, WinRateFighter, WinRateManifest } from '../types/winRates.ts'
import type { ExpectedMatchData, ExpectedMatchSelection } from '../types/expectedMatchData.ts'

export function expectedMatchMonths(manifest: WinRateManifest): string[] {
  return [...new Set(manifest.datasets.filter(item => editionOf(item) === 'general'
    && EXPECTED_MATCH_RANK_THRESHOLDS.some(rank => rank.id === item.league)).map(item => item.month))].sort().reverse()
}

export function expectedMatchControls(manifest: WinRateManifest, month: string): HistoryControlType[] {
  const modes = new Set(manifest.datasets.filter(item => editionOf(item) === 'general' && item.month === month
    && EXPECTED_MATCH_RANK_THRESHOLDS.some(rank => rank.id === item.league)).map(item => item.operationMode))
  return (['combined', 'classic', 'modern'] as const).filter(control => modes.has(control === 'combined' ? 'combined' : 'separate'))
}

function historySelection(selection: ExpectedMatchSelection, league: string) {
  return { edition: 'general' as const, league, controlType: selection.controlType, fromMonth: selection.month, toMonth: selection.month }
}

/** Reuse the history projection's identity, condition, precision, and missing-data checks. */
export function createExpectedMatchData(
  manifest: WinRateManifest,
  selection: ExpectedMatchSelection,
  roster: readonly WinRateFighter[],
  results: readonly HistoryDatasetResult[],
): ExpectedMatchData {
  const control = selection.controlType === 'combined' ? null : selection.controlType
  // Validate each rank even when the roster is empty, so read failures stay visible.
  const rankSources = EXPECTED_MATCH_RANK_THRESHOLDS.map(rank => {
    const items = results.filter(result => result.descriptor.league === rank.id)
    const point = createWinRateHistoryPoints(manifest, historySelection(selection, rank.id), '', items)[0]
    const ready = point.source ? items.find(item => item.status === 'ready') : undefined
    return { point, dataset: ready?.status === 'ready' ? ready.dataset : null }
  })
  const fighters = new Map<string, WinRateFighter>()
  // Roster membership does not depend on the source file's operation mode.
  for (const fighter of roster) {
    if (!fighters.has(fighter.characterId) || fighter.controlType === control) {
      fighters.set(fighter.characterId, { ...fighter, id: `${fighter.characterId}:${selection.controlType}`, controlType: control })
    }
  }
  for (const { dataset } of rankSources) {
    if (!dataset) continue
    for (const fighter of dataset.fighters) {
      if (fighter.controlType === control && !fighters.has(fighter.characterId)) fighters.set(fighter.characterId, fighter)
    }
  }
  const characters = [...fighters.values()]
  // A single month is projected separately through each rank, never averaged across ranks.
  const projections = EXPECTED_MATCH_RANK_THRESHOLDS.map(rank => {
    const items = results.filter(result => result.descriptor.league === rank.id)
    return createWinRateHistorySeries(manifest, historySelection(selection, rank.id), characters, items)
  })
  const datasets = rankSources.flatMap(item => item.dataset ? [item.dataset] : [])
  const failedCount = rankSources.filter(item => item.point.status === 'error').length
  return {
    characters: characters.map((fighter, index) => {
      const ranks = EXPECTED_MATCH_RANK_THRESHOLDS.map((rank, rankIndex) => {
        const point = projections[rankIndex][index].points[0]
        return {
          league: rank.id, minimumLp: rank.minimumLp, status: point.status,
          text: point.total?.text ?? null, probability: point.percentHundredths === null ? null : point.percentHundredths / 10_000,
          lowSample: point.total?.lowSample ?? false,
        }
      })
      return { fighter, ranks, available: ranks.every(rank => rank.status === 'value' && rank.probability !== null) }
    }),
    datasets,
    failedCount,
  }
}

export async function loadExpectedMatchData(
  manifest: WinRateManifest,
  selection: ExpectedMatchSelection,
  roster: readonly WinRateFighter[],
  loader?: (descriptor: WinRateDatasetDescriptor) => Promise<WinRateDataset>,
): Promise<ExpectedMatchData> {
  const results = await Promise.all(EXPECTED_MATCH_RANK_THRESHOLDS.map(rank =>
    loadWinRateHistory(manifest, historySelection(selection, rank.id), loader)))
  const data = createExpectedMatchData(manifest, selection, roster, results.flat())
  if (!data.characters.length) throw new Error('No character roster could be loaded')
  return data
}
