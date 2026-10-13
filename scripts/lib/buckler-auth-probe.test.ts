import assert from 'node:assert/strict'
import test from 'node:test'
import {
  BUCKLER_AUTH_PROBE_URL, BucklerAuthProbeReadError, classifyBucklerAuthProbeObservation,
  runBucklerAuthProbe,
} from './buckler-auth-probe.ts'
import type { BucklerAuthProbeObservation, BucklerAuthProbePhase } from './buckler-auth-probe.ts'

function observation(changes: Partial<BucklerAuthProbeObservation> = {}): BucklerAuthProbeObservation {
  return {
    maintenance: false, loginRequired: false, signedIn: true, rankingRows: 20,
    visibleCounters: { from: 1, to: 20, total: 3055169 }, controlMatches: true, pageConfirmed: true,
    ...changes,
  }
}

const now = () => new Date('2026-10-13T06:00:00Z')

test('keeps readable anonymous and unconfirmed pages distinct from proven signed-in UI', () => {
  assert.equal(classifyBucklerAuthProbeObservation(observation()).status, 'signed-in-readable')
  const anonymous = classifyBucklerAuthProbeObservation(observation({ signedIn: false }))
  assert.equal(anonymous.status, 'anonymous-readable')
  assert.equal(anonymous.signedIn, false)
  assert.equal(anonymous.totalCount, 3055169)
  const unconfirmed = classifyBucklerAuthProbeObservation(observation({ signedIn: null }))
  assert.equal(unconfirmed.status, 'auth-unconfirmed-readable')
  assert.equal(unconfirmed.signedIn, null)
  assert.equal(unconfirmed.totalCount, 3055169)
})

test('maintenance and login requirements override cached signed-in UI and stale ranking rows', () => {
  const maintenance = classifyBucklerAuthProbeObservation(observation({ maintenance: true }))
  assert.equal(maintenance.status, 'maintenance')
  assert.equal(maintenance.totalCount, null)
  assert.equal(maintenance.signedIn, null)
  const required = classifyBucklerAuthProbeObservation(observation({ loginRequired: true }))
  assert.equal(required.status, 'login-required')
  assert.equal(required.signedIn, null)
  assert.equal(required.rankingRows, null)
})

test('rejects mismatched or unknown page and control confirmations', () => {
  for (const changes of [{ pageConfirmed: false }, { controlMatches: false }] as const) {
    assert.equal(classifyBucklerAuthProbeObservation(observation(changes)).status, 'condition-mismatch')
  }
  for (const changes of [{ pageConfirmed: null }, { controlMatches: null }] as const) {
    assert.equal(classifyBucklerAuthProbeObservation(observation(changes)).status, 'unsupported-dom')
  }
  assert.equal(classifyBucklerAuthProbeObservation({ ...observation(), signedIn: undefined }).status, 'unsupported-dom')
})

test('checks first-page visible ranges and row counts without turning missing DOM into zero', () => {
  for (const value of [
    null, {}, observation({ rankingRows: null }), observation({ rankingRows: 0 }), observation({ rankingRows: 21 }),
    observation({ rankingRows: 19 }), observation({ visibleCounters: null }),
    observation({ visibleCounters: { from: 21, to: 40, total: 3055169 } }),
    observation({ visibleCounters: { from: 1, to: 20, total: 19 } }),
    observation({ visibleCounters: { from: 1, to: 20, total: Number.MAX_SAFE_INTEGER + 1 } }),
    observation({ visibleCounters: { from: 1, to: 19, total: 3055169 } }),
  ]) {
    const result = classifyBucklerAuthProbeObservation(value)
    assert.equal(result.status, 'unsupported-dom')
    assert.equal(result.totalCount, null)
  }
  assert.equal(classifyBucklerAuthProbeObservation(observation({ rankingRows: 7, visibleCounters: { from: 1, to: 7, total: 7 } })).status, 'signed-in-readable')
})

