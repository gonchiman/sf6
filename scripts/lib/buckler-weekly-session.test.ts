import assert from 'node:assert/strict'
import test from 'node:test'
import {
  BUCKLER_WEEKLY_SESSION_SECRET, BUCKLER_WEEKLY_SESSION_SIZE_LIMIT,
  BucklerWeeklySessionError, createBucklerWeeklySession, parseBucklerWeeklySession,
} from './buckler-weekly-session.ts'

const PRIVATE = 'synthetic-private-weekly-cookie'
const capturedAt = '2026-10-15T05:29:00.000Z'
const uploadedAt = '2026-10-16T01:00:00.000Z'
const now = new Date(uploadedAt)
function state(value = PRIVATE) {
  return { cookies: [{ name: 'session', value, domain: '.streetfighter.com', path: '/', expires: -1,
    httpOnly: true, secure: true, sameSite: 'Lax' }], origins: [] }
}
function envelope(storageState: unknown = state()) { return { schemaVersion: 1, capturedAt, uploadedAt, storageState } }
function safe(code: string) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof BucklerWeeklySessionError)
    assert.equal(error.code, code)
    assert.equal(error.cause, undefined)
    assert.ok(!error.message.includes(PRIVATE))
    return true
  }
}

test('weekly Secret has a fixed name and a fresh validated object preserves capture and upload times', () => {
  assert.equal(BUCKLER_WEEKLY_SESSION_SECRET, 'BUCKLER_WEEKLY_SESSION')
  const originalState = state()
  const input = envelope(originalState)
  const parsed = parseBucklerWeeklySession(JSON.stringify(input), now)
  assert.deepEqual(parsed, input)
  const created = createBucklerWeeklySession({ capturedAt, uploadedAt, storageState: state() }, now)
  assert.deepEqual(created, input)
  parsed.storageState.cookies[0].value = 'changed-private-value'
  assert.equal(originalState.cookies[0].value, PRIVATE)
  assert.equal(created.storageState.cookies[0].value, PRIVATE)
})

test('requires a strict versioned envelope and rejects raw states, missing keys and hidden metadata', () => {
  for (const value of ['', PRIVATE, '[]', 'null', JSON.stringify(state()), JSON.stringify({ ...envelope(), schemaVersion: 2 }),
    JSON.stringify({ ...envelope(), private: PRIVATE }), JSON.stringify({ ...envelope(), stateIdentity: PRIVATE }),
    JSON.stringify({ capturedAt, uploadedAt, storageState: state() })]) {
    assert.throws(() => parseBucklerWeeklySession(value, now), safe('invalid-envelope'))
  }
  assert.throws(() => createBucklerWeeklySession({ capturedAt, uploadedAt, storageState: state(), private: PRIVATE } as never, now), safe('invalid-envelope'))
  assert.throws(() => parseBucklerWeeklySession(null as never, now), safe('invalid-envelope'))
})

test('timestamps are canonical UTC calendar dates ordered capture then upload then now', () => {
  for (const value of ['2026-02-30T01:00:00.000Z', '2026-10-16T24:00:00.000Z', '2026-10-16T01:00:00Z',
    '2026-10-16T10:00:00.000+09:00', PRIVATE]) {
    for (const key of ['capturedAt', 'uploadedAt']) {
      assert.throws(() => parseBucklerWeeklySession(JSON.stringify({ ...envelope(), [key]: value }), now), safe('invalid-time'))
    }
  }
  assert.throws(() => parseBucklerWeeklySession(JSON.stringify({ ...envelope(), capturedAt: '2026-10-16T01:00:00.001Z' }), now), safe('invalid-time'))
  assert.throws(() => parseBucklerWeeklySession(JSON.stringify({ ...envelope(), uploadedAt: '2026-10-16T01:00:00.001Z' }), now), safe('invalid-time'))
  assert.throws(() => parseBucklerWeeklySession(JSON.stringify(envelope()), new Date(NaN)), safe('invalid-time'))
  assert.throws(() => parseBucklerWeeklySession(JSON.stringify(envelope()), uploadedAt as never), safe('invalid-time'))
  assert.deepEqual(parseBucklerWeeklySession(JSON.stringify({ ...envelope(), capturedAt: uploadedAt }), now), { ...envelope(), capturedAt: uploadedAt })
})

test('inner storage state retains the existing Street Fighter allowlist without accepting identity-provider data', () => {
  for (const storageState of [null, PRIVATE, {}, { ...state(), private: PRIVATE },
    { cookies: [{ ...state().cookies[0], domain: '.capcom.com' }], origins: [] },
    { cookies: state().cookies, origins: [{ origin: 'https://auth.cid.capcom.com', localStorage: [] }] }]) {
    assert.throws(() => parseBucklerWeeklySession(JSON.stringify(envelope(storageState)), now), safe('invalid-state'))
  }
})

test('48KiB applies to the entire UTF-8 envelope, with the exact limit refused', () => {
  const base = Buffer.byteLength(JSON.stringify(envelope(state(''))), 'utf8')
  const atLimit = JSON.stringify(envelope(state('a'.repeat(BUCKLER_WEEKLY_SESSION_SIZE_LIMIT - base))))
  assert.equal(Buffer.byteLength(atLimit), BUCKLER_WEEKLY_SESSION_SIZE_LIMIT)
  assert.throws(() => parseBucklerWeeklySession(atLimit, now), safe('size-limit'))
  const below = JSON.stringify(envelope(state('a'.repeat(BUCKLER_WEEKLY_SESSION_SIZE_LIMIT - base - 1))))
  assert.equal(Buffer.byteLength(below), BUCKLER_WEEKLY_SESSION_SIZE_LIMIT - 1)
  assert.ok(parseBucklerWeeklySession(below, now).storageState.cookies.length === 1)
  const multibyte = JSON.stringify(envelope(state('あ'.repeat(Math.ceil(BUCKLER_WEEKLY_SESSION_SIZE_LIMIT / 3)))))
  assert.throws(() => parseBucklerWeeklySession(multibyte, now), safe('size-limit'))
  assert.throws(() => createBucklerWeeklySession({ capturedAt, uploadedAt, storageState: state('a'.repeat(BUCKLER_WEEKLY_SESSION_SIZE_LIMIT)) }, now), safe('size-limit'))
})
