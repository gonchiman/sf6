import { WIN_RATE_EDITIONS, WIN_RATE_EDITION_LEAGUES } from './winRateConditions.ts'
import { loadWinRateDataset } from './winRates.ts'
import { loadUsageRateDataset, USAGE_RATE_EDITION_SOURCES } from './usageRates.ts'
import {
  correlationHistoryRequestKey, correlationMonths, createCorrelationHistory, loadCorrelationHistory,
} from './winUsageCorrelation.ts'
import type { WinRateManifest } from '../types/winRates.ts'
import type { UsageRateManifest } from '../types/usageRates.ts'
import type {
  CorrelationHistoryResults, CorrelationLoaders, CorrelationMode, CorrelationRow, CorrelationSelection,
} from '../types/winUsageCorrelation.ts'

export type LeagueCorrelationResults = Partial<Record<string, CorrelationHistoryResults>>
export type LeagueCorrelationRow = { league: string; row: CorrelationRow }

function leagueSelections(selection: CorrelationSelection, month: string, mode: CorrelationMode): CorrelationSelection[] {
  if (mode !== 'monthly' && mode !== 'common') throw new Error('集計対象の指定が正しくありません。')
  if (!WIN_RATE_EDITIONS.includes(selection.edition)) throw new Error('統計区分の指定が正しくありません。')
  const leagues = WIN_RATE_EDITION_LEAGUES[selection.edition]
  const period = { ...selection, league: leagues[0],
    ...(mode === 'monthly' ? { fromMonth: month, toMonth: month } : {}) }
  if (!correlationMonths(period).includes(month)) throw new Error('対象月は選択した期間内に指定してください。')
  return leagues.map(league => ({ ...period, league }))
}

/** The selected history league does not affect this table's populations or requests. */
export function leagueCorrelationRequestKey(
  win: WinRateManifest, usage: UsageRateManifest, selection: CorrelationSelection, month: string, mode: CorrelationMode,
): string {
  return JSON.stringify([month, mode, leagueSelections(selection, month, mode)
    .map(item => correlationHistoryRequestKey(win, usage, item))])
}

/** Use one pool for both metrics and every league, including failures and retries. */
function createRequestLimit() {
  let active = 0
  const pending: Array<() => void> = []
  return async <T>(load: () => Promise<T>): Promise<T> => {
    await new Promise<void>(resolve => {
      const start = () => { active += 1; resolve() }
      if (active < 4) start()
      else pending.push(start)
    })
    try {
      return await load()
    } finally {
      active -= 1
      pending.shift()?.()
    }
  }
}

/** Existing history loaders validate each source and retain their published-file caches. */
export async function loadLeagueCorrelationComparison(
  win: WinRateManifest, usage: UsageRateManifest, selection: CorrelationSelection, month: string, mode: CorrelationMode,
  loaders: CorrelationLoaders = {},
): Promise<LeagueCorrelationResults> {
  const selections = leagueSelections(selection, month, mode)
  const limit = createRequestLimit()
  const usageSource = selection.edition === 'master' ? USAGE_RATE_EDITION_SOURCES.master : usage.source
  const limitedLoaders: CorrelationLoaders = {
    win: descriptor => limit(() => (loaders.win ?? loadWinRateDataset)(descriptor)),
    usage: descriptor => limit(() => loaders.usage
      ? loaders.usage(descriptor) : loadUsageRateDataset(descriptor, usage.generatedAt, usageSource)),
  }
  const entries = await Promise.all(selections.map(async item => [item.league,
    await loadCorrelationHistory(win, usage, item, limitedLoaders)] as const))
  return Object.fromEntries(entries)
}

/** Keep official order, registration gaps and each league's own common-character population. */
export function createLeagueCorrelationRows(
  win: WinRateManifest, usage: UsageRateManifest, selection: CorrelationSelection, month: string,
  results: LeagueCorrelationResults, mode: CorrelationMode,
): LeagueCorrelationRow[] {
  return leagueSelections(selection, month, mode).map(item => {
    const history = createCorrelationHistory(win, usage, item,
      results[item.league] ?? { winResults: [], usageResults: [] }, mode)
    return { league: item.league, row: history.rows.find(row => row.month === month)! }
  })
}
