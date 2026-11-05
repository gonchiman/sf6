import assert from 'node:assert/strict'
import test from 'node:test'
import { sanitizeLegendEndpointRecheck, sanitizeLegendOrderDiagnostic, sanitizeLegendOrderRecheck, sanitizeLegendPageRecoveryDecision, sanitizeLegendPageRecoveryRange } from './legend-order-diagnostics.ts'
import type { LegendEndpointRecheck, LegendOrderDiagnostic, LegendOrderRecheck, LegendPageRecoveryDecision, LegendPageRecoveryIssue } from './legend-order-diagnostics.ts'

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

test('recovery range sanitizer bounds the span and progress and strips private values', () => {
  const base = { attempt: 1, fromPage: 10, toPage: 14, lastValidatedPage: 14, status: 'succeeded' }
  assert.deepEqual(sanitizeLegendPageRecoveryRange({ ...base, secret: 'private', toJSON: () => 'private' }), base)
  assert.deepEqual(sanitizeLegendPageRecoveryRange({ ...base, lastValidatedPage: null, status: 'started' }), { ...base, lastValidatedPage: null, status: 'started' })
  assert.deepEqual(sanitizeLegendPageRecoveryRange({ ...base, status: 'failed' }), { ...base, status: 'failed' })
  for (const patch of [{ attempt: 0 }, { attempt: 4 }, { fromPage: 0 }, { toPage: 10 }, { toPage: 16 },
    { lastValidatedPage: 9 }, { lastValidatedPage: 15 }, { lastValidatedPage: null }, { status: 'private' }, { toPage: Infinity }]) {
    assert.equal(sanitizeLegendPageRecoveryRange({ ...base, ...patch }), undefined)
  }
  assert.equal(sanitizeLegendPageRecoveryRange({ get status(): never { throw new Error('private') } }), undefined)
})

const position = (page: number, rowIndex = 1) => ({ page, rowIndex, rank: (page - 1) * 20 + rowIndex, masterRating: 2400 - (page - 1) * 20 - rowIndex })
const issueRange = { attempt: 1, fromPage: 15, toPage: 20, lastValidatedPage: 20, status: 'succeeded' }
const recoveryIssues: LegendPageRecoveryIssue[] = [
  { kind: 'fixed-prefix-duplicate', fromPage: 17, toPage: 18,
    conflict: { previous: position(16, 20), current: position(17) }, expansion: { fromPage: 16, toPage: 18 } },
  { kind: 'recovery-range-duplicate', fromPage: 16, toPage: 18,
    conflict: { previous: position(16, 20), current: position(18) }, expansion: { fromPage: 16, toPage: 19 } },
  { kind: 'within-page-duplicate', fromPage: 16, toPage: 19, conflict: { previous: position(17), current: position(17, 3) } },
  { kind: 'missing-members', fromPage: 16, toPage: 19, missingCount: 2,
    missingPositions: [position(16, 2), position(19, 20)], expansion: { fromPage: 15, toPage: 20 } },
]

