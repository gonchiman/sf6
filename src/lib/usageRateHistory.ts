import type { MonthlyLineChartAxis } from '../types/monthlyLineChart.ts'
import type {
  CharacterUsageRateHistory, UsageRateHistoryControlType, UsageRateHistoryOperationMode,
  UsageRateHistoryPoint, UsageRateHistorySelection,
} from '../types/usageRateHistory.ts'
import type {
  UsageRateDataset, UsageRateDatasetDescriptor, UsageRateEdition, UsageRateHistoryResult, UsageRateManifest, UsageRateSelection,
} from '../types/usageRates.ts'
import { formatLeagueUsageRatePoint } from './leagueUsageRates.ts'
import {
  parseUsageRateDataset, parseUsageRateDescriptor, parseUsageRateManifest, usageRateCalendarMonths,
  usageRateEditionOf, usageRateSelectedMonths, USAGE_RATE_EDITIONS, USAGE_RATE_EDITION_LEAGUES,
  USAGE_RATE_EDITION_OPERATION_MODES, USAGE_RATE_EDITION_SOURCES,
} from './usageRates.ts'

function validMonth(value: string | undefined): value is string {
  return typeof value === 'string' && /^\d{4}-(?:0[1-9]|1[0-2])$/.test(value)
}

/** Keep a valid requested calendar range within its edition; gaps remain selectable observations. */
export function selectUsageRateHistoryConditions(
  value: UsageRateManifest,
  edition: UsageRateEdition,
  preferred: Partial<UsageRateSelection> = {},
): UsageRateHistorySelection | null {
  const manifest = parseUsageRateManifest(value)
  if (!USAGE_RATE_EDITIONS.includes(edition)) throw new Error('統計区分の指定が正しくありません。')
  const months = usageRateCalendarMonths(manifest, edition)
  if (!months.length) return null
  const first = months[0]
  const last = months.at(-1)!
  const defaultFrom = months[Math.max(0, months.length - 12)]
  let fromMonth = validMonth(preferred.fromMonth) ? preferred.fromMonth : defaultFrom
  let toMonth = validMonth(preferred.toMonth) ? preferred.toMonth : last
  if (fromMonth > toMonth || toMonth < first || fromMonth > last) {
    fromMonth = defaultFrom
    toMonth = last
  } else {
    fromMonth = fromMonth < first ? first : fromMonth
    toMonth = toMonth > last ? last : toMonth
  }
  const league = preferred.league && USAGE_RATE_EDITION_LEAGUES[edition].includes(preferred.league)
    ? preferred.league : 'MASTER'
  return { edition, league, fromMonth, toMonth }
}

function selectedDescriptors(manifest: UsageRateManifest, selection: UsageRateSelection): Map<string, UsageRateDatasetDescriptor> {
  const selected = new Set(usageRateSelectedMonths(selection))
  const edition = usageRateEditionOf(selection)
  return new Map(manifest.datasets.filter(item => usageRateEditionOf(item) === edition
    && item.league === selection.league && selected.has(item.month)).map(item => [item.month, item]))
}

/** Changing characters or display modes reuses the same validated monthly files. */
export function usageRateHistoryRequestKey(value: UsageRateManifest, selection: UsageRateSelection): string {
  const manifest = parseUsageRateManifest(value)
  const edition = usageRateEditionOf(selection)
  const source = edition === 'master' ? USAGE_RATE_EDITION_SOURCES.master : manifest.source
  const descriptors = [...selectedDescriptors(manifest, selection).values()].sort((a, b) => a.month.localeCompare(b.month))
  return JSON.stringify([manifest.generatedAt, edition, source.url, selection.league, selection.fromMonth, selection.toMonth,
    descriptors.map(item => [item.id, item.month, item.path, item.capturedAt]),
  ])
}

function sameDescriptor(left: UsageRateDatasetDescriptor, right: UsageRateDatasetDescriptor): boolean {
  const parsed = parseUsageRateDescriptor(left)
  return usageRateEditionOf(parsed) === usageRateEditionOf(right)
    && (['id', 'month', 'league', 'path', 'capturedAt'] as const).every(key => parsed[key] === right[key])
}

type PreparedMonth =
  | { month: string; status: 'unavailable' | 'error' }
  | { month: string; status: 'ready'; dataset: UsageRateDataset }