test('probes exactly two fixed first-page reads and limits the success claim to same-run reuse', async () => {
  const phases: BucklerAuthProbePhase[] = []
  const result = await runBucklerAuthProbe({ now, readPage: async (phase, url) => {
    phases.push(phase)
    assert.equal(url, BUCKLER_AUTH_PROBE_URL)
    const target = new URL(url)
    assert.equal(target.origin, 'https://www.streetfighter.com')
    assert.equal(target.searchParams.get('page'), '1')
    assert.equal(target.searchParams.get('league_rank'), '0')
    assert.equal(target.searchParams.get('character_filter'), '2')
    return observation()
  } })
  assert.deepEqual(phases, ['initial', 'reuse'])
  assert.equal(result.sameSessionReuse, 'confirmed')
  assert.equal(result.totalsMatch, true)
  assert.equal(result.separateLaunchReuse, 'not-tested')
  assert.equal(result.automaticLogin, 'not-tested')
  assert.equal(result.cloudAuthentication, 'not-tested')
  assert.equal(result.sessionLifetime, 'not-tested')
})

test('does not test authenticated reuse after anonymous, unconfirmed, maintenance, login, or unsupported initial reads', async () => {
  for (const value of [
    observation({ signedIn: false }), observation({ signedIn: null }), observation({ maintenance: true }),
    observation({ loginRequired: true }), observation({ rankingRows: null }), observation({ pageConfirmed: false }),
  ]) {
    let calls = 0
    const result = await runBucklerAuthProbe({ now, readPage: async () => { calls += 1; return value } })
    assert.equal(calls, 1)
    assert.equal(result.reuse, null)
    assert.equal(result.sameSessionReuse, 'not-tested')
    assert.equal(result.totalsMatch, null)
  }
})

test('records reuse login expiry, unknown auth, or anonymous access as unconfirmed, keeping the original successful observation', async () => {
  for (const value of [observation({ loginRequired: true }), observation({ signedIn: null }), observation({ signedIn: false }), observation({ maintenance: true })]) {
    const result = await runBucklerAuthProbe({ now, readPage: async (phase) => phase === 'initial' ? observation() : value })
    assert.equal(result.initial.status, 'signed-in-readable')
    assert.equal(result.sameSessionReuse, 'not-confirmed')
    assert.equal(result.status, result.reuse!.status)
  }
})

test('observes live counter changes separately from successful authentication reuse', async () => {
  const result = await runBucklerAuthProbe({ now, readPage: async (phase) => observation({
    visibleCounters: { from: 1, to: 20, total: phase === 'initial' ? 3055169 : 3055170 },
  }) })
  assert.equal(result.sameSessionReuse, 'confirmed')
  assert.equal(result.totalsMatch, false)
})

test('preserves timeout/failure states and never writes raw error messages, URLs, or private DOM properties', async () => {
  const secret = 'private-cookie-secret-token-and-player-name'
  const alteredError = new BucklerAuthProbeReadError('read-failed')
  Object.defineProperty(alteredError, 'status', { value: secret })
  for (const error of [new BucklerAuthProbeReadError('timeout'), new Error(secret), alteredError]) {
    const result = await runBucklerAuthProbe({ now, readPage: async () => { throw error } })
    assert.equal(result.status, error instanceof BucklerAuthProbeReadError && error.status === 'timeout' ? 'timeout' : 'read-failed')
    assert.equal(result.sameSessionReuse, 'not-tested')
    assert.ok(!JSON.stringify(result).includes(secret))
  }
  const result = await runBucklerAuthProbe({ now, readPage: async () => ({
    ...observation(), cookies: secret, sourceUrl: `https://example.com/?token=${secret}`, playerName: secret,
  }) })
  assert.ok(!JSON.stringify(result).includes(secret))
  assert.ok(!JSON.stringify(result).includes('example.com'))
  assert.ok(!JSON.stringify(result).includes('playerName'))
})

test('rejects invalid or reversed probe dates without retaining formatter strings', async () => {
  await assert.rejects(runBucklerAuthProbe({ now: () => new Date('invalid'), readPage: async () => observation() }), /検証日時/)
  let tick = 0
  await assert.rejects(runBucklerAuthProbe({ now: () => new Date(tick++ === 0 ? '2026-10-13T06:00:01Z' : '2026-10-13T06:00:00Z'), readPage: async () => observation() }), /順序/)
  const date = now()
  date.toISOString = () => 'private-formatter-output'
  const result = await runBucklerAuthProbe({ now: () => date, readPage: async () => observation() })
  assert.equal(result.startedAt, '2026-10-13T06:00:00.000Z')
})
