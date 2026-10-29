import type { BrowserContextOptions } from 'playwright'
import { validateBucklerSessionState } from './buckler-session-store.ts'

export const BUCKLER_WEEKLY_SESSION_SECRET = 'BUCKLER_WEEKLY_SESSION'
export const BUCKLER_WEEKLY_SESSION_SIZE_LIMIT = 48 * 1024
export type BucklerWeeklyStorageState = Exclude<NonNullable<BrowserContextOptions['storageState']>, string>

/** Private Secret payload. Only the two timestamps may be copied into public reports. */
export interface BucklerWeeklySession {
  schemaVersion: 1
  capturedAt: string
  uploadedAt: string
  storageState: BucklerWeeklyStorageState
}
export type BucklerWeeklySessionErrorCode = 'invalid-envelope' | 'size-limit' | 'invalid-time' | 'invalid-state'
const messages: Record<BucklerWeeklySessionErrorCode, string> = {
  'invalid-envelope': '週次用の保存状態の形式を確認できません。',
  'size-limit': '週次用の保存状態全体は48KiB未満で指定してください。',
  'invalid-time': '週次用の保存日時の形式・順序を確認できません。',
  'invalid-state': '週次用の認証状態の形式・対象サイトを確認できません。',
}
/** Fixed errors never include the supplied Secret, browser state or its hash. */
export class BucklerWeeklySessionError extends Error {
  readonly code: BucklerWeeklySessionErrorCode
  constructor(code: BucklerWeeklySessionErrorCode) {
    super(messages[code])
    this.name = 'BucklerWeeklySessionError'
    this.code = code
  }
}
function fail(code: BucklerWeeklySessionErrorCode): never { throw new BucklerWeeklySessionError(code) }
function date(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail('invalid-time')
  return value
}

/** No filesystem, browser or network access; raw state is validated by the existing site allowlist. */
export function parseBucklerWeeklySession(value: string, now: Date = new Date()): BucklerWeeklySession {
  if (typeof value !== 'string' || !value) fail('invalid-envelope')
  if (Buffer.byteLength(value, 'utf8') >= BUCKLER_WEEKLY_SESSION_SIZE_LIMIT) fail('size-limit')
  let input: unknown
  try { input = JSON.parse(value) } catch { return fail('invalid-envelope') }
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('invalid-envelope')
  const envelope = input as Record<string, unknown>
  if (Object.keys(envelope).length !== 4
    || Object.keys(envelope).some(key => !['schemaVersion', 'capturedAt', 'uploadedAt', 'storageState'].includes(key))
    || envelope.schemaVersion !== 1) fail('invalid-envelope')
  const capturedAt = date(envelope.capturedAt)
  const uploadedAt = date(envelope.uploadedAt)
  let current: number
  try { current = Date.prototype.getTime.call(now) } catch { return fail('invalid-time') }
  if (!Number.isFinite(current) || Date.parse(capturedAt) > Date.parse(uploadedAt) || Date.parse(uploadedAt) > current) fail('invalid-time')
  let storageState: BucklerWeeklyStorageState
  try { storageState = JSON.parse(validateBucklerSessionState(JSON.stringify(envelope.storageState))) as BucklerWeeklyStorageState }
  catch { return fail('invalid-state') }
  return { schemaVersion: 1, capturedAt, uploadedAt, storageState }
}

export function createBucklerWeeklySession(input: {
  capturedAt: string; uploadedAt: string; storageState: unknown
}, now: Date = new Date()): BucklerWeeklySession {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 3
      || Object.keys(input).some(key => !['capturedAt', 'uploadedAt', 'storageState'].includes(key))) fail('invalid-envelope')
    return parseBucklerWeeklySession(JSON.stringify({ schemaVersion: 1, ...input }), now)
  } catch (error) {
    if (error instanceof BucklerWeeklySessionError) throw error
    return fail('invalid-envelope')
  }
}
