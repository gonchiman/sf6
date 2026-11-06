import type { SteamPlayerCountComparisonEntry } from './steamPlayerCountComparisonFeed.ts'
import { getSteamPlayerCountJstDate, STEAM_PLAYER_COUNT_SLOT_MS } from './steamPlayerCount.ts'
import {
  parseSteamCollectionHistoryDay, STEAM_COLLECTION_HISTORY_BASE_URL, STEAM_COLLECTION_HISTORY_GRACE_MS,
  STEAM_COLLECTION_SCHEDULE_OFFSET_MS, steamCollectionScheduleForObservation,
  type SteamCollectionHistoryDay, type SteamCollectionHistoryGame, type SteamCollectionHistorySlot,
} from './steamCollectionHistory.ts'
import type { SteamPlayerCountAppId, SteamPlayerCountDateRange, SteamPlayerCountDayType, SteamPlayerCountTimeWindow } from '../types/steamPlayerCount.ts'

const dayMs = 24 * 60 * 60_000
const firstCollectionDay = '2026-10-31'
const bundledDay = '2026-11-05'
const firstDiagnosticsDay = bundledDay
// The prior workflow did not run on the current 15-minute schedule.
const firstDispatcherSlot = Date.parse('2026-11-01T12:37:00+09:00')

export type SteamHistoryDayRead = {
  date: string
  live: SteamCollectionHistoryDay | null
  bundled: SteamCollectionHistoryDay | null
  failed: boolean
}

export type SteamHistoryRow = {
  scheduledAt: string
  result: '取得済み' | '一部取得' | '欠測' | '確認中'
  successCount: number
  reasons: readonly { appId?: SteamPlayerCountAppId; label: string }[]
  logs: readonly { kind: '起動役' | '取得'; runId: string; attempt: number }[]
}

type Bounds = { start: number; end: number }

export function steamHistoryBounds(range: SteamPlayerCountDateRange, window: SteamPlayerCountTimeWindow | null, now: Date): Bounds {
  return {
    start: Math.max(Date.parse(window?.from ?? `${range.from}T00:00:00+09:00`), Date.parse(`${firstCollectionDay}T00:00:00+09:00`)),
    end: Math.min(now.getTime(), window ? Date.parse(window.to) : Date.parse(`${range.to}T00:00:00+09:00`) + dayMs - 1),
  }
}

export function steamHistoryUtcDates({ start, end }: Bounds): string[] {
  if (start > end) return []
  const dates: string[] = []
  for (let day = Math.floor(start / dayMs) * dayMs; day <= end; day += dayMs) {
    dates.push(new Date(day).toISOString().slice(0, 10))
  }
  return dates
}

async function readDay(base: string, date: string, signal: AbortSignal): Promise<SteamCollectionHistoryDay | null> {
  const response = await fetch(`${base}days/${date}.json`, { signal, credentials: 'omit', cache: 'no-store' })
  if (response.status === 404) return null
  if (!response.ok) throw new Error('Steam取得履歴の読込失敗')
  return parseSteamCollectionHistoryDay(await response.json(), date)
}

export async function readSteamHistoryDays(dates: readonly string[], bundledBase: string, signal: AbortSignal,
  cache: Map<string, SteamHistoryDayRead>): Promise<SteamHistoryDayRead[]> {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(12_000)])
  const recentDay = new Date(Date.now() - dayMs).toISOString().slice(0, 10)
  const results = new Array<SteamHistoryDayRead>(dates.length)
  let next = 0
  async function worker() {
    while (next < dates.length) {
      const index = next++
      const date = dates[index]
      const cached = date < recentDay ? cache.get(date) : undefined
      if (cached) {
        results[index] = cached
        continue
      }
      const [live, bundled] = await Promise.allSettled([
        date >= firstDiagnosticsDay ? readDay(STEAM_COLLECTION_HISTORY_BASE_URL, date, deadline) : Promise.resolve(null),
        date === bundledDay ? readDay(bundledBase, date, deadline) : Promise.resolve(null),
      ])
      results[index] = {
        date,
        live: live.status === 'fulfilled' ? live.value : null,
        bundled: bundled.status === 'fulfilled' ? bundled.value : null,
        failed: live.status === 'rejected' || bundled.status === 'rejected',
      }
      if (date < recentDay && !results[index].failed) cache.set(date, results[index])
    }
  }
  await Promise.all(Array.from({ length: Math.min(6, dates.length) }, worker))
  return results
}

