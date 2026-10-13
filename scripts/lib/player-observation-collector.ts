import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { PlayerObservationConditions, PlayerObservationRun } from '../../src/types/playerObservations.ts'
import { PLAYER_OBSERVATION_CONDITIONS } from '../../src/lib/playerObservations.ts'
import { PlayerObservationStore } from './player-observation-store.ts'

export const PLAYER_OBSERVATION_INPUT_VERSION = 1
export const PLAYER_OBSERVATION_SERIES_ID = 'buckler-max-lp-v1'
export const PLAYER_OBSERVATION_SOURCE_URL = 'https://www.streetfighter.com/6/buckler/ja-jp/ranking/league'

export interface PlayerObservationPageCapture {
  page: number
  capturedAt: string
  url: string
  conditions: PlayerObservationConditions
  range: { from: number; to: number; total: number }
  rows: { cfnId: string; lp: number; rank: number }[]
}

export interface PlayerObservationInput {
  schemaVersion: 1
  definitionVersion: 1
  seriesId: 'buckler-max-lp-v1'
  run: { id: string; scope: 'probe' | 'population'; scheduledAt: string; startedAt: string; endedAt: string }
  captures: PlayerObservationPageCapture[]
  failures: { page: number; reason: string }[]
}

function record(value: unknown, label: string, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}の形式が不正です。`)
  if (Object.keys(value).some((key) => !keys.includes(key))) throw new Error(`${label}に未定義の項目があります。`)
  return value as Record<string, unknown>
}

function integer(value: unknown, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) throw new Error(`${label}は整数で指定してください。`)
  return value as number
}

function utc(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().replace('.000Z', 'Z') !== value.replace('.000Z', 'Z')) {
    throw new Error(`${label}は実在するISO UTC日時で指定してください。`)
  }
  return new Date(value).toISOString()
}

export function parsePlayerObservationConditions(value: unknown): PlayerObservationConditions {
  const conditions = record(value, '取得条件', Object.keys(PLAYER_OBSERVATION_CONDITIONS))
  if (Object.entries(PLAYER_OBSERVATION_CONDITIONS).some(([key, expected]) => conditions[key] !== expected)) {
    throw new Error('取得条件は総合・最大LP・全地域・全プラットフォーム・全ユーザーに揃えてください。')
  }
  return { ...PLAYER_OBSERVATION_CONDITIONS }
}

/** Only documented normal-page records are accepted. HTTP success alone is not evidence. */
export function parsePlayerObservationPageCapture(value: unknown): PlayerObservationPageCapture {
  const page = record(value, '取得ページ', ['page', 'capturedAt', 'url', 'conditions', 'range', 'rows'])
  const pageNumber = integer(page.page, 'ページ番号', 1)
  const capturedAt = utc(page.capturedAt, '取得日時')
  const conditions = parsePlayerObservationConditions(page.conditions)
  if (typeof page.url !== 'string') throw new Error('取得ページのURLが不正です。')
  let url: URL
  try { url = new URL(page.url) } catch { throw new Error('取得ページのURLが不正です。') }
  if (url.origin + url.pathname !== PLAYER_OBSERVATION_SOURCE_URL || url.username || url.password || url.hash) {
    throw new Error('取得ページはBucklerの通常のLPランキングにしてください。')
  }
  const allowedQueries = new Set(['character_filter', 'character_id', 'platform', 'user_status', 'home_filter', 'home_category_id', 'home_id', 'league_rank', 'page'])
  if ([...url.searchParams.keys()].some((key) => !allowedQueries.has(key) || url.searchParams.getAll(key).length !== 1)) {
    throw new Error('取得ページのURLに未確認または重複した条件があります。')
  }
  const expectedQuery: Record<string, string> = { character_filter: '2', platform: '1', user_status: '1', home_category_id: '0', home_id: '0', league_rank: '0', page: String(pageNumber) }
  if (Object.entries(expectedQuery).some(([key, expected]) => url.searchParams.get(key) !== expected)) {
    throw new Error('URLの取得条件・ページ番号と画面記録が一致しません。')
  }
  if (url.searchParams.has('home_filter') && url.searchParams.get('home_filter') !== '1') throw new Error('ホームの取得条件が一致しません。')
  const range = record(page.range, '表示範囲', ['from', 'to', 'total'])
  const from = integer(range.from, '表示開始位置', 1)
  const to = integer(range.to, '表示終了位置', 1)
  const total = integer(range.total, '表示総件数', 1)
  if (!Array.isArray(page.rows) || page.rows.length === 0 || page.rows.length > 20
    || from !== (pageNumber - 1) * 20 + 1 || to !== from + page.rows.length - 1 || to > total
    || page.rows.length !== Math.min(20, total - from + 1)) {
    throw new Error('表示範囲・ページ番号・実際の行数が一致しません。')
  }
  const seen = new Set<string>()
  const rows = page.rows.map((value) => {
    const row = record(value, 'ランキング行', ['cfnId', 'lp', 'rank'])
    if (typeof row.cfnId !== 'string' || !/^[1-9]\d*$/.test(row.cfnId) || row.cfnId.length > 32) {
      throw new Error('CFN IDは数値文字列で保存してください。')
    }
    if (seen.has(row.cfnId)) throw new Error('同一ページ内に重複したCFN IDがあります。')
    seen.add(row.cfnId)
    return { cfnId: row.cfnId, lp: integer(row.lp, 'LP'), rank: integer(row.rank, '表示順位', 1) }
  })
  return { page: pageNumber, capturedAt, url: url.href, conditions, range: { from, to, total }, rows }
}

export function parsePlayerObservationInput(value: unknown): PlayerObservationInput {
  const input = record(value, '観測入力', ['schemaVersion', 'definitionVersion', 'seriesId', 'run', 'captures', 'failures'])
  if (input.schemaVersion !== 1 || input.definitionVersion !== 1 || input.seriesId !== PLAYER_OBSERVATION_SERIES_ID) {
    throw new Error('観測入力の形式・定義・系列が未対応です。')
  }
  const run = record(input.run, '走査情報', ['id', 'scope', 'scheduledAt', 'startedAt', 'endedAt'])
  if (typeof run.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,95}$/.test(run.id)) throw new Error('走査IDの形式が不正です。')
  if (run.scope !== 'probe' && run.scope !== 'population') throw new Error('走査範囲を指定してください。')
  const scheduledAt = utc(run.scheduledAt, '予定日時')
  const startedAt = utc(run.startedAt, '走査開始日時')
  const endedAt = utc(run.endedAt, '走査終了日時')
  if (scheduledAt > startedAt || startedAt > endedAt) throw new Error('走査日時の順序が不正です。')
  if (!Array.isArray(input.captures) || !Array.isArray(input.failures)) throw new Error('取得ページと失敗ページの一覧が必要です。')
  const pages = new Set<number>()
  const captures = input.captures.map((capture) => {
    const parsed = parsePlayerObservationPageCapture(capture)
    if (parsed.capturedAt < startedAt || parsed.capturedAt > endedAt) throw new Error('取得日時が走査区間外です。')
    if (pages.has(parsed.page)) throw new Error('同一走査の同ページ記録は一つに揃えてください。')
    pages.add(parsed.page)
    return parsed
  }).sort((a, b) => a.capturedAt.localeCompare(b.capturedAt) || a.page - b.page)
  const failedPages = new Set<number>()
  const failures = input.failures.map((failure) => {
    const parsed = record(failure, '失敗ページ', ['page', 'reason'])
    const page = integer(parsed.page, '失敗ページ番号', 1)
    if (failedPages.has(page) || pages.has(page)) throw new Error('成功ページと失敗ページが重複しています。')
    if (typeof parsed.reason !== 'string' || !parsed.reason.trim()) throw new Error('失敗理由が必要です。')
    failedPages.add(page)
    // Raw adapter errors, headers, and URLs are never propagated into publication.
    return { page, reason: 'ページ記録を取得できませんでした。' }
  })
  if (captures.length === 0 && failures.length === 0) throw new Error('取得記録がありません。欠測は収集器でなく履歴に明示してください。')
  return { schemaVersion: 1, definitionVersion: 1, seriesId: PLAYER_OBSERVATION_SERIES_ID,
    run: { id: run.id, scope: run.scope, scheduledAt, startedAt, endedAt }, captures, failures }
}

export function playerObservationCaptureFingerprint(capture: PlayerObservationPageCapture): string {
  return createHash('sha256').update(JSON.stringify(capture)).digest('hex')
}

/** Inbox-file adapter. It performs no HTTP, browser, authentication, or scheduling work. */
export async function collectPlayerObservationInput(inputPath: string, databasePath: string): Promise<PlayerObservationRun> {
  const input = parsePlayerObservationInput(JSON.parse(await readFile(inputPath, 'utf8')))
  if (Date.parse(input.run.endedAt) > Date.now()) throw new Error('未来の取得記録は取り込めません。実際の走査日時を確認してください。')
  const store = new PlayerObservationStore(databasePath)
  try {
    store.beginRun(input.run)
    for (const capture of input.captures) store.recordPage(input.run.id, capture, playerObservationCaptureFingerprint(capture))
    for (const failure of input.failures) store.recordFailure(input.run.id, failure.page)
    return store.finishRun(input.run.id, input.run.endedAt)
  } finally { store.close() }
}

/** Mark an actually missed observation without fabricating a successful zero-count run. */
export function markPlayerObservationMissingRun(runId: string, scheduledAtValue: string, databasePath: string): PlayerObservationRun {
  if (typeof runId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,95}$/.test(runId)) throw new Error('走査IDの形式が不正です。')
  const scheduledAt = utc(scheduledAtValue, '予定日時')
  if (Date.parse(scheduledAt) > Date.now()) throw new Error('未来の予定は欠測として記録できません。予定日時を確認してください。')
  const store = new PlayerObservationStore(databasePath)
  try { return store.recordMissingRun(runId, scheduledAt) } finally { store.close() }
}