test('recovery issues retain scoped conflicts, missing members and strict expansions with deep private-field removal', () => {
  const secret = 'private-identity-name-url-hash', toJSON = () => secret
  const dirty = recoveryIssues.map(issue => ({ ...issue, playerId: secret, raw: [secret], toJSON,
    ...(issue.conflict ? { conflict: { previous: { ...issue.conflict.previous, accountKey: secret, toJSON },
      current: { ...issue.conflict.current, playerName: secret, toJSON }, profileUrl: secret, toJSON } } : {}),
    ...(issue.missingPositions ? { missingPositions: issue.missingPositions.map(item => ({ ...item, playerId: secret, toJSON })) } : {}),
    ...(issue.expansion ? { expansion: { ...issue.expansion, sourceUrl: secret, toJSON } } : {}) }))
  const safe = sanitizeLegendPageRecoveryRange({ ...issueRange, issues: dirty })
  assert.deepEqual(safe, { ...issueRange, issues: recoveryIssues })
  assert.deepEqual(sanitizeLegendPageRecoveryRange(safe), safe)
  assert.doesNotMatch(JSON.stringify(safe), /private-identity|playerId|playerName|accountKey|sourceUrl|profileUrl|raw|toJSON/)
  assert.notEqual(safe!.issues, dirty)
  assert.notEqual(safe!.issues![0].conflict!.previous, dirty[0].conflict!.previous)
  assert.deepEqual(sanitizeLegendPageRecoveryRange(issueRange), issueRange)
  assert.equal(Object.hasOwn(sanitizeLegendPageRecoveryRange(issueRange)!, 'issues'), false)
  assert.deepEqual(sanitizeLegendPageRecoveryRange({ ...issueRange, issues: [] }), { ...issueRange, issues: [] })
  assert.equal(sanitizeLegendPageRecoveryRange({ ...issueRange, issues: Array(5).fill(recoveryIssues[0]) })?.issues?.length, 5)
  for (const missingCount of [121, 1000, 20000]) {
    const missing = { kind: 'missing-members', fromPage: 16, toPage: 18, missingCount }
    assert.deepEqual(sanitizeLegendPageRecoveryRange({ ...issueRange, issues: [missing] })?.issues, [missing])
  }
  // Different members can occupy this same observed position in different passes; identities are deliberately absent.
  const samePositions = { kind: 'missing-members', fromPage: 16, toPage: 18, missingCount: 2,
    missingPositions: [position(17), position(17)] }
  assert.deepEqual(sanitizeLegendPageRecoveryRange({ ...issueRange, issues: [samePositions] })?.issues, [samePositions])
})

test('invalid issue shapes, incompatible scopes and nonexpanding bounds fail closed', () => {
  const duplicate = recoveryIssues[0], missing = recoveryIssues[3]
  const invalid = [null, {}, { ...duplicate, kind: 'private' }, { ...duplicate, fromPage: 0 },
    { ...duplicate, toPage: 17 }, { ...duplicate, toPage: 23 }, { ...duplicate, conflict: undefined },
    { ...duplicate, missingCount: 1 }, { ...duplicate, missingPositions: [] },
    { ...duplicate, conflict: { previous: position(17), current: position(17, 2) } },
    { ...duplicate, conflict: { previous: position(16), current: position(19) } },
    { ...recoveryIssues[1], conflict: { previous: position(15), current: position(17) } },
    { ...recoveryIssues[1], conflict: { previous: position(17), current: position(17, 2) } },
    { ...recoveryIssues[2], conflict: { previous: position(17, 3), current: position(17, 2) } },
    { ...recoveryIssues[2], conflict: { previous: position(16), current: position(17) } },
    { ...missing, conflict: duplicate.conflict }, { ...missing, missingCount: 0 }, { ...missing, missingCount: 20001 },
    { ...missing, missingCount: '1' }, { ...missing, missingCount: Infinity }, { ...missing, missingCount: 1 },
    { ...missing, missingPositions: [position(15)] }, { ...missing, missingPositions: [position(20)] },
    { ...missing, missingCount: 4, missingPositions: Array(4).fill(position(17)) },
    { ...duplicate, expansion: { fromPage: 17, toPage: 18 } }, { ...duplicate, expansion: { fromPage: 18, toPage: 19 } },
    { ...duplicate, expansion: { fromPage: 16, toPage: 17 } }, { ...duplicate, expansion: { fromPage: 12, toPage: 18 } },
    { ...duplicate, expansion: { fromPage: 0, toPage: 18 } }, { ...duplicate, expansion: { fromPage: 16, toPage: Infinity } },
  ]
  for (const issue of invalid) assert.equal(sanitizeLegendPageRecoveryRange({ ...issueRange, issues: [issue] }), undefined)
  for (const issues of [null, {}, Array(6).fill(duplicate), [duplicate, ...invalid]]) {
    assert.equal(sanitizeLegendPageRecoveryRange({ ...issueRange, issues }), undefined)
  }
})