type HistorySlotRead = {
  live?: SteamCollectionHistorySlot
  bundled?: SteamCollectionHistorySlot
  checkedAt: number
  failed: boolean
}
type GameObservations = {
  started: number
  checked: number
  bySlot: Map<number, { runId: string; attempt: number }>
}

const errorLabels: Readonly<Record<string, string>> = {
  runner: 'ランナー', arguments: '引数', http: 'HTTP', backoff: '再試行', response: '応答形式',
  network: '通信', output: '出力',
}

function failureReason(game: SteamCollectionHistoryGame): string {
  if (game.status === 'collect-failed') {
    if (game.errorCode === 'job') return '取得ジョブ失敗（内訳不明）'
    return game.errorCode && errorLabels[game.errorCode] ? `取得失敗（${errorLabels[game.errorCode]}）` : '取得失敗'
  }
  return game.status === 'save-failed' ? '保存失敗' : '予定枠外に取得'
}

function gameResult(
  record: SteamCollectionHistoryGame | undefined, observed: GameObservations | undefined, slot: HistorySlotRead,
  dispatch: SteamCollectionHistorySlot['dispatch'], scheduled: number, now: number,
): { state: 'published' | 'missing' | 'pending' | 'untracked'; reason?: string; runId?: string; attempt?: number } {
  if (record?.status === 'published') return { state: 'published', runId: record.runId, attempt: record.attempt }
  const observation = observed?.bySlot.get(scheduled)
  if (observation && !dispatch && (!record?.runId || record.runId === observation.runId)) return { state: 'published', ...observation }
  const observedOutsideSlot = record?.status === 'unknown' && record.observedAt
    && steamCollectionScheduleForObservation(Date.parse(record.observedAt)) !== scheduled
  if (record?.status === 'collect-failed' || record?.status === 'save-failed' || observedOutsideSlot) {
    return { state: 'missing', reason: failureReason(record), runId: record.runId, attempt: record.attempt }
  }
  if (record?.status === 'pending') return { state: 'pending', runId: record.runId, attempt: record.attempt }
  const slotGraceEnd = scheduled + STEAM_COLLECTION_HISTORY_GRACE_MS
  if (dispatch) {
    return now >= slotGraceEnd && slot.checkedAt >= slotGraceEnd ? { state: 'missing' } : { state: 'pending' }
  }
  if (!record && (!observed || scheduled < observed.started)) return { state: 'untracked' }
  const checked = Math.max(slot.checkedAt, observed?.checked ?? 0)
  if (now < slotGraceEnd || checked < slotGraceEnd || (slot.failed && !record)) return { state: 'pending' }
  return { state: 'missing', reason: '原因不明', runId: record?.runId, attempt: record?.attempt }
}

function slotRead(day: SteamHistoryDayRead | undefined, scheduledAt: string): HistorySlotRead {
  const live = day?.live?.slots.find(slot => slot.scheduledAt === scheduledAt)
  const bundled = day?.bundled?.slots.find(slot => slot.scheduledAt === scheduledAt)
  return {
    live, bundled,
    checkedAt: Math.max(day?.live ? Date.parse(day.live.checkedAt) : 0, bundled && day?.bundled ? Date.parse(day.bundled.checkedAt) : 0),
    failed: day?.failed ?? false,
  }
}

