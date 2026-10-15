import { CHARACTER_SERIES_ALIASES } from './seriesColors.ts'
import { totalPercentHundredths } from './totalWinRates.ts'
import { historySelectedDescriptors, historySelectedMonths } from './winRateHistory.ts'
import { editionOf, WIN_RATE_EDITION_LEAGUES, WIN_RATE_EDITION_SOURCES } from './winRateConditions.ts'
import { loadWinRateDataset, parseWinRateDataset, parseWinRateManifest } from './winRates.ts'
import { loadUsageRateDataset, parseUsageRateDataset, parseUsageRateManifest, usageRateEditionOf, USAGE_RATE_EDITION_SOURCES } from './usageRates.ts'
import type { WinRateDataset, WinRateDatasetDescriptor, WinRateManifest } from '../types/winRates.ts'
import type { UsageRateDataset, UsageRateDatasetDescriptor, UsageRateManifest, UsageRateTotalMismatch } from '../types/usageRates.ts'
import type {
  CorrelationCondition, CorrelationExclusion, CorrelationHistory, CorrelationHistoryResults,
  CorrelationLoaders, CorrelationMode, CorrelationPoint, CorrelationRow, CorrelationSelection,
} from '../types/winUsageCorrelation.ts'

/** Only match identical editions, leagues, months and supported operation populations. */
export function correlationConditions(winValue: WinRateManifest, usageValue: UsageRateManifest): CorrelationCondition[] {
  const win = parseWinRateManifest(winValue)
  const usage = parseUsageRateManifest(usageValue)
  const conditions: CorrelationCondition[] = []
  for (const edition of ['general', 'master'] as const) {
    for (const league of WIN_RATE_EDITION_LEAGUES[edition]) {
      const usageMonths = new Set(usage.datasets.filter(item => usageRateEditionOf(item) === edition && item.league === league).map(item => item.month))
      for (const controlType of edition === 'master' ? ['combined'] as const : ['combined', 'classic', 'modern'] as const) {
        const mode = controlType === 'combined' ? 'combined' : 'separate'
        const months = win.datasets.filter(item => editionOf(item) === edition && item.league === league
          && item.operationMode === mode && usageMonths.has(item.month)).map(item => item.month).sort()
        if (months.length) conditions.push({ edition, league, controlType, months })
      }
    }
  }
  return conditions
}

export function initialCorrelationSelection(win: WinRateManifest, usage: UsageRateManifest): CorrelationSelection {
  const conditions = correlationConditions(win, usage)
  const condition = conditions.find(item => item.edition === 'general' && item.league === 'MASTER' && item.controlType === 'combined') ?? conditions[0]
  if (!condition) throw new Error('勝率と使用率の両方が揃う条件がありません。')
  return { edition: condition.edition, league: condition.league, controlType: condition.controlType,
    fromMonth: condition.months[0], toMonth: condition.months.at(-1)! }
}

export function correlationMonths(selection: CorrelationSelection): string[] {
  if (selection.edition !== 'general' && selection.edition !== 'master') throw new Error('統計区分の指定が正しくありません。')
  return historySelectedMonths(selection)
}

function selectedData(winValue: WinRateManifest, usageValue: UsageRateManifest, selection: CorrelationSelection) {
  const win = parseWinRateManifest(winValue)
  const usage = parseUsageRateManifest(usageValue)
  const months = correlationMonths(selection)
  const selected = new Set(months)
  const winDescriptors = historySelectedDescriptors(win, selection)
  const usageDescriptors = new Map(usage.datasets.filter(item => usageRateEditionOf(item) === selection.edition
    && item.league === selection.league && selected.has(item.month)).map(item => [item.month, item]))
  return { win, usage, months, winDescriptors, usageDescriptors }
}

export function correlationHistoryRequestKey(win: WinRateManifest, usage: UsageRateManifest, selection: CorrelationSelection): string {
  const data = selectedData(win, usage, selection)
  return JSON.stringify([data.win.generatedAt, data.usage.generatedAt, data.win.source.url, data.usage.source.url,
    selection, [...data.winDescriptors.values()], [...data.usageDescriptors.values()]])
}