test('issue and position arrays ignore custom iterators and reject throwing indexed access without leaking errors', () => {
  let iteratorCalls = 0
  const positions = [position(16)]
  Object.defineProperty(positions, Symbol.iterator, { value: function* () { iteratorCalls++; for (let i = 0; i < 100; i++) yield position(16) } })
  const missing = { kind: 'missing-members', fromPage: 16, toPage: 18, missingCount: 1, missingPositions: positions }
  const issues = [missing]
  Object.defineProperty(issues, Symbol.iterator, { value: function* () { iteratorCalls++; for (let i = 0; i < 100; i++) yield missing } })
  assert.deepEqual(sanitizeLegendPageRecoveryRange({ ...issueRange, issues })?.issues,
    [{ ...missing, missingPositions: [position(16)] }])
  assert.equal(iteratorCalls, 0)
  const hostile = { get kind(): never { throw new Error('private') } }
  assert.equal(sanitizeLegendPageRecoveryRange({ ...issueRange, issues: [hostile] }), undefined)
  for (const property of ['0', 'length']) {
    const throwingIssues = new Proxy(issues, { get(target, key, receiver) {
      if (key === property) throw new Error('private'); return Reflect.get(target, key, receiver)
    } })
    assert.equal(sanitizeLegendPageRecoveryRange({ ...issueRange, issues: throwingIssues }), undefined)
    const throwingPositions = new Proxy(positions, { get(target, key, receiver) {
      if (key === property) throw new Error('private'); return Reflect.get(target, key, receiver)
    } })
    assert.equal(sanitizeLegendPageRecoveryRange({ ...issueRange, issues: [{ ...missing, missingPositions: throwingPositions }] }), undefined)
  }
  assert.equal(sanitizeLegendPageRecoveryRange({ ...issueRange, issues: [{ ...recoveryIssues[0],
    conflict: { previous: position(16), get current(): never { throw new Error('private') } } }] }), undefined)
  assert.equal(sanitizeLegendPageRecoveryRange({ ...issueRange, issues: [{ ...recoveryIssues[0],
    expansion: { get fromPage(): never { throw new Error('private') } } }] }), undefined)
})

const missingDetail = { firstSeen: position(16, 2), lastSeen: position(17, 3), firstSeenSource: 'saved-page', observations: 4,
  accountPresence: 'other-character-in-range', sameAccountRowsCount: 2, sameAccountPositions: [position(18), position(18)] }
const missingProbe = { side: 'left', page: 13, unchanged: false, missingFoundCount: 1,
  found: [{ previous: position(16, 2), current: position(13, 20) }] }
const detailedMissing = { kind: 'missing-members', fromPage: 14, toPage: 18, missingCount: 2,
  missingDetails: [missingDetail], edgeProbes: [missingProbe,
    { side: 'right', page: 19, unchanged: null, missingFoundCount: 0, found: [] }] }
const detailedRange = { attempt: 1, fromPage: 14, toPage: 18, lastValidatedPage: 18, status: 'failed', issues: [detailedMissing] }