function gameObservations(days: readonly SteamHistoryDayRead[], entries: readonly SteamPlayerCountComparisonEntry[]): Map<SteamPlayerCountAppId, GameObservations> {
  const knownRuns = new Map<string, number>()
  for (const day of days) for (const source of [day.live, day.bundled]) {
    for (const slot of source?.slots ?? []) for (const game of slot.games) {
      if (game.runId) knownRuns.set(`${game.appId}:${game.runId}`, Date.parse(slot.scheduledAt))
    }
  }
  return new Map(entries.map(entry => {
    const { manifest, source } = entry.publication
    const bySlot = new Map<number, { runId: string; attempt: number }>()
    for (const observation of entry.observations) {
      const time = Date.parse(observation.observedAt)
      const slot = steamCollectionScheduleForObservation(time)
      const assignedSlot = knownRuns.get(`${entry.game.appId}:${observation.runId}`)
      if (!observation.runId || !observation.runAttempt || (assignedSlot === undefined ? observation.runAttempt !== 1 : assignedSlot !== slot)
        || time < slot || (assignedSlot === undefined && bySlot.has(slot))) continue
      bySlot.set(slot, { runId: observation.runId, attempt: observation.runAttempt })
    }
    const first = Math.min(...manifest.days
      .map(day => Date.parse(day.firstObservedAt))
      .filter(time => time >= firstDispatcherSlot))
    return [entry.game.appId, {
      started: source === 'history' && Number.isFinite(first) ? steamCollectionScheduleForObservation(first) : Infinity,
      checked: source === 'history' ? Date.parse(manifest.generatedAt) : 0,
      bySlot,
    }]
  }))
}

export function buildSteamHistoryRows(
  bounds: Bounds, now: Date, dayType: SteamPlayerCountDayType, appIds: readonly SteamPlayerCountAppId[],
  days: readonly SteamHistoryDayRead[], entries: readonly SteamPlayerCountComparisonEntry[],
): SteamHistoryRow[] {
  const dayByDate = new Map(days.map(day => [day.date, day]))
  const observed = gameObservations(days, entries)
  const rows: SteamHistoryRow[] = []
  const latest = Math.floor((bounds.end - STEAM_COLLECTION_SCHEDULE_OFFSET_MS) / STEAM_PLAYER_COUNT_SLOT_MS)
    * STEAM_PLAYER_COUNT_SLOT_MS + STEAM_COLLECTION_SCHEDULE_OFFSET_MS
  for (let scheduled = latest; scheduled >= bounds.start; scheduled -= STEAM_PLAYER_COUNT_SLOT_MS) {
    const scheduledAt = new Date(scheduled).toISOString()
    if (dayType !== 'all') {
      const weekday = new Date(getSteamPlayerCountJstDate(scheduledAt)).getUTCDay()
      const weekend = weekday === 0 || weekday === 6
      if ((dayType === 'weekend') !== weekend) continue
    }
    const slot = slotRead(dayByDate.get(scheduledAt.slice(0, 10)), scheduledAt)
    const dispatch = slot.live?.dispatch ?? slot.bundled?.dispatch
    const games = appIds.map(appId => ({
      appId,
      ...gameResult(slot.live?.games.find(game => game.appId === appId) ?? slot.bundled?.games.find(game => game.appId === appId),
        observed.get(appId), slot, dispatch, scheduled, now.getTime()),
    }))
    if (games.every(game => game.state === 'untracked')) continue
    const successCount = games.filter(game => game.state === 'published').length
    const waiting = games.some(game => game.state === 'pending' || game.state === 'untracked')
    const result = successCount === appIds.length ? '取得済み' : waiting ? '確認中' : successCount > 0 ? '一部取得' : '欠測'
    const reasons: SteamHistoryRow['reasons'][number][] = games.flatMap(({ appId, reason }) => reason ? [{ appId, label: reason }] : [])
    const logs: SteamHistoryRow['logs'][number][] = []
    if (dispatch) {
      if (games.some(game => game.state === 'missing')) {
        reasons.unshift({ label: dispatch.reason === 'skipped' ? '起動見送り'
          : dispatch.httpStatus ? `起動失敗（HTTP ${dispatch.httpStatus}）` : '起動失敗' })
      }
      logs.push({ kind: '起動役', runId: dispatch.runId, attempt: dispatch.attempt })
    }
    for (const { runId, attempt } of games) {
      if (runId && attempt && !logs.some(log => log.kind === '取得' && log.runId === runId && log.attempt === attempt)) {
        logs.push({ kind: '取得', runId, attempt })
      }
    }
    rows.push({ scheduledAt, result, successCount, reasons, logs })
  }
  return rows
}
