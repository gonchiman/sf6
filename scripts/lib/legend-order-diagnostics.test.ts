import assert from 'node:assert/strict'
import test from 'node:test'
import { sanitizeLegendOrderDiagnostic, sanitizeLegendOrderRecheck, sanitizeLegendPageRecoveryDecision } from './legend-order-diagnostics.ts'
import type { LegendOrderDiagnostic, LegendOrderRecheck, LegendPageRecoveryDecision } from './legend-order-diagnostics.ts'

const diagnostic: LegendOrderDiagnostic = { boundary: 'within-page',
  previous: { page: 1, rowIndex: 1, rank: 1, masterRating: 2400 }, current: { page: 1, rowIndex: 2, rank: 2, masterRating: 2401 },
  sameEntry: false, duplicateInAccepted: false, duplicateWithinCurrentPage: false }
const observed: LegendOrderRecheck = { status: 'observed', elapsedMs: 1000, page: 1, from: 1, to: 20, totalCount: 800000,
  sameEntries: true, sameRanksAndMr: false, previous: { rank: 1, masterRating: 2400 }, current: { rank: 2, masterRating: 2399 },
  currentSameEntry: true, previousSameEntry: true, rankInversionWithinPage: false, mrInversionWithinPage: false }

test('diagnostic sanitizers reconstruct numeric allowlists and discard private nested fields and custom JSON', () => {
  const secret = 'private-id-name-hash-url-raw-dom', toJSON = () => secret
  const dirtyDiagnostic = { ...diagnostic, accountKey: secret, sourceUrl: secret, toJSON,
    previous: { ...diagnostic.previous, playerId: secret, toJSON }, current: { ...diagnostic.current, playerName: secret, toJSON } }
  const dirtyRecheck = { ...observed, rawDom: secret, toJSON,
    previous: { ...observed.previous, accountKey: secret, toJSON }, current: { ...observed.current, sourceUrl: secret, toJSON } }
  assert.deepEqual(sanitizeLegendOrderDiagnostic(dirtyDiagnostic), diagnostic)
  assert.deepEqual(sanitizeLegendOrderRecheck(dirtyRecheck), observed)
  assert.equal(JSON.stringify([sanitizeLegendOrderDiagnostic(dirtyDiagnostic), sanitizeLegendOrderRecheck(dirtyRecheck)]).includes(secret), false)
})

test('all recheck states have bounded fixed shapes, including null page-boundary observations', () => {
  assert.deepEqual(sanitizeLegendOrderRecheck({ status: 'failed', elapsedMs: 'secret', current: { playerId: 'secret' } }), { status: 'failed' })
  assert.deepEqual(sanitizeLegendOrderRecheck({ status: 'unavailable', elapsedMs: 10000, rawDom: 'secret' }), { status: 'unavailable', elapsedMs: 10000 })
  assert.deepEqual(sanitizeLegendOrderRecheck({ ...observed, previous: null, previousSameEntry: null, current: null }),
    { ...observed, previous: null, previousSameEntry: null, current: null })
})

test('nonfinite, excessive, nonboolean and hostile values never cross diagnostic serialization', () => {
  for (const number of [NaN, Infinity, -Infinity, -1, 1000000001, '123', { toJSON: () => 'secret' }]) {
    assert.equal(sanitizeLegendOrderDiagnostic({ ...diagnostic, current: { ...diagnostic.current, rank: number } }), undefined)
    assert.equal(sanitizeLegendOrderRecheck({ ...observed, current: { rank: number, masterRating: 2400 } }), undefined)
  }
  for (const elapsedMs of [NaN, Infinity, -1, 10001, '1000']) assert.equal(sanitizeLegendOrderRecheck({ ...observed, elapsedMs }), undefined)
  assert.equal(sanitizeLegendOrderDiagnostic({ ...diagnostic, sameEntry: 'private-name' }), undefined)
  assert.equal(sanitizeLegendOrderDiagnostic({ ...diagnostic, boundary: 'private-url' }), undefined)
  assert.equal(sanitizeLegendOrderDiagnostic({ ...diagnostic, current: { ...diagnostic.current, rowIndex: 21 } }), undefined)
  assert.equal(sanitizeLegendOrderRecheck({ ...observed, sameEntries: 'private-name' }), undefined)
  assert.equal(sanitizeLegendOrderRecheck({ ...observed, page: 1000001 }), undefined)
  assert.equal(sanitizeLegendOrderRecheck({ status: 'private-dom', elapsedMs: 1000 }), undefined)
  const hostile = { get status(): never { throw new Error('private response') }, get boundary(): never { throw new Error('private response') } }
  assert.equal(sanitizeLegendOrderDiagnostic(hostile), undefined)
  assert.equal(sanitizeLegendOrderRecheck(hostile), undefined)
})

test('recovery decisions retain fixed reasons and numeric positions while removing all private fields', () => {
  const decision: LegendPageRecoveryDecision = { trigger: 'rank-order', eligible: false, reason: 'earlier-page-duplicate',
    page: 15, previousPage: 14, recoveryUsed: false, conflict: {
      previous: { page: 13, rowIndex: 20, rank: 250, masterRating: 1812 }, current: { page: 15, rowIndex: 10, rank: 280, masterRating: 1810 } } }
  const secret = 'private-name-id-character-hash-url-dom', toJSON = () => secret
  const dirty = { ...decision, accountKey: secret, sourceUrl: secret, toJSON, conflict: { ...decision.conflict,
    characterId: secret, toJSON, previous: { ...decision.conflict!.previous, playerName: secret, toJSON },
    current: { ...decision.conflict!.current, playerId: secret, toJSON } } }
  assert.deepEqual(sanitizeLegendPageRecoveryDecision(dirty), decision)
  assert.equal(JSON.stringify(sanitizeLegendPageRecoveryDecision(dirty)).includes(secret), false)
  for (const reason of ['eligible', 'within-page-order', 'recovery-already-used', 'previous-page-missing', 'nonadjacent-page',
    'within-page-rank-order', 'within-page-mr-order', 'within-page-duplicate', 'earlier-page-duplicate'] as const) {
    const value = { trigger: 'duplicate-entry', eligible: reason === 'eligible', reason, page: 1, previousPage: null, recoveryUsed: false }
    assert.deepEqual(sanitizeLegendPageRecoveryDecision(value), value)
  }
})

test('malformed recovery decisions and nested positions never escape the allowlist', () => {
  const base: LegendPageRecoveryDecision = { trigger: 'mr-order', eligible: true, reason: 'eligible', page: 2, previousPage: 1, recoveryUsed: false }
  for (const patch of [{ trigger: 'secret' }, { reason: 'secret' }, { eligible: 'true' }, { eligible: false }, { recoveryUsed: 1 },
    { page: 0 }, { page: 1000001 }, { previousPage: NaN }, { previousPage: '1' }, { conflict: null }, { conflict: [] },
    { conflict: { previous: diagnostic.previous, current: { ...diagnostic.current, rank: Infinity } } },
    { conflict: { previous: diagnostic.previous, current: { ...diagnostic.current, rowIndex: 21 } } }]) {
    assert.equal(sanitizeLegendPageRecoveryDecision({ ...base, ...patch }), undefined)
  }
  assert.equal(sanitizeLegendPageRecoveryDecision({ get trigger(): never { throw new Error('secret') } }), undefined)
  assert.equal(sanitizeLegendPageRecoveryDecision({ ...base, conflict: { previous: diagnostic.previous,
    get current(): never { throw new Error('secret') } } }), undefined)
})