test('missing provenance and completed edge probes retain only numeric observations and fixed classifications', () => {
  const secret = 'private-player-identity', toJSON = () => secret
  const dirty = { ...detailedMissing, missingDetails: [{ ...missingDetail, playerId: secret, characterId: secret, toJSON,
    firstSeen: { ...missingDetail.firstSeen, accountKey: secret, toJSON }, lastSeen: { ...missingDetail.lastSeen, raw: secret },
    sameAccountPositions: missingDetail.sameAccountPositions.map(item => ({ ...item, playerName: secret, toJSON })) }],
    edgeProbes: detailedMissing.edgeProbes.map(probe => ({ ...probe, sourceUrl: secret, toJSON,
      found: probe.found.map(pair => ({ previous: { ...pair.previous, characterId: secret },
        current: { ...pair.current, playerId: secret, toJSON }, accountKey: secret, toJSON })) })) }
  const safe = sanitizeLegendPageRecoveryRange({ ...detailedRange, issues: [dirty] })
  assert.deepEqual(safe, detailedRange)
  assert.deepEqual(sanitizeLegendPageRecoveryRange(safe), safe)
  assert.doesNotMatch(JSON.stringify(safe), /private-player|playerId|playerName|accountKey|characterId|sourceUrl|raw|toJSON/)
  assert.notEqual(safe!.issues![0].missingDetails![0].firstSeen, dirty.missingDetails[0].firstSeen)
  assert.notEqual(safe!.issues![0].edgeProbes![0].found[0].current, dirty.edgeProbes[0].found[0].current)
  for (const firstSeenSource of ['saved-page', 'trigger-page', 'range-reread', 'right-baseline', 'left-probe']) {
    const detail = { ...missingDetail, firstSeenSource, observations: 20000,
      accountPresence: 'absent-from-range', sameAccountRowsCount: 0, sameAccountPositions: [] }
    const issue = { ...detailedMissing, missingDetails: [detail], edgeProbes: [] }
    assert.deepEqual(sanitizeLegendPageRecoveryRange({ ...detailedRange, issues: [issue] })?.issues, [issue])
  }
  const old = { kind: 'missing-members', fromPage: 14, toPage: 18, missingCount: 1 }
  assert.deepEqual(sanitizeLegendPageRecoveryRange({ ...detailedRange, issues: [old] })?.issues, [old])
})

test('missing detail and probe bounds reject inconsistent counts, classifications and page scopes', () => {
  const invalidDetails = [null, {}, { ...missingDetail, firstSeen: position(13) }, { ...missingDetail, lastSeen: position(19) },
    { ...missingDetail, firstSeenSource: 'private' }, { ...missingDetail, observations: 0 }, { ...missingDetail, observations: 20001 },
    { ...missingDetail, observations: Infinity }, { ...missingDetail, accountPresence: 'private' },
    { ...missingDetail, accountPresence: 'absent-from-range' }, { ...missingDetail, sameAccountRowsCount: 0 },
    { ...missingDetail, sameAccountRowsCount: 121 }, { ...missingDetail, sameAccountRowsCount: 1 },
    { ...missingDetail, sameAccountPositions: [position(13)] }, { ...missingDetail, sameAccountPositions: null },
    { ...missingDetail, sameAccountRowsCount: 4, sameAccountPositions: Array(4).fill(position(16)) }]
  for (const item of invalidDetails) {
    assert.equal(sanitizeLegendPageRecoveryRange({ ...detailedRange, issues: [{ ...detailedMissing, missingDetails: [item] }] }), undefined)
  }
  for (const missingDetails of [null, {}, Array(4).fill(missingDetail), Array(3).fill(missingDetail)]) {
    assert.equal(sanitizeLegendPageRecoveryRange({ ...detailedRange, issues: [{ ...detailedMissing, missingDetails }] }), undefined)
  }
  const invalidProbes = [null, {}, { ...missingProbe, side: 'private' }, { ...missingProbe, page: 12 },
    { ...missingProbe, unchanged: null }, { ...missingProbe, unchanged: 'private' },
    { ...missingProbe, side: 'right', page: 19, unchanged: true },
    { ...missingProbe, missingFoundCount: -1 }, { ...missingProbe, missingFoundCount: 3 }, { ...missingProbe, missingFoundCount: 0 },
    { ...missingProbe, found: null }, { ...missingProbe, found: [{ previous: position(13), current: position(13) }] },
    { ...missingProbe, found: [{ previous: position(16), current: position(14) }] }]
  for (const item of invalidProbes) {
    assert.equal(sanitizeLegendPageRecoveryRange({ ...detailedRange, issues: [{ ...detailedMissing, edgeProbes: [item] }] }), undefined)
  }
  for (const edgeProbes of [null, {}, Array(3).fill(missingProbe), [missingProbe, missingProbe]]) {
    assert.equal(sanitizeLegendPageRecoveryRange({ ...detailedRange, issues: [{ ...detailedMissing, edgeProbes }] }), undefined)
  }
  assert.equal(sanitizeLegendPageRecoveryRange({ ...detailedRange, issues: [{ ...detailedMissing, missingCount: 4,
    edgeProbes: [{ ...missingProbe, missingFoundCount: 4, found: Array(4).fill(missingProbe.found[0]) }] }] }), undefined)
  for (const patch of [{ missingDetails: [] }, { edgeProbes: [] }]) {
    assert.equal(sanitizeLegendPageRecoveryRange({ ...detailedRange, issues: [{ ...recoveryIssues[0], ...patch }] }), undefined)
  }
})