/** Reject stale, duplicated or injected observations before they can contribute a published value. */
function prepareHistory(
  manifest: UsageRateManifest,
  selection: UsageRateHistorySelection,
  results: readonly UsageRateHistoryResult[],
): PreparedMonth[] {
  const descriptors = selectedDescriptors(manifest, selection)
  const byMonth = new Map<string, UsageRateHistoryResult[]>()
  for (const result of results) {
    const entries = byMonth.get(result.month) ?? []
    entries.push(result)
    byMonth.set(result.month, entries)
  }
  const source = selection.edition === 'master' ? USAGE_RATE_EDITION_SOURCES.master : manifest.source
  return usageRateSelectedMonths(selection).map((month): PreparedMonth => {
    const descriptor = descriptors.get(month)
    if (!descriptor) return { month, status: 'unavailable' }
    const matches = byMonth.get(month)
    const result = matches?.length === 1 ? matches[0] : undefined
    if (!result || result.status !== 'ready') return { month, status: 'error' }
    try {
      if (!sameDescriptor(result.descriptor, descriptor)) return { month, status: 'error' }
      const dataset = parseUsageRateDataset(result.dataset, descriptor)
      if (dataset.source.url !== source.url) return { month, status: 'error' }
      return { month, status: 'ready', dataset }
    } catch {
      return { month, status: 'error' }
    }
  })
}

function projectPoint(prepared: PreparedMonth, characterId: string, controlType: UsageRateHistoryControlType): UsageRateHistoryPoint {
  const empty = {
    month: prepared.month, entry: null, percentThousandths: null, value: null,
    capturedAt: null, generatedAt: null, source: null,
  }
  if (prepared.status !== 'ready') return { ...empty, status: prepared.status }
  const dataset = prepared.dataset
  const distribution = dataset.distributions.find(item => item.controlType === (controlType === 'combined' ? 'all' : controlType))
  const metadata = {
    ...empty, capturedAt: dataset.capturedAt, generatedAt: dataset.generatedAt, source: dataset.source,
    ...(distribution?.totalMismatch ? { totalMismatch: distribution.totalMismatch } : {}),
  }
  if (!distribution) return { ...metadata, status: 'unavailable' }
  const entry = distribution.entries.find(item => item.characterId === characterId)
  if (!entry) return { ...metadata, status: 'unlisted' }
  const value = entry.percentThousandths === null ? null : entry.percentThousandths / 1000
  return { ...metadata, entry, value, percentThousandths: entry.percentThousandths, status: value === null ? 'missing' : 'value' }
}

/** Project the selected official distributions without averages, inferred counts or zero-filled characters. */
export function createCharacterUsageRateHistory(
  value: UsageRateManifest,
  selection: UsageRateSelection,
  character: { characterId: string; name: string },
  operationMode: UsageRateHistoryOperationMode,
  results: readonly UsageRateHistoryResult[],
): CharacterUsageRateHistory {
  const manifest = parseUsageRateManifest(value)
  const edition = usageRateEditionOf(selection)
  usageRateSelectedMonths(selection)
  if (!USAGE_RATE_EDITION_OPERATION_MODES[edition].includes(operationMode)) throw new Error('操作タイプの指定が正しくありません。')
  const selected = { edition, league: selection.league, fromMonth: selection.fromMonth, toMonth: selection.toMonth }
  const prepared = prepareHistory(manifest, selected, results)
  const controls: UsageRateHistoryControlType[] = operationMode === 'combined' ? ['combined'] : ['classic', 'modern']
  return {
    selection: selected, characterId: character.characterId, characterName: character.name, operationMode,
    series: controls.map(controlType => ({ controlType, points: prepared.map(month => projectPoint(month, character.characterId, controlType)) })),
  }
}

/** Retain the stored three-decimal text and all distinct missing states. */
export function formatUsageRateHistoryPoint(point: UsageRateHistoryPoint | undefined): string {
  return formatLeagueUsageRatePoint(point)
}

/** A zero-based usage-rate axis contains every valid value and has no win-rate reference. */
export function monthlyUsageRateAxis(values: readonly number[]): MonthlyLineChartAxis & { readonly step: number } {
  const finite = values.filter(value => Number.isFinite(value) && value >= 0 && value <= 100)
  const maximum = Math.max(0, ...finite)
  const padded = Math.min(100, Math.max(1, maximum * 1.1))
  const step = [0.5, 1, 2, 5, 10, 20, 25].find(value => value >= padded / 5) ?? 25
  const end = Math.min(100, Math.ceil(padded / step) * step)
  const ticks = Array.from({ length: Math.round(end / step) + 1 }, (_, index) => index * step)
  return { start: 0, end, ticks, step }
}
