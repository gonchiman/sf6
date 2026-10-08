import { formatTotalPercent, totalPercentHundredths } from './totalWinRates.ts'
import { loadWinRateDataset, parseWinRateDataset } from './winRates.ts'
import { editionOf, WIN_RATE_EDITIONS, WIN_RATE_EDITION_LEAGUES } from './winRateConditions.ts'
import type { WinRateCell, WinRateDataset, WinRateDatasetDescriptor, WinRateManifest } from '../types/winRates.ts'
import type { HistoryDatasetResult, WinRateHistoryPoint, WinRateHistorySelection, WinRateHistorySeries } from '../types/winRateHistory.ts'

function monthIndex(month: string): number {
  if (!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(month)) throw new Error('対象月はYYYY-MM形式で指定してください。')
  const [year, number] = month.split('-').map(Number)
  return year * 12 + number - 1
}

function indexedMonth(index: number): string {
  return `${String(Math.floor(index / 12)).padStart(4, '0')}-${String(index % 12 + 1).padStart(2, '0')}`
}

export function historySelectedMonths(selection: WinRateHistorySelection): string[] {
  const edition = editionOf(selection)
  if (!WIN_RATE_EDITIONS.includes(edition) || !WIN_RATE_EDITION_LEAGUES[edition].includes(selection.league)
    || !['combined', 'classic', 'modern'].includes(selection.controlType)
    || (edition === 'master' && selection.controlType !== 'combined')) {
    throw new Error('リーグまたは操作タイプの指定が正しくありません。')
  }
  const from = monthIndex(selection.fromMonth)
  const to = monthIndex(selection.toMonth)
  if (from > to) throw new Error('開始月は終了月以前にしてください。')
  return Array.from({ length: to - from + 1 }, (_, index) => indexedMonth(from + index))
}

export function historySelectedDescriptors(manifest: WinRateManifest, selection: WinRateHistorySelection): Map<string, WinRateDatasetDescriptor> {
  const months = new Set(historySelectedMonths(selection))
  const mode = selection.controlType === 'combined' ? 'combined' : 'separate'
  const result = new Map<string, WinRateDatasetDescriptor>()
  for (const descriptor of manifest.datasets) {
    if (editionOf(descriptor) !== editionOf(selection) || !months.has(descriptor.month)
      || descriptor.league !== selection.league || descriptor.operationMode !== mode) continue
    if (result.has(descriptor.month)) throw new Error('同じ月・条件の勝率データが重複しています。')
    result.set(descriptor.month, descriptor)
  }
  return result
}

function sameDescriptor(left: WinRateDatasetDescriptor, right: WinRateDatasetDescriptor): boolean {
  return editionOf(left) === editionOf(right) && (['id', 'month', 'league', 'operationMode', 'path', 'capturedAt'] as const)
    .every((key) => left[key] === right[key])
}

export function historyMonths(manifest: WinRateManifest): string[] {
  return [...new Set(manifest.datasets.map((item) => {
    monthIndex(item.month)
    return item.month
  }))].sort()
}

/** Include gaps so period controls can represent every displayed calendar month. */
export function historyCalendarMonths(manifest: WinRateManifest): string[] {
  const months = historyMonths(manifest)
  if (!months.length) return []
  const from = monthIndex(months[0])
  const to = monthIndex(months[months.length - 1])
  return Array.from({ length: to - from + 1 }, (_, index) => indexedMonth(from + index))
}

export function initialHistorySelection(manifest: WinRateManifest): WinRateHistorySelection {
  const months = historyMonths({ ...manifest, datasets: manifest.datasets.filter((item) => editionOf(item) === 'general') })
  if (months.length === 0) throw new Error('表示できる対象月がありません。')
  const toMonth = months[months.length - 1]
  const fromIndex = Math.max(monthIndex(months[0]), monthIndex(toMonth) - 11)
  return { edition: 'general', league: 'MASTER', controlType: 'combined', fromMonth: indexedMonth(fromIndex), toMonth }
}

/** Load only the selected conditions; cache and retries belong to the existing dataset loader. */
export async function loadWinRateHistory(
  manifest: WinRateManifest,
  selection: WinRateHistorySelection,
  loader: (descriptor: WinRateDatasetDescriptor) => Promise<WinRateDataset> = loadWinRateDataset,
): Promise<HistoryDatasetResult[]> {
  const descriptors = [...historySelectedDescriptors(manifest, selection).values()].sort((left, right) => left.month.localeCompare(right.month))
  const results = new Array<HistoryDatasetResult>(descriptors.length)
  let next = 0
  async function worker(): Promise<void> {
    while (next < descriptors.length) {
      const index = next++
      const descriptor = descriptors[index]
      try {
        // An injected loader must meet the same condition and data checks as the default loader.
        const dataset = parseWinRateDataset(await loader(descriptor), descriptor)
        results[index] = { month: descriptor.month, descriptor, status: 'ready', dataset }
      } catch {
        results[index] = { month: descriptor.month, descriptor, status: 'error' }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, descriptors.length) }, () => worker()))
  return results
}