test('missing detail and edge-probe arrays ignore custom iterators and contain hostile nested access', () => {
  let iteratorCalls = 0
  const boundedArray = <T>(items: T[]): T[] => {
    Object.defineProperty(items, Symbol.iterator, { value: function* () { iteratorCalls++; for (let index = 0; index < 100; index++) yield items[0] } })
    return items
  }
  const issue = { ...detailedMissing,
    missingDetails: boundedArray([{ ...missingDetail, sameAccountPositions: boundedArray([...missingDetail.sameAccountPositions]) }]),
    edgeProbes: boundedArray([{ ...missingProbe, found: boundedArray([...missingProbe.found]) }]) }
  assert.deepEqual(sanitizeLegendPageRecoveryRange({ ...detailedRange, issues: [issue] })?.issues,
    [{ ...detailedMissing, edgeProbes: [missingProbe] }])
  assert.equal(iteratorCalls, 0)
  const throwing = <T>(items: T[], property: string): T[] => new Proxy(items, { get(target, key, receiver) {
    if (key === property) throw new Error('private'); return Reflect.get(target, key, receiver)
  } })
  for (const property of ['0', 'length']) {
    for (const patch of [
      { missingDetails: throwing([missingDetail], property) },
      { missingDetails: [{ ...missingDetail, sameAccountPositions: throwing([position(16)], property) }] },
      { edgeProbes: throwing([missingProbe], property) },
      { edgeProbes: [{ ...missingProbe, found: throwing(missingProbe.found, property) }] },
    ]) assert.equal(sanitizeLegendPageRecoveryRange({ ...detailedRange, issues: [{ ...detailedMissing, ...patch }] }), undefined)
  }
  for (const patch of [
    { missingDetails: [{ ...missingDetail, get firstSeen(): never { throw new Error('private') } }] },
    { missingDetails: [{ ...missingDetail, get observations(): never { throw new Error('private') } }] },
    { edgeProbes: [{ ...missingProbe, get unchanged(): never { throw new Error('private') } }] },
    { edgeProbes: [{ ...missingProbe, found: [{ previous: position(16), get current(): never { throw new Error('private') } }] }] },
  ]) assert.equal(sanitizeLegendPageRecoveryRange({ ...detailedRange, issues: [{ ...detailedMissing, ...patch }] }), undefined)
})

test('endpoint rechecks retain fixed outcomes and detached enum changes without private fields', () => {
  const values: LegendEndpointRecheck[] = [
    { attempt: 1, phase: 'start-recheck', page: 1, status: 'unchanged', changeKinds: [] },
    { attempt: 2, phase: 'end-recheck', page: 26, status: 'same-members-updated',
      changeKinds: ['rank', 'master-rating', 'player-labels', 'row-order'] },
    { attempt: 3, phase: 'start-recheck', page: 1, status: 'rejected', changeKinds: ['membership', 'legend-status'] },
    { attempt: 3, phase: 'end-recheck', page: 1000000, status: 'rejected',
      changeKinds: ['rank', 'master-rating', 'player-labels', 'row-order', 'membership', 'legend-status', 'metadata', 'invalid-page'] },
  ]
  const secret = 'private-player-id-hash-name-url', toJSON = () => secret
  for (const value of values) {
    const changes = [...value.changeKinds]
    Object.assign(changes, { accountKey: secret, toJSON })
    const dirty = { ...value, changeKinds: changes, playerId: secret, playerName: secret, sourceUrl: secret, toJSON }
    const safe = sanitizeLegendEndpointRecheck(dirty)
    assert.deepEqual(safe, value)
    assert.deepEqual(sanitizeLegendEndpointRecheck(safe), value)
    assert.notEqual(safe, dirty)
    assert.notEqual(safe!.changeKinds, changes)
    assert.equal(Object.getPrototypeOf(safe), Object.prototype)
    assert.doesNotMatch(JSON.stringify(safe), /private-player|playerId|playerName|accountKey|sourceUrl|toJSON/)
    changes.push('membership')
    assert.deepEqual(safe, value)
  }
})