/** Four requests total, including both sources. Existing loaders own caching and failed-request retries. */
export async function loadCorrelationHistory(
  winValue: WinRateManifest, usageValue: UsageRateManifest, selection: CorrelationSelection, loaders: CorrelationLoaders = {},
): Promise<CorrelationHistoryResults> {
  const { win, usage, months, winDescriptors, usageDescriptors } = selectedData(winValue, usageValue, selection)
  const winSource = selection.edition === 'master' ? WIN_RATE_EDITION_SOURCES.master : win.source
  const usageSource = selection.edition === 'master' ? USAGE_RATE_EDITION_SOURCES.master : usage.source
  const results: CorrelationHistoryResults = { winResults: [], usageResults: [] }
  const tasks: (() => Promise<void>)[] = []
  for (const month of months) {
    const winDescriptor = winDescriptors.get(month)
    if (winDescriptor) tasks.push(async () => {
      try {
        const dataset = parseWinRateDataset(await (loaders.win ?? loadWinRateDataset)(winDescriptor), winDescriptor)
        if (dataset.source.url !== winSource.url) throw new Error('勝率の出典が一致しません。')
        results.winResults.push({ month, descriptor: winDescriptor, status: 'ready', dataset })
      } catch { results.winResults.push({ month, descriptor: winDescriptor, status: 'error' }) }
    })
    const usageDescriptor = usageDescriptors.get(month)
    if (!usageDescriptor) results.usageResults.push({ month, status: 'missing' })
    else tasks.push(async () => {
      try {
        const dataset = parseUsageRateDataset(await (loaders.usage
          ? loaders.usage(usageDescriptor) : loadUsageRateDataset(usageDescriptor, usage.generatedAt, usageSource)), usageDescriptor)
        if (dataset.source.url !== usageSource.url) throw new Error('使用率の出典が一致しません。')
        results.usageResults.push({ month, descriptor: usageDescriptor, status: 'ready', dataset })
      } catch { results.usageResults.push({ month, descriptor: usageDescriptor, status: 'error' }) }
    })
  }
  let next = 0
  async function worker(): Promise<void> { while (next < tasks.length) await tasks[next++]() }
  await Promise.all(Array.from({ length: Math.min(4, tasks.length) }, () => worker()))
  results.winResults.sort((a, b) => a.month.localeCompare(b.month))
  results.usageResults.sort((a, b) => a.month.localeCompare(b.month))
  return results
}

function canonicalId(id: string): string {
  return Object.hasOwn(CHARACTER_SERIES_ALIASES, id) ? CHARACTER_SERIES_ALIASES[id as keyof typeof CHARACTER_SERIES_ALIASES] : id
}

function sameDescriptor(left: WinRateDatasetDescriptor | UsageRateDatasetDescriptor, right: WinRateDatasetDescriptor | UsageRateDatasetDescriptor): boolean {
  return editionOf(left) === editionOf(right)
    && (['id', 'month', 'league', 'path', 'capturedAt'] as const).every(key => left[key] === right[key])
    && ('operationMode' in left ? left.operationMode : undefined) === ('operationMode' in right ? right.operationMode : undefined)
}

interface WinValue { name: string; winRate: number | null; lowSample: boolean }
interface UsageValue { name: string; usageRate: number | null }
type PreparedWin = { status: 'ready'; dataset: WinRateDataset; values: Map<string, WinValue> } | { status: 'unavailable' | 'error' }
type PreparedUsage = { status: 'ready'; dataset: UsageRateDataset; values: Map<string, UsageValue>;
  totalMismatch: UsageRateTotalMismatch | null; publishedTotal: number | null } | { status: 'unavailable' | 'error' }

function prepareWin(
  month: string, descriptor: WinRateDatasetDescriptor | undefined, results: CorrelationHistoryResults,
  selection: CorrelationSelection, expectedSource: string,
): PreparedWin {
  if (!descriptor) return { status: 'unavailable' }
  const matches = results.winResults.filter(item => item.month === month)
  const result = matches.length === 1 ? matches[0] : undefined
  if (!result || result.status !== 'ready') return { status: 'error' }
  try {
    if (!sameDescriptor(result.descriptor, descriptor)) throw new Error('descriptor')
    const dataset = parseWinRateDataset(result.dataset, descriptor)
    if (dataset.source.url !== expectedSource) throw new Error('source')
    const rows = new Map(dataset.rows.map(row => [row.fighterId, row.total]))
    const control = selection.controlType === 'combined' ? null : selection.controlType
    const values = new Map<string, WinValue>()
    for (const fighter of dataset.fighters.filter(item => item.controlType === control)) {
      const id = canonicalId(fighter.characterId)
      if (values.has(id)) throw new Error('duplicate canonical character')
      const total = rows.get(fighter.id)!
      const percent = totalPercentHundredths(total.text)
      values.set(id, { name: fighter.name, winRate: percent === null ? null : percent / 100, lowSample: total.lowSample })
    }
    return { status: 'ready', dataset, values }
  } catch { return { status: 'error' } }
}

