import type {
  LeagueUsageRateMetadata, LeagueUsageRatePoint, LeagueUsageRateRow, LeagueUsageRates,
  LeagueUsageRateSelection, LeagueUsageRateSort,
} from '../types/leagueUsageRates.ts'
import type {
  UsageRateControlType, UsageRateDataset, UsageRateDatasetDescriptor, UsageRateEdition, UsageRateManifest,
} from '../types/usageRates.ts'
import {
  loadUsageRateDataset, parseUsageRateDataset, parseUsageRateManifest, usageRateEditionOf, usageRateMonths,
  USAGE_RATE_EDITIONS, USAGE_RATE_EDITION_LEAGUES, USAGE_RATE_EDITION_OPERATION_MODES, USAGE_RATE_EDITION_SOURCES,
} from './usageRates.ts'

export { USAGE_RATE_LEAGUES } from './usageRates.ts'

function assertMonth(month: string): void {
  if (!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(month)) throw new Error('対象月の指定が正しくありません。')
}

function selectedDescriptors(manifest: UsageRateManifest, month: string, edition: UsageRateEdition): Map<string, UsageRateDatasetDescriptor> {
  assertMonth(month)
  if (!USAGE_RATE_EDITIONS.includes(edition)) throw new Error('統計区分の指定が正しくありません。')
  return new Map(manifest.datasets.filter(item => usageRateEditionOf(item) === edition && item.month === month)
    .map(item => [item.league, item]))
}

/** Resolve unavailable dates/modes before rendering, including edition changes across different public periods. */
export function selectLeagueUsageRateConditions(
  manifest: UsageRateManifest,
  preferred: Partial<LeagueUsageRateSelection> = {},
): LeagueUsageRateSelection | null {
  const editions = USAGE_RATE_EDITIONS.filter(edition => manifest.datasets.some(item => usageRateEditionOf(item) === edition))
  const requestedEdition = usageRateEditionOf(preferred)
  const edition = editions.includes(requestedEdition) ? requestedEdition : editions[0]
  if (!edition) return null
  const months = usageRateMonths(manifest, undefined, edition)
  const month = preferred.month && months.includes(preferred.month) ? preferred.month : months.at(-1)
  if (!month) return null
  const modes = USAGE_RATE_EDITION_OPERATION_MODES[edition]
  const operationMode = preferred.operationMode && modes.includes(preferred.operationMode) ? preferred.operationMode : modes[0]
  return { edition, month, operationMode }
}

/** The request key excludes display-only operation mode; one saved file contains all published modes. */
export function leagueUsageRateComparisonKey(manifest: UsageRateManifest, selection: LeagueUsageRateSelection): string {
  const edition = usageRateEditionOf(selection)
  const source = edition === 'general' ? manifest.source : USAGE_RATE_EDITION_SOURCES[edition]
  return JSON.stringify([manifest.generatedAt, edition, source.url, selection.month,
    [...selectedDescriptors(manifest, selection.month, edition).values()]
      .map(item => [item.id, item.league, item.path, item.capturedAt]),
  ])
}

function validatedDataset(
  value: UsageRateDataset,
  descriptor: UsageRateDatasetDescriptor,
  manifest: UsageRateManifest,
): UsageRateDataset {
  const dataset = parseUsageRateDataset(value, descriptor)
  const edition = usageRateEditionOf(descriptor)
  const source = edition === 'general' ? manifest.source : USAGE_RATE_EDITION_SOURCES[edition]
  if (dataset.source.url !== source.url) throw new Error('使用率データの出典が一致しません。')
  return dataset
}

/** Reuse the cached published files; unregistered ranks never trigger a request. */
export async function loadLeagueUsageRates(
  value: UsageRateManifest,
  month: string,
  editionOrLoader: UsageRateEdition | ((descriptor: UsageRateDatasetDescriptor) => Promise<UsageRateDataset>) = 'general',
  selectedLoader?: (descriptor: UsageRateDatasetDescriptor) => Promise<UsageRateDataset>,
): Promise<LeagueUsageRateMetadata[]> {
  const manifest = parseUsageRateManifest(value)
  const edition = typeof editionOrLoader === 'function' ? 'general' : editionOrLoader
  const descriptors = selectedDescriptors(manifest, month, edition)
  const source = edition === 'general' ? manifest.source : USAGE_RATE_EDITION_SOURCES[edition]
  const loader = typeof editionOrLoader === 'function' ? editionOrLoader
    : selectedLoader ?? (descriptor => loadUsageRateDataset(descriptor, manifest.generatedAt, source))
  const leagues = USAGE_RATE_EDITION_LEAGUES[edition]
  const results = new Array<LeagueUsageRateMetadata>(leagues.length)
  let next = 0
  async function worker(): Promise<void> {
    while (next < leagues.length) {
      const index = next++
      const league = leagues[index]
      const descriptor = descriptors.get(league)
      if (!descriptor) { results[index] = { league, status: 'unavailable' }; continue }
      try {
        const dataset = validatedDataset(await loader(descriptor), descriptor, manifest)
        results[index] = { league, status: 'ready', dataset }
      } catch {
        results[index] = { league, status: 'error' }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, leagues.length) }, () => worker()))
  return results
}