type PreparedHistoryMonth =
  | { month: string; status: 'unavailable' | 'error' }
  | { month: string; status: 'ready'; dataset: WinRateDataset; totals: Map<string, WinRateCell> }

/** 月別データを一度だけ検証し、選択中の操作タイプのTotalをキャラIDに対応付ける。 */
function prepareHistoryMonths(
  manifest: WinRateManifest,
  selection: WinRateHistorySelection,
  results: readonly HistoryDatasetResult[],
): PreparedHistoryMonth[] {
  const descriptors = historySelectedDescriptors(manifest, selection)
  const controls = selection.controlType === 'combined' ? null : selection.controlType
  const resultsByMonth = new Map<string, HistoryDatasetResult[]>()
  for (const result of results) {
    const entries = resultsByMonth.get(result.month) ?? []
    entries.push(result)
    resultsByMonth.set(result.month, entries)
  }
  return historySelectedMonths(selection).map((month): PreparedHistoryMonth => {
    const descriptor = descriptors.get(month)
    if (!descriptor) return { month, status: 'unavailable' }
    const entries = resultsByMonth.get(month)
    const result = entries?.length === 1 ? entries[0] : undefined
    if (!result || !sameDescriptor(result.descriptor, descriptor) || result.status !== 'ready') {
      return { month, status: 'error' }
    }
    try {
      const dataset = parseWinRateDataset(result.dataset, descriptor)
      const rows = new Map(dataset.rows.map((row) => [row.fighterId, row.total]))
      const totals = new Map<string, WinRateCell>()
      for (const fighter of dataset.fighters) {
        if (fighter.controlType === controls) totals.set(fighter.characterId, rows.get(fighter.id)!)
      }
      return { month, status: 'ready', dataset, totals }
    } catch {
      return { month, status: 'error' }
    }
  })
}

function projectHistoryPoint(prepared: PreparedHistoryMonth, characterId: string): WinRateHistoryPoint {
  const empty = { month: prepared.month, total: null, percentHundredths: null, capturedAt: null, source: null }
  if (prepared.status !== 'ready') return { ...empty, status: prepared.status }
  const metadata = { ...empty, capturedAt: prepared.dataset.capturedAt, source: prepared.dataset.source }
  const total = prepared.totals.get(characterId)
  if (!total) return { ...metadata, status: 'unlisted' }
  const percentHundredths = totalPercentHundredths(total.text)
  return { ...metadata, status: percentHundredths === null ? 'missing' : 'value', total, percentHundredths }
}

/** 全キャラを同じ条件・月カレンダーに投影する。ID重複は最初の選択を保持する。 */
export function createWinRateHistorySeries(
  manifest: WinRateManifest,
  selection: WinRateHistorySelection,
  characters: readonly { characterId: string; name: string }[],
  results: readonly HistoryDatasetResult[],
): WinRateHistorySeries[] {
  const uniqueCharacters = new Map<string, { characterId: string; name: string }>()
  for (const character of characters) {
    if (!uniqueCharacters.has(character.characterId)) uniqueCharacters.set(character.characterId, character)
  }
  if (uniqueCharacters.size === 0) return []
  const prepared = prepareHistoryMonths(manifest, selection, results)
  return [...uniqueCharacters.values()].map(({ characterId, name }) => ({
    characterId, characterName: name,
    points: prepared.map((month) => projectHistoryPoint(month, characterId)),
  }))
}

/** Keep calendar gaps and distinct no-value states instead of filling or averaging them. */
export function createWinRateHistoryPoints(
  manifest: WinRateManifest,
  selection: WinRateHistorySelection,
  characterId: string,
  results: readonly HistoryDatasetResult[],
): WinRateHistoryPoint[] {
  return createWinRateHistorySeries(manifest, selection, [{ characterId, name: characterId }], results)[0].points
}

export function formatHistoryValue(point: WinRateHistoryPoint): string {
  switch (point.status) {
    case 'value':
    case 'missing':
      return point.total ? formatTotalPercent(point.total.text) : '欠損'
    case 'unlisted': return '未掲載'
    case 'unavailable': return '未登録'
    case 'error': return '読込失敗'
  }
}

export function monthLabel(month: string): string {
  monthIndex(month)
  const [year, number] = month.split('-')
  return `${year}年${Number(number)}月`
}
