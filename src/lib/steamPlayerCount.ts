import type {
  SteamPlayerCountAppId, SteamPlayerCountDateRange, SteamPlayerCountDay, SteamPlayerCountDayDescriptor, SteamPlayerCountDayType,
  SteamPlayerCountHourlyRow, SteamPlayerCountManifest, SteamPlayerCountObservation, SteamPlayerCountRangeSelection,
} from '../types/steamPlayerCount.ts'
import { getSteamPlayerCountGame } from './steamPlayerCountGames.ts'

export const STEAM_PLAYER_COUNT_APP_ID = 1364780
export const STEAM_PLAYER_COUNT_SCHEMA_VERSION = 1
export const STEAM_PLAYER_COUNT_SOURCE_URL = 'https://api.steampowered.com/ISteamUserStats/GetNumberOfCurrentPlayers/v1/?appid=1364780'
export const STEAM_PLAYER_COUNT_SLOT_MS = 15 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
const JST_OFFSET_MS = 9 * 60 * 60 * 1000

function invalid(field: string): never { throw new Error(`Steam同時接続数データの形式が正しくありません（${field}）。`) }
function record(value: unknown, keys: string[], field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !keys.includes(key)) || keys.some(key => !Object.hasOwn(value, key))) invalid(field)
  return value as Record<string, unknown>
}
function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value || value !== value.trim()) invalid(field)
  return value
}
function integer(value: unknown, field: string, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) invalid(field)
  return value
}
function timestamp(value: unknown, field: string): string {
  const result = text(value, field)
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(result)
    || !Number.isFinite(Date.parse(result)) || new Date(result).toISOString() !== result) invalid(field)
  return result
}
export function parseSteamPlayerCountDate(value: unknown): string {
  const result = text(value, 'date')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result) || !Number.isFinite(Date.parse(`${result}T00:00:00.000Z`))
    || new Date(`${result}T00:00:00.000Z`).toISOString().slice(0, 10) !== result) invalid('date')
  return result
}
function array(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) invalid(field)
  return value
}
function compareObservations(a: SteamPlayerCountObservation, b: SteamPlayerCountObservation): number {
  return a.observedAt.localeCompare(b.observedAt) || a.id.localeCompare(b.id)
}
function version(input: Record<string, unknown>, expectedAppId: SteamPlayerCountAppId) {
  const game = getSteamPlayerCountGame(expectedAppId)
  if (input.schemaVersion !== STEAM_PLAYER_COUNT_SCHEMA_VERSION || input.appId !== game.appId) invalid('schemaVersion/appId')
  return game
}

export function parseSteamPlayerCountObservation(value: unknown): SteamPlayerCountObservation {
  const input = record(value, ['id', 'requestStartedAt', 'observedAt', 'playerCount', 'runId', 'runAttempt'], 'observation')
  const id = text(input.id, 'id')
  if (id.length > 200 || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id)) invalid('id')
  const requestStartedAt = timestamp(input.requestStartedAt, 'requestStartedAt'), observedAt = timestamp(input.observedAt, 'observedAt')
  if (requestStartedAt > observedAt) invalid('requestStartedAt/observedAt')
  const runId = input.runId === null ? null : text(input.runId, 'runId')
  const runAttempt = input.runAttempt === null ? null : integer(input.runAttempt, 'runAttempt', 1)
  if ((runId === null) !== (runAttempt === null) || runId !== null && !/^[1-9]\d*$/.test(runId)) invalid('runId/runAttempt')
  return { id, requestStartedAt, observedAt, playerCount: integer(input.playerCount, 'playerCount'), runId, runAttempt }
}

export function parseSteamPlayerCountDayDescriptor(value: unknown): SteamPlayerCountDayDescriptor {
  const input = record(value, ['date', 'path', 'sha256', 'observationCount', 'firstObservedAt', 'lastObservedAt'], 'day descriptor')
  const date = parseSteamPlayerCountDate(input.date)
  if (input.path !== `days/${date}.json`) invalid('path')
  const sha256 = text(input.sha256, 'sha256')
  if (!/^[a-f0-9]{64}$/.test(sha256)) invalid('sha256')
  const firstObservedAt = timestamp(input.firstObservedAt, 'firstObservedAt'), lastObservedAt = timestamp(input.lastObservedAt, 'lastObservedAt')
  if (firstObservedAt > lastObservedAt || firstObservedAt.slice(0, 10) !== date || lastObservedAt.slice(0, 10) !== date) invalid('day observation interval')
  return { date, path: input.path as string, sha256, observationCount: integer(input.observationCount, 'observationCount', 1), firstObservedAt, lastObservedAt }
}