test('endpoint rechecks reject inconsistent success classifications and invalid bounds', () => {
  const base: LegendEndpointRecheck = { attempt: 1, phase: 'start-recheck', page: 1,
    status: 'same-members-updated', changeKinds: ['master-rating'] }
  for (const value of [null, undefined, [], 1, 'private']) assert.equal(sanitizeLegendEndpointRecheck(value), undefined)
  for (const patch of [{ attempt: 0 }, { attempt: 4 }, { attempt: 1.5 }, { attempt: '1' }, { attempt: Infinity },
    { page: 0 }, { page: 1000001 }, { page: 2 }, { page: NaN }, { page: '1' }, { phase: 'private' },
    { status: 'private' }, { changeKinds: null }, { changeKinds: {} }, { changeKinds: [] },
    { changeKinds: ['private'] }, { changeKinds: [1] }, { changeKinds: [{ toString: () => 'rank' }] },
    { changeKinds: ['rank', 'rank'] }, { changeKinds: Array(9).fill('rank') },
    { status: 'unchanged', changeKinds: ['rank'] }, { status: 'rejected', changeKinds: [] },
    { status: 'rejected', changeKinds: ['rank', 'master-rating', 'row-order'] },
    ...['membership', 'legend-status', 'metadata', 'invalid-page'].map(kind => ({ changeKinds: [kind] }))]) {
    assert.equal(sanitizeLegendEndpointRecheck({ ...base, ...patch }), undefined)
  }
  for (const kind of ['membership', 'legend-status', 'metadata', 'invalid-page']) {
    const value = { ...base, status: 'rejected', changeKinds: [kind] }
    assert.deepEqual(sanitizeLegendEndpointRecheck(value), value)
  }
  for (const kind of ['rank', 'master-rating', 'player-labels', 'row-order']) {
    const value = { ...base, changeKinds: [kind] }
    assert.deepEqual(sanitizeLegendEndpointRecheck(value), value)
  }
})

test('endpoint diagnostics ignore array iterators and contain hostile property access', () => {
  const base = { attempt: 1, phase: 'start-recheck', page: 1, status: 'same-members-updated', changeKinds: ['rank'] }
  let iteratorCalls = 0
  const changes = ['rank']
  Object.defineProperty(changes, Symbol.iterator, { value: function* () { iteratorCalls++; yield 'private' } })
  assert.deepEqual(sanitizeLegendEndpointRecheck({ ...base, changeKinds: changes }), base)
  assert.equal(iteratorCalls, 0)
  for (const property of ['attempt', 'phase', 'page', 'status', 'changeKinds']) {
    const hostile = { ...base }
    Object.defineProperty(hostile, property, { get(): never { throw new Error('private response') } })
    assert.equal(sanitizeLegendEndpointRecheck(hostile), undefined)
  }
  for (const property of ['0', 'length']) {
    const hostile = new Proxy(changes, { get(target, key, receiver) {
      if (key === property) throw new Error('private response')
      return Reflect.get(target, key, receiver)
    } })
    assert.equal(sanitizeLegendEndpointRecheck({ ...base, changeKinds: hostile }), undefined)
  }
  const sparse = new Array(1)
  assert.equal(sanitizeLegendEndpointRecheck({ ...base, changeKinds: sparse }), undefined)
  const revoked = Proxy.revocable(base, {})
  revoked.revoke()
  assert.equal(sanitizeLegendEndpointRecheck(revoked.proxy), undefined)
})
