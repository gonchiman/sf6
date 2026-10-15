import type { UsageRateComparisonResult, UsageRateComparisonRow, UsageRateComparisonSeries } from '../types/usageRateComparison.ts'
import type { UsageRateHistorySelection } from '../types/usageRateHistory.ts'
import type { UsageRateDataset, UsageRateDatasetDescriptor, UsageRateEdition, UsageRateManifest } from '../types/usageRates.ts'
import { controlTypeBarStyle } from './controlTypeBarStyles.ts'
import { createCharacterUsageRateHistory, usageRateHistoryRequestKey } from './usageRateHistory.ts'
import {
  loadUsageRateHistory, parseUsageRateManifest, usageRateSelectedMonths,
  USAGE_RATE_EDITIONS, USAGE_RATE_EDITION_LEAGUES, USAGE_RATE_EDITION_SOURCES,
} from './usageRates.ts'
import { leagueLabel } from './winRateConditions.ts'

export const MAX_USAGE_RATE_COMPARISON_SERIES = 6

type SeriesCondition = Pick<UsageRateComparisonRow, 'characterId' | 'league' | 'controlType'>
type SeriesLabel = Pick<UsageRateComparisonRow, 'characterName' | 'league' | 'controlType'>

/** A series keeps its identity when row position, user-facing name or color changes. */
export function usageRateComparisonSeriesId(edition: UsageRateEdition, row: SeriesCondition): string {
  return `${edition}:${row.characterId}:${row.league}:${row.controlType}`
}

export function usageRateComparisonLabel(row: SeriesLabel): string {
  return `${row.characterName} · ${row.league === 'ALL' ? 'ALL（全体）' : leagueLabel(row.league)} · ${controlTypeBarStyle(row.controlType).label}`
}

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value === value.trim()
}

function validatedInputs(value: UsageRateManifest, selection: UsageRateHistorySelection, rows: readonly UsageRateComparisonRow[]) {
  const manifest = parseUsageRateManifest(value)
  if (!USAGE_RATE_EDITIONS.includes(selection.edition)) throw new Error('統計区分の指定が正しくありません。')
  // The period is shared; each row supplies its own league instead of selection.league.
  usageRateSelectedMonths({ ...selection, league: USAGE_RATE_EDITION_LEAGUES[selection.edition][0] })
  if (rows.length > MAX_USAGE_RATE_COMPARISON_SERIES) throw new Error(`比較できる条件は${MAX_USAGE_RATE_COMPARISON_SERIES}件までです。`)
  const ids = new Set<string>()
  const conditions = new Set<string>()
  const slots = new Set<number>()
  for (const row of rows) {
    if (!row || !nonempty(row.id) || !nonempty(row.characterName) || !nonempty(row.characterId)
      || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(row.characterId)
      || !USAGE_RATE_EDITION_LEAGUES[selection.edition].includes(row.league)
      || !['combined', 'classic', 'modern'].includes(row.controlType)
      || (selection.edition === 'master' && row.controlType !== 'combined')
      || !Number.isInteger(row.colorSlot) || row.colorSlot < 0 || row.colorSlot >= MAX_USAGE_RATE_COMPARISON_SERIES) {
      throw new Error('比較条件の指定が正しくありません。')
    }
    const condition = usageRateComparisonSeriesId(selection.edition, row)
    if (ids.has(row.id) || conditions.has(condition) || slots.has(row.colorSlot)) throw new Error('比較条件・行IDまたは表示色が重複しています。')
    ids.add(row.id)
    conditions.add(condition)
    slots.add(row.colorSlot)
  }
  const leagues = [...new Set(rows.map(row => row.league))].sort()
  return { manifest, leagues }
}

/** One file supplies every character/control in a league; display edits do not restart fetching. */
export function usageRateComparisonRequestKey(
  value: UsageRateManifest,
  selection: UsageRateHistorySelection,
  rows: readonly UsageRateComparisonRow[],
): string {
  const { manifest, leagues } = validatedInputs(value, selection, rows)
  const source = selection.edition === 'master' ? USAGE_RATE_EDITION_SOURCES.master : manifest.source
  return JSON.stringify([manifest.generatedAt, selection.edition, source.url, selection.fromMonth, selection.toMonth,
    leagues.map(league => usageRateHistoryRequestKey(manifest, { ...selection, league })),
  ])
}

/** Serialize league batches so the existing monthly loader's four-request limit stays global. */
export async function loadUsageRateComparison(
  value: UsageRateManifest,
  selection: UsageRateHistorySelection,
  rows: readonly UsageRateComparisonRow[],
  loader?: (descriptor: UsageRateDatasetDescriptor) => Promise<UsageRateDataset>,
): Promise<UsageRateComparisonResult[]> {
  const { manifest, leagues } = validatedInputs(value, selection, rows)
  const output: UsageRateComparisonResult[] = []
  for (const league of leagues) {
    output.push({ league, results: await loadUsageRateHistory(manifest, { ...selection, league }, loader) })
  }
  return output
}

/** Reuse the validated monthly projection; each condition contributes exactly one published series. */
export function createUsageRateComparison(
  value: UsageRateManifest,
  selection: UsageRateHistorySelection,
  rows: readonly UsageRateComparisonRow[],
  results: readonly UsageRateComparisonResult[],
): UsageRateComparisonSeries[] {
  const { manifest } = validatedInputs(value, selection, rows)
  return rows.map(row => {
    const matching = results.filter(item => item.league === row.league)
    const result = matching.length === 1 && Array.isArray(matching[0].results) ? matching[0].results : []
    const history = createCharacterUsageRateHistory(manifest, { ...selection, league: row.league },
      { characterId: row.characterId, name: row.characterName }, row.controlType === 'combined' ? 'combined' : 'separate', result)
    const points = history.series.find(series => series.controlType === row.controlType)!.points
    return { ...row, seriesId: usageRateComparisonSeriesId(selection.edition, row), label: usageRateComparisonLabel(row), points }
  })
}