export function parseSteamPlayerCountDay(value: unknown, expected?: SteamPlayerCountDayDescriptor,
  expectedAppId: SteamPlayerCountAppId = STEAM_PLAYER_COUNT_APP_ID): SteamPlayerCountDay {
  const input = record(value, ['schemaVersion', 'appId', 'date', 'observations'], 'day')
  const game = version(input, expectedAppId)
  const date = parseSteamPlayerCountDate(input.date)
  const observations = array(input.observations, 'observations').map(parseSteamPlayerCountObservation)
  if (!observations.length || observations.some(item => item.observedAt.slice(0, 10) !== date)
    || new Set(observations.map(item => item.id)).size !== observations.length) invalid('observations: day or duplicate ID')
  if (observations.some((item, index) => index > 0 && compareObservations(observations[index - 1], item) > 0)) invalid('observations: order')
  if (expected) {
    const descriptor = parseSteamPlayerCountDayDescriptor(expected)
    if (descriptor.date !== date || descriptor.observationCount !== observations.length
      || descriptor.firstObservedAt !== observations[0].observedAt || descriptor.lastObservedAt !== observations.at(-1)!.observedAt) invalid('day descriptor mismatch')
  }
  return { schemaVersion: 1, appId: game.appId, date, observations }
}

export function parseSteamPlayerCountManifest(value: unknown, expectedAppId: SteamPlayerCountAppId = STEAM_PLAYER_COUNT_APP_ID): SteamPlayerCountManifest {
  const input = record(value, ['schemaVersion', 'appId', 'sourceUrl', 'generatedAt', 'days'], 'manifest')
  const game = version(input, expectedAppId)
  if (input.sourceUrl !== game.sourceUrl) invalid('sourceUrl')
  const generatedAt = timestamp(input.generatedAt, 'generatedAt')
  const days = array(input.days, 'days').map(parseSteamPlayerCountDayDescriptor)
  if (new Set(days.map(day => day.date)).size !== days.length || days.some(day => day.lastObservedAt > generatedAt)) invalid('days: duplicate date or future observation')
  return { schemaVersion: 1, appId: game.appId, sourceUrl: game.sourceUrl, generatedAt, days }
}

export function parseSteamPlayerCountDateRange(range: SteamPlayerCountDateRange): SteamPlayerCountDateRange {
  const from = parseSteamPlayerCountDate(range.from), to = parseSteamPlayerCountDate(range.to)
  if (from > to) invalid('date range: reversed')
  return { from, to }
}

export function getSteamPlayerCountJstDate(value: string | Date): string {
  const milliseconds = typeof value === 'string' ? Date.parse(timestamp(value, 'timestamp')) : value.getTime()
  if (!Number.isFinite(milliseconds)) invalid('timestamp')
  return new Date(milliseconds + JST_OFFSET_MS).toISOString().slice(0, 10)
}
function dateMilliseconds(date: string): number { return Date.parse(`${date}T00:00:00.000Z`) }
function shiftDate(date: string, offset: number): string { return new Date(dateMilliseconds(date) + offset * DAY_MS).toISOString().slice(0, 10) }
function matchesDayType(date: string, dayType: SteamPlayerCountDayType): boolean {
  if (!['all', 'weekday', 'weekend'].includes(dayType)) invalid('dayType')
  const day = new Date(`${date}T00:00:00.000Z`).getUTCDay(), weekend = day === 0 || day === 6
  return dayType === 'all' || (dayType === 'weekend' ? weekend : !weekend)
}

export function parseSteamPlayerCountRangeSelection(selection: SteamPlayerCountRangeSelection | null): SteamPlayerCountRangeSelection {
  if (selection === null) return '7d'
  if (typeof selection !== 'string') return parseSteamPlayerCountDateRange(selection)
  if (!['today', 'yesterday', '7d', '30d', 'all'].includes(selection)) invalid('period')
  return selection
}

function observedRange(manifest: SteamPlayerCountManifest | null): SteamPlayerCountDateRange | null {
  if (!manifest?.days.length) return null
  let first = manifest.days[0].firstObservedAt, last = manifest.days[0].lastObservedAt
  for (const day of manifest.days) {
    if (day.firstObservedAt < first) first = day.firstObservedAt
    if (day.lastObservedAt > last) last = day.lastObservedAt
  }
  return { from: getSteamPlayerCountJstDate(first), to: getSteamPlayerCountJstDate(last) }
}

/** Calendar presets are shared across games; only "all" follows observed JST bounds. */
export function resolveSteamPlayerCountRange(selection: SteamPlayerCountRangeSelection | null,
  manifest: SteamPlayerCountManifest | null = null, now = new Date()): SteamPlayerCountDateRange {
  const parsed = parseSteamPlayerCountRangeSelection(selection)
  if (typeof parsed !== 'string') return parsed
  const today = getSteamPlayerCountJstDate(now)
  if (parsed === 'all') return observedRange(manifest) ?? { from: today, to: today }
  if (parsed === 'yesterday') { const yesterday = shiftDate(today, -1); return { from: yesterday, to: yesterday } }
  return { from: shiftDate(today, parsed === '7d' ? -6 : parsed === '30d' ? -29 : 0), to: today }
}