function prepareUsage(
  month: string, descriptor: UsageRateDatasetDescriptor | undefined, results: CorrelationHistoryResults,
  selection: CorrelationSelection, expectedSource: string,
): PreparedUsage {
  if (!descriptor) return { status: 'unavailable' }
  const matches = results.usageResults.filter(item => item.month === month)
  const result = matches.length === 1 ? matches[0] : undefined
  if (!result || result.status !== 'ready') return { status: 'error' }
  try {
    if (!sameDescriptor(result.descriptor, descriptor)) throw new Error('descriptor')
    const dataset = parseUsageRateDataset(result.dataset, descriptor)
    if (dataset.source.url !== expectedSource) throw new Error('source')
    const distribution = dataset.distributions.find(item => item.controlType === (selection.controlType === 'combined' ? 'all' : selection.controlType))
    if (!distribution) return { status: 'unavailable' }
    const values = new Map<string, UsageValue>()
    for (const entry of distribution.entries) {
      const id = canonicalId(entry.characterId)
      if (values.has(id)) throw new Error('duplicate canonical character')
      values.set(id, { name: entry.name, usageRate: entry.percentThousandths === null ? null : entry.percentThousandths / 1000 })
    }
    const numericValues = distribution.entries.flatMap(entry => entry.percentThousandths === null ? [] : [entry.percentThousandths])
    return { status: 'ready', dataset, values, totalMismatch: distribution.totalMismatch ?? null,
      publishedTotal: numericValues.length ? numericValues.reduce((sum, value) => sum + value, 0) / 1000 : null }
  } catch { return { status: 'error' } }
}

/** Stable centered sums; rounded publication precision is retained until display. */
export function pearsonCorrelation(x: readonly number[], y: readonly number[]): number | null {
  if (x.length !== y.length || x.length < 3 || [...x, ...y].some(value => !Number.isFinite(value))) return null
  if (new Set(x).size < 2 || new Set(y).size < 2) return null
  const meanX = x.reduce((sum, value) => sum + value, 0) / x.length
  const meanY = y.reduce((sum, value) => sum + value, 0) / y.length
  let covariance = 0
  let varianceX = 0
  let varianceY = 0
  for (let i = 0; i < x.length; i++) {
    const dx = x[i] - meanX
    const dy = y[i] - meanY
    covariance += dx * dy
    varianceX += dx * dx
    varianceY += dy * dy
  }
  if (varianceX === 0 || varianceY === 0) return null
  const value = covariance / Math.sqrt(varianceX * varianceY)
  return Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : null
}

function ranks(values: readonly number[]): number[] {
  const ordered = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value)
  const result = new Array<number>(values.length)
  for (let from = 0; from < ordered.length;) {
    let to = from + 1
    while (to < ordered.length && ordered[to].value === ordered[from].value) to++
    const rank = (from + 1 + to) / 2
    for (let i = from; i < to; i++) result[ordered[i].index] = rank
    from = to
  }
  return result
}

export function spearmanCorrelation(x: readonly number[], y: readonly number[]): number | null {
  if ([...x, ...y].some(value => !Number.isFinite(value))) return null
  return pearsonCorrelation(ranks(x), ranks(y))
}

function summarize(points: CorrelationPoint[]): Pick<CorrelationRow, 'pearson' | 'spearman' | 'unavailableReason'> {
  const win = points.map(point => point.winRate)
  const usage = points.map(point => point.usageRate)
  const unavailableReason = points.length < 3 ? 'insufficient-characters'
    : new Set(win).size < 2 ? 'constant-win-rate' : new Set(usage).size < 2 ? 'constant-usage-rate' : null
  return { pearson: unavailableReason ? null : pearsonCorrelation(usage, win),
    spearman: unavailableReason ? null : spearmanCorrelation(usage, win), unavailableReason }
}

