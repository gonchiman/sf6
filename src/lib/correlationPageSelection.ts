import { correlationConditions, correlationMonths } from './winUsageCorrelation.ts'
import { WIN_RATE_EDITION_LEAGUES } from './winRateConditions.ts'
import type { UsageRateManifest } from '../types/usageRates.ts'
import type { WinRateManifest } from '../types/winRates.ts'
import type { CorrelationMode, CorrelationSelection } from '../types/winUsageCorrelation.ts'

export interface CorrelationPageCalendar {
  edition: CorrelationSelection['edition']
  controlType: CorrelationSelection['controlType']
  /** Full calendar between the first and last matching publication, including gaps. */
  months: string[]
  /** Official order, including leagues without publications for this condition. */
  leagues: readonly string[]
}

export interface CorrelationPageState {
  selection: CorrelationSelection
  selectedMonth: string
  mode: CorrelationMode
}

export type CorrelationPagePatch = Partial<CorrelationSelection & Pick<CorrelationPageState, 'selectedMonth' | 'mode'>>

/** Publication bounds belong to edition/control, independently of the detail league. */
export function correlationPageCalendars(win: WinRateManifest, usage: UsageRateManifest): CorrelationPageCalendar[] {
  const conditions = correlationConditions(win, usage)
  const calendars: CorrelationPageCalendar[] = []
  for (const edition of ['general', 'master'] as const) {
    for (const controlType of ['combined', 'classic', 'modern'] as const) {
      const publishedMonths = [...new Set(conditions.filter(item => item.edition === edition
        && item.controlType === controlType).flatMap(item => item.months))].sort()
      if (!publishedMonths.length) continue
      const leagues = WIN_RATE_EDITION_LEAGUES[edition]
      const months = correlationMonths({ edition, controlType, league: leagues[0],
        fromMonth: publishedMonths[0], toMonth: publishedMonths.at(-1)! })
      calendars.push({ edition, controlType, months, leagues })
    }
  }
  return calendars
}

function chooseCalendar(calendars: readonly CorrelationPageCalendar[], edition: CorrelationSelection['edition'],
  controlType: CorrelationSelection['controlType']): CorrelationPageCalendar {
  const available = calendars.filter(item => item.edition === edition)
  const candidates = available.length ? available : calendars.filter(item => item.edition === 'general')
  const fallback = candidates.length ? candidates : calendars
  const calendar = fallback.find(item => item.controlType === controlType)
    ?? fallback.find(item => item.controlType === 'combined') ?? fallback[0]
  if (!calendar || !calendar.months.length || !calendar.leagues.length) {
    throw new Error('勝率と使用率の両方が揃う条件がありません。')
  }
  return calendar
}

function chooseLeague(calendar: CorrelationPageCalendar, league: string): string {
  return calendar.leagues.includes(league) ? league : calendar.leagues.includes('MASTER') ? 'MASTER' : calendar.leagues[0]
}

function clampMonth(month: string, first: string, last: string): string {
  if (!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(month)) throw new Error('対象月はYYYY-MM形式で指定してください。')
  return month < first ? first : month > last ? last : month
}

export function initialCorrelationPageState(calendars: readonly CorrelationPageCalendar[]): CorrelationPageState {
  const calendar = chooseCalendar(calendars, 'general', 'combined')
  return {
    selection: { edition: calendar.edition, controlType: calendar.controlType, league: chooseLeague(calendar, 'MASTER'),
      fromMonth: calendar.months[0], toMonth: calendar.months.at(-1)! },
    selectedMonth: calendar.months.at(-1)!, mode: 'monthly',
  }
}

/** Correct the stored month here so an earlier out-of-range month cannot reappear later. */
export function updateCorrelationPageState(calendars: readonly CorrelationPageCalendar[], current: CorrelationPageState,
  patch: CorrelationPagePatch): CorrelationPageState {
  const calendar = chooseCalendar(calendars, patch.edition ?? current.selection.edition,
    patch.controlType ?? current.selection.controlType)
  const first = calendar.months[0]
  const last = calendar.months.at(-1)!
  let fromMonth = clampMonth(patch.fromMonth ?? current.selection.fromMonth, first, last)
  let toMonth = clampMonth(patch.toMonth ?? current.selection.toMonth, first, last)
  if (fromMonth > toMonth) {
    if (patch.fromMonth !== undefined && patch.toMonth === undefined) toMonth = fromMonth
    else if (patch.toMonth !== undefined && patch.fromMonth === undefined) fromMonth = toMonth
    else [fromMonth, toMonth] = [toMonth, fromMonth]
  }
  const mode = patch.mode ?? current.mode
  if (mode !== 'monthly' && mode !== 'common') throw new Error('集計対象の指定が正しくありません。')
  const selectedMonth = clampMonth(patch.selectedMonth ?? current.selectedMonth,
    mode === 'common' ? fromMonth : first, mode === 'common' ? toMonth : last)
  return {
    selection: { edition: calendar.edition, controlType: calendar.controlType,
      league: chooseLeague(calendar, patch.league ?? current.selection.league), fromMonth, toMonth },
    selectedMonth, mode,
  }
}