export function getDefaultSteamPlayerCountRange(manifest: SteamPlayerCountManifest | null, now = new Date()): SteamPlayerCountDateRange {
  return resolveSteamPlayerCountRange('7d', manifest, now)
}

/** Keep the selected dates visible, but do not count days before collection began or after today. */
export function getSteamPlayerCountComparisonRange(range: SteamPlayerCountDateRange,
  manifest: SteamPlayerCountManifest | null, now = new Date()): SteamPlayerCountDateRange | null {
  const selected = parseSteamPlayerCountDateRange(range), observed = observedRange(manifest)
  if (!observed) return null
  const today = getSteamPlayerCountJstDate(now)
  const from = selected.from > observed.from ? selected.from : observed.from
  const to = selected.to < today ? selected.to : today
  return from <= to ? { from, to } : null
}

/** The request schedule does not determine a slot: only the actual observation time does. */
export function filterSteamPlayerCountObservations(observations: readonly SteamPlayerCountObservation[],
  range: SteamPlayerCountDateRange, dayType: SteamPlayerCountDayType = 'all'): SteamPlayerCountObservation[] {
  const { from, to } = parseSteamPlayerCountDateRange(range)
  matchesDayType(from, dayType)
  const slots = new Map<number, SteamPlayerCountObservation>()
  for (const observation of observations) {
    const date = getSteamPlayerCountJstDate(observation.observedAt)
    if (date < from || date > to || !matchesDayType(date, dayType)) continue
    const slot = Math.floor(Date.parse(observation.observedAt) / STEAM_PLAYER_COUNT_SLOT_MS)
    const previous = slots.get(slot)
    if (!previous || compareObservations(observation, previous) < 0) slots.set(slot, observation)
  }
  return [...slots.values()].sort(compareObservations)
}

/** Each complete date/hour contributes one mean; missing slots never become zero. */
export function buildSteamPlayerCountHourlyComparison(observations: readonly SteamPlayerCountObservation[],
  range: SteamPlayerCountDateRange | null, dayType: SteamPlayerCountDayType = 'all', now = new Date()): SteamPlayerCountHourlyRow[] {
  if (range === null) return Array.from({ length: 24 }, (_, hour) => ({ hour, mean: null, validDays: 0, totalDays: 0, observedSlots: 0, expectedSlots: 0 }))
  const { from, to } = parseSteamPlayerCountDateRange(range), today = getSteamPlayerCountJstDate(now)
  const dates: string[] = []
  for (let date = from; date <= to && date <= today; date = shiftDate(date, 1)) if (matchesDayType(date, dayType)) dates.push(date)
  const selected = filterSteamPlayerCountObservations(observations, range, dayType).filter(item => Date.parse(item.observedAt) <= now.getTime())
  const byHour = new Map<string, SteamPlayerCountObservation[]>()
  for (const observation of selected) {
    const jst = new Date(Date.parse(observation.observedAt) + JST_OFFSET_MS), key = `${jst.toISOString().slice(0, 10)}:${jst.getUTCHours()}`
    const values = byHour.get(key) ?? []
    values.push(observation)
    byHour.set(key, values)
  }
  return Array.from({ length: 24 }, (_, hour) => {
    let observedSlots = 0, expectedSlots = 0
    const means: number[] = []
    for (const date of dates) {
      const values = byHour.get(`${date}:${hour}`) ?? []
      observedSlots += values.length
      for (let quarter = 0; quarter < 4; quarter++) {
        if (dateMilliseconds(date) - JST_OFFSET_MS + hour * 60 * 60 * 1000 + quarter * STEAM_PLAYER_COUNT_SLOT_MS <= now.getTime()) expectedSlots++
      }
      if (values.length === 4) means.push(values.reduce((sum, item) => sum + item.playerCount / 4, 0))
    }
    return { hour, mean: means.length ? means.reduce((sum, mean) => sum + mean / means.length, 0) : null,
      validDays: means.length, totalDays: dates.length, observedSlots, expectedSlots }
  })
}

/** JST date selections can begin in the preceding UTC file. */
export function getSteamPlayerCountUtcDates(range: SteamPlayerCountDateRange): string[] {
  const { from, to } = parseSteamPlayerCountDateRange(range), dates: string[] = []
  for (let date = shiftDate(from, -1); date <= to; date = shiftDate(date, 1)) dates.push(date)
  return dates
}