function prepareMetadata(
  manifest: UsageRateManifest,
  month: string,
  edition: UsageRateEdition,
  results: readonly LeagueUsageRateMetadata[],
): LeagueUsageRateMetadata[] {
  const descriptors = selectedDescriptors(manifest, month, edition)
  return USAGE_RATE_EDITION_LEAGUES[edition].map(league => {
    const descriptor = descriptors.get(league)
    if (!descriptor) return { league, status: 'unavailable' }
    const matches = results.filter(item => item.league === league)
    const result = matches.length === 1 ? matches[0] : undefined
    if (result?.status !== 'ready' || !result.dataset) return { league, status: 'error' }
    try {
      return { league, status: 'ready', dataset: validatedDataset(result.dataset, descriptor, manifest) }
    } catch {
      return { league, status: 'error' }
    }
  })
}

function point(metadata: LeagueUsageRateMetadata, control: UsageRateControlType, characterId: string): LeagueUsageRatePoint {
  const empty = { entry: null, percentThousandths: null }
  if (metadata.status !== 'ready' || !metadata.dataset) return { ...empty, status: metadata.status === 'unavailable' ? 'unavailable' : 'error' }
  const distribution = metadata.dataset.distributions.find(item => item.controlType === control)
  if (!distribution) return { ...empty, status: 'unavailable' }
  const entry = distribution.entries.find(item => item.characterId === characterId)
  if (!entry) return { ...empty, status: 'unlisted' }
  return { entry, percentThousandths: entry.percentThousandths, status: entry.percentThousandths === null ? 'missing' : 'value' }
}

/** Keep each official league distribution intact; ALL is never reconstructed from ranks or C/M. */
export function createLeagueUsageRates(
  value: UsageRateManifest,
  selection: LeagueUsageRateSelection,
  results: readonly LeagueUsageRateMetadata[],
): LeagueUsageRates {
  const manifest = parseUsageRateManifest(value)
  const edition = usageRateEditionOf(selection)
  if (!USAGE_RATE_EDITIONS.includes(edition)) throw new Error('統計区分の指定が正しくありません。')
  if (!USAGE_RATE_EDITION_OPERATION_MODES[edition].includes(selection.operationMode)) throw new Error('操作タイプの指定が正しくありません。')
  const metadata = prepareMetadata(manifest, selection.month, edition, results)
  const characters = new Map<string, { characterId: string; name: string }>()
  for (const item of metadata) {
    const dataset = item.dataset
    if (!dataset) continue
    const distributions = (['all', 'classic', 'modern'] as const).flatMap(control =>
      dataset.distributions.filter(distribution => distribution.controlType === control))
    for (const distribution of distributions) {
      for (const entry of distribution.entries) {
        if (!characters.has(entry.characterId)) characters.set(entry.characterId, { characterId: entry.characterId, name: entry.name })
      }
    }
  }
  const controls: UsageRateControlType[] = selection.operationMode === 'combined' ? ['all'] : ['classic', 'modern']
  return {
    leagues: [...USAGE_RATE_EDITION_LEAGUES[edition]], metadata,
    rows: [...characters.values()].flatMap(character => controls.map(control => ({
      key: `${character.characterId}:${control === 'all' ? 'combined' : control}`,
      ...character,
      controlType: control === 'all' ? null : control,
      values: metadata.map(item => point(item, control, character.characterId)),
    }))),
  }
}

export function formatLeagueUsageRatePoint(point: LeagueUsageRatePoint | undefined): string {
  if (!point || point.status === 'unavailable') return '未登録'
  if (point.status === 'error') return '読込失敗'
  if (point.status === 'unlisted') return '未掲載'
  const text = point.entry?.text
  if (!text) return '欠損'
  if (text === '-' || text === '-.---') return text
  return text.endsWith('%') ? text : `${text}%`
}

/** Valid published values precede all missing states in either direction; ties keep official order. */
export function sortLeagueUsageRateRows(
  rows: readonly LeagueUsageRateRow[],
  leagues: readonly string[],
  sort: LeagueUsageRateSort,
): LeagueUsageRateRow[] {
  const column = sort.league === null ? -1 : leagues.indexOf(sort.league)
  if (column < 0) return [...rows]
  const direction = sort.direction === 'ascending' ? 1 : -1
  return rows.map((row, index) => {
    const point = row.values[column]
    const percent = point?.status === 'value' ? point.percentThousandths : null
    const value = percent !== null && Number.isFinite(percent) ? percent : null
    return { row, index, value }
  }).sort((left, right) => {
    if (left.value === null) return right.value === null ? left.index - right.index : 1
    if (right.value === null) return -1
    return (left.value - right.value) * direction || left.index - right.index
  }).map(item => item.row)
}
