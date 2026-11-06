import type { SteamPlayerCountAppId } from '../types/steamPlayerCount.ts'
import { parseSteamPlayerCountDate, STEAM_PLAYER_COUNT_SLOT_MS } from './steamPlayerCount.ts'
import { STEAM_PLAYER_COUNT_GAMES } from './steamPlayerCountGames.ts'

export const STEAM_COLLECTION_HISTORY_BASE_URL =
  'https://raw.githubusercontent.com/gonchiman/sf6/refs/heads/codex/steam-player-count-history/collection-history/'
export const STEAM_COLLECTION_HISTORY_GRACE_MS = 20 * 60_000
export const STEAM_COLLECTION_SCHEDULE_OFFSET_MS = 7 * 60_000
export const STEAM_COLLECTION_ERROR_CODES = ['runner', 'arguments', 'http', 'backoff', 'response', 'network', 'output'] as const

export type SteamCollectionHistoryDispatch = {
  runId: string
  attempt: number
  reason: 'failed' | 'skipped'
  httpStatus?: number
}
export type SteamCollectionHistoryGame = {
  appId: SteamPlayerCountAppId
  status: 'published' | 'collect-failed' | 'save-failed' | 'pending' | 'unknown'
  runId?: string
  attempt?: number
  observedAt?: string
  errorCode?: string
}
export type SteamCollectionHistorySlot = {
  scheduledAt: string
  dispatch?: SteamCollectionHistoryDispatch
  games: SteamCollectionHistoryGame[]
}
export type SteamCollectionHistoryDay = {
  schemaVersion: 1
  date: string
  checkedAt: string
  slots: SteamCollectionHistorySlot[]
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
}

export function isSteamCollectionScheduledAt(value: unknown): value is string {
  return isTimestamp(value) && Date.parse(value) % STEAM_PLAYER_COUNT_SLOT_MS === STEAM_COLLECTION_SCHEDULE_OFFSET_MS
}

export function steamCollectionScheduleForObservation(observedAt: number): number {
  return Math.floor(observedAt / STEAM_PLAYER_COUNT_SLOT_MS) * STEAM_PLAYER_COUNT_SLOT_MS + STEAM_COLLECTION_SCHEDULE_OFFSET_MS
}

function invalid(): never {
  throw new Error('Steam取得履歴の形式が正しくありません。')
}

function fields(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) invalid()
  return value as Record<string, unknown>
}

function isRun(runId: unknown, attempt: unknown): boolean {
  return typeof runId === 'string' && /^[1-9]\d{0,19}$/.test(runId)
    && typeof attempt === 'number' && Number.isSafeInteger(attempt) && attempt > 0
}

function parseDispatch(value: unknown): SteamCollectionHistoryDispatch {
  const input = fields(value, ['runId', 'attempt', 'reason', 'httpStatus'])
  if (!isRun(input.runId, input.attempt) || (input.reason !== 'failed' && input.reason !== 'skipped')
    || (input.httpStatus !== undefined && (input.reason !== 'failed' || typeof input.httpStatus !== 'number'
      || !Number.isInteger(input.httpStatus) || input.httpStatus < 100 || input.httpStatus > 599))) invalid()
  return input as SteamCollectionHistoryDispatch
}

function parseGame(value: unknown, scheduledAt: string): SteamCollectionHistoryGame {
  const input = fields(value, ['appId', 'status', 'runId', 'attempt', 'observedAt', 'errorCode'])
  if (!STEAM_PLAYER_COUNT_GAMES.some(game => game.appId === input.appId)
    || !['published', 'collect-failed', 'save-failed', 'pending', 'unknown'].some(status => status === input.status)
    || ((input.runId !== undefined || input.attempt !== undefined) && !isRun(input.runId, input.attempt))
    || (input.observedAt !== undefined && (!isTimestamp(input.observedAt) || input.observedAt < scheduledAt))
    || (input.status === 'published' && (!isRun(input.runId, input.attempt) || !isTimestamp(input.observedAt)
      || steamCollectionScheduleForObservation(Date.parse(input.observedAt)) !== Date.parse(scheduledAt)))
    || (input.errorCode !== undefined && (input.status !== 'collect-failed'
      || (input.errorCode !== 'job' && !STEAM_COLLECTION_ERROR_CODES.some(code => code === input.errorCode))))) invalid()
  return input as SteamCollectionHistoryGame
}

export function parseSteamCollectionHistoryDay(value: unknown, expectedDate: string): SteamCollectionHistoryDay {
  const input = fields(value, ['schemaVersion', 'date', 'checkedAt', 'slots'])
  const date = parseSteamPlayerCountDate(input.date)
  if (input.schemaVersion !== 1 || date !== expectedDate || !isTimestamp(input.checkedAt)
    || !Array.isArray(input.slots) || input.slots.length > 96) invalid()
  const checkedAt = input.checkedAt
  const slots: SteamCollectionHistorySlot[] = input.slots.map(value => {
    const slot = fields(value, ['scheduledAt', 'dispatch', 'games'])
    if (!isSteamCollectionScheduledAt(slot.scheduledAt) || slot.scheduledAt.slice(0, 10) !== date
      || slot.scheduledAt > checkedAt || !Array.isArray(slot.games) || slot.games.length > STEAM_PLAYER_COUNT_GAMES.length) invalid()
    const scheduledAt = slot.scheduledAt
    const games = slot.games.map(game => parseGame(game, scheduledAt))
    if (new Set(games.map(game => game.appId)).size !== games.length
      || games.some(game => game.observedAt && game.observedAt > checkedAt)) invalid()
    return { scheduledAt, games, ...(slot.dispatch === undefined ? {} : { dispatch: parseDispatch(slot.dispatch) }) }
  })
  if (slots.some((slot, index) => index > 0 && slots[index - 1].scheduledAt >= slot.scheduledAt)) invalid()
  return { schemaVersion: 1, date, checkedAt, slots }
}