function prepareRow(month: string, win: PreparedWin, usage: PreparedUsage): CorrelationRow {
  const row: CorrelationRow = {
    month, status: win.status === 'error' || usage.status === 'error' ? 'error'
      : win.status === 'unavailable' || usage.status === 'unavailable' ? 'unavailable' : 'ready',
    winStatus: win.status, usageStatus: usage.status, points: [], pearson: null, spearman: null,
    unavailableReason: null, listedCount: null, exclusions: [],
    winSource: win.status === 'ready' ? win.dataset.source : null,
    usageSource: usage.status === 'ready' ? usage.dataset.source : null,
    winCapturedAt: win.status === 'ready' ? win.dataset.capturedAt : null,
    usageCapturedAt: usage.status === 'ready' ? usage.dataset.capturedAt : null,
    winGeneratedAt: win.status === 'ready' ? win.dataset.generatedAt : null,
    usageGeneratedAt: usage.status === 'ready' ? usage.dataset.generatedAt : null,
    usageTotalMismatch: usage.status === 'ready' ? usage.totalMismatch : null,
    usagePublishedTotal: usage.status === 'ready' ? usage.publishedTotal : null,
  }
  if (win.status !== 'ready' || usage.status !== 'ready') return row
  const ids = new Set([...win.values.keys(), ...usage.values.keys()])
  row.listedCount = ids.size
  for (const characterId of ids) {
    const w = win.values.get(characterId)
    const u = usage.values.get(characterId)
    const name = u?.name ?? w!.name
    const reasons: CorrelationExclusion['reasons'] = []
    if (!w) reasons.push('win-unlisted')
    else {
      if (w.winRate === null) reasons.push('win-missing')
      if (w.lowSample) reasons.push('low-sample')
    }
    if (!u) reasons.push('usage-unlisted')
    else if (u.usageRate === null) reasons.push('usage-missing')
    if (reasons.length) row.exclusions.push({ characterId, name, reasons })
    else row.points.push({ characterId, name, winRate: w!.winRate!, usageRate: u!.usageRate! })
  }
  return { ...row, ...summarize(row.points) }
}

/** Each character has equal weight; no match counts, significance, zero-fill or renormalization are inferred. */
export function createCorrelationHistory(
  winValue: WinRateManifest, usageValue: UsageRateManifest, selection: CorrelationSelection,
  results: CorrelationHistoryResults, mode: CorrelationMode,
): CorrelationHistory {
  if (mode !== 'monthly' && mode !== 'common') throw new Error('集計対象の指定が正しくありません。')
  const { win, usage, months, winDescriptors, usageDescriptors } = selectedData(winValue, usageValue, selection)
  const winSource = selection.edition === 'master' ? WIN_RATE_EDITION_SOURCES.master : win.source
  const usageSource = selection.edition === 'master' ? USAGE_RATE_EDITION_SOURCES.master : usage.source
  const prepared = months.map(month => prepareRow(month,
    prepareWin(month, winDescriptors.get(month), results, selection, winSource.url),
    prepareUsage(month, usageDescriptors.get(month), results, selection, usageSource.url)))
  const commonUnavailable = prepared.some(row => row.status !== 'ready')
  const commonIds = commonUnavailable ? null : prepared[0].points.map(point => point.characterId)
    .filter(id => prepared.every(row => row.points.some(point => point.characterId === id)))
  const common = commonIds === null ? null : new Set(commonIds)
  const rows = prepared.map(row => {
    if (row.status !== 'ready' || mode === 'monthly') return row
    if (common === null) return { ...row, status: 'incomplete' as const, points: [], pearson: null, spearman: null, unavailableReason: null }
    const points = row.points.filter(point => common.has(point.characterId))
    const exclusions: CorrelationExclusion[] = [...row.exclusions, ...row.points.filter(point => !common.has(point.characterId))
      .map(point => ({ characterId: point.characterId, name: point.name, reasons: ['non-common'] as CorrelationExclusion['reasons'] }))]
    return { ...row, points, exclusions, ...summarize(points) }
  })
  return { mode, rows, commonCharacterCount: commonIds?.length ?? null, commonUnavailable }
}
