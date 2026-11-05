import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { STEAM_COLLECTION_VERSION } from './lib/steam-collection-version.ts'
import { isAllowedSteamDispatcher, nextSteamDispatchBoundary, resolveSteamDispatchDuration, runSteamPlayerCountDispatcher,
  STEAM_DISPATCH_DURATION_MS, STEAM_DISPATCH_HANDOFF_CHECK_MS, STEAM_DISPATCH_HANDOFF_MS,
  STEAM_DISPATCH_HANDOFF_PROOF_STEP, STEAM_DISPATCH_INTERVAL_MS } from './dispatch-steam-player-count.ts'

const start = Date.parse('2026-11-01T00:07:00.000Z')
const env = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Linux', GITHUB_REPOSITORY: 'gonchiman/sf6',
  GITHUB_REF: 'refs/heads/main', GITHUB_WORKFLOW_REF: 'gonchiman/sf6/.github/workflows/steam-player-count-dispatch.yml@refs/heads/main',
  GITHUB_EVENT_NAME: 'schedule', GITHUB_RUN_ID: '100', GITHUB_RUN_ATTEMPT: '1', GH_TOKEN: 'secret-test-token' }

function driverRun(id: string | number = '100', status = 'in_progress', conclusion: string | null = null, attempt = 1) {
  return { id, status, conclusion, run_attempt: attempt, event: 'workflow_dispatch', head_branch: 'main',
    path: '.github/workflows/steam-player-count-dispatch.yml', repository: { full_name: 'gonchiman/sf6' },
    head_repository: { full_name: 'gonchiman/sf6' }, created_at: '2026-11-01T00:00:00Z' }
}

function collectionRun(id: string | number = '200', status = 'completed', createdAt = start - 15 * 60_000, attempt = 1) {
  return { id, status, run_attempt: attempt, event: 'workflow_dispatch', head_branch: 'main',
    path: '.github/workflows/steam-player-count.yml', repository: { full_name: 'gonchiman/sf6' },
    head_repository: { full_name: 'gonchiman/sf6' }, created_at: new Date(createdAt).toISOString(),
    updated_at: new Date(createdAt + 30_000).toISOString() }
}

function proofJobs(id: string | number, conclusion = 'success') {
  return { total_count: 1, jobs: [{ name: 'dispatch', run_id: id, status: 'completed', conclusion,
    steps: [{ name: STEAM_DISPATCH_HANDOFF_PROOF_STEP, status: 'completed', conclusion: 'success' }] }] }
}
type RequestRecord = { url: string; method: string; time: number; options: RequestInit | undefined }

function fixture(options: { start?: number; request?: (request: RequestRecord) => Promise<Response | void> | Response | void;
  afterWait?: (ms: number) => void } = {}) {
  const state = { wall: options.start ?? start, elapsed: 0, requests: [] as RequestRecord[], waits: [] as number[], logs: [] as string[],
    dispatcher: 'active', collector: 'active', latest: null as null | ReturnType<typeof collectionRun>,
    collectionDetail: null as null | ReturnType<typeof collectionRun>,
    currentRun: driverRun(), successors: [] as ReturnType<typeof driverRun>[], predecessor: driverRun('90', 'completed', 'success'),
    predecessorJobs: proofJobs('90') }
  const fetchData: typeof fetch = async (input, init) => {
    const request = { url: String(input), method: init?.method ?? 'GET', time: state.wall, options: init }
    state.requests.push(request)
    const override = await options.request?.(request)
    if (override) return override
    if (request.method === 'POST') {
      if (request.url.endsWith('steam-player-count-dispatch.yml/dispatches')) {
        state.successors.push(driverRun(String(BigInt(state.currentRun.id) + 1n), 'pending'))
        return new Response(null, { status: 204 })
      }
      // GitHub records creation after the request; this must not lose alternate slots.
      state.latest = collectionRun(String(1000 + state.requests.length), 'completed', state.wall + 1000)
      return new Response(null, { status: 204 })
    }
    if (request.url.endsWith('steam-player-count-dispatch.yml')) return Response.json({ state: state.dispatcher })
    if (request.url.endsWith('steam-player-count.yml')) return Response.json({ state: state.collector })
    if (request.url.endsWith('/runs?branch=main&per_page=1')) return Response.json({ workflow_runs: state.latest ? [state.latest] : [] })
    if (request.url.endsWith('steam-player-count-dispatch.yml/runs?branch=main&per_page=20')) {
      return Response.json({ workflow_runs: [state.currentRun, ...state.successors] })
    }
    if (request.url.endsWith(`/actions/runs/${state.currentRun.id}`)) return Response.json(state.currentRun)
    if (request.url.endsWith(`/actions/runs/${state.predecessor.id}`)) return Response.json(state.predecessor)
    if (request.url.endsWith(`/actions/runs/${state.predecessor.id}/attempts/${state.predecessor.run_attempt}/jobs?per_page=100`)) return Response.json(state.predecessorJobs)
    const detail = state.collectionDetail ?? state.latest
    if (detail && request.url.endsWith(`/actions/runs/${detail.id}`)) return Response.json(detail)
    assert.fail(`unexpected URL: ${request.url}`)
  }
  const run = (extra: Parameters<typeof runSteamPlayerCountDispatcher>[0] = {}) => runSteamPlayerCountDispatcher({
    env, handoff: false, now: () => state.wall, monotonicNow: () => state.elapsed,
    wait: async ms => { state.waits.push(ms); state.wall += ms; state.elapsed += ms; options.afterWait?.(ms) },
    fetch: fetchData, write: message => state.logs.push(message), ...extra,
  })
  const posts = () => state.requests.filter(item => item.method === 'POST')
  const handoffPosts = () => posts().filter(item => item.url.endsWith('steam-player-count-dispatch.yml/dispatches'))
  const collectorPosts = () => posts().filter(item => item.url.endsWith('steam-player-count.yml/dispatches'))
  return { state, run, posts, handoffPosts, collectorPosts }
}

test('bounds one generation to 330 minutes and dispatches 22 aligned observations without drift', async () => {
  const f = fixture()
  const result = await f.run()
  assert.equal(result.reason, 'duration')
  assert.equal(result.dispatched, 22)
  assert.equal(result.failed, 0)
  assert.equal(f.state.elapsed, STEAM_DISPATCH_DURATION_MS)
  assert.ok(f.state.waits.every(ms => ms > 0 && ms <= 60_000))
  assert.deepEqual(f.posts().map(request => request.time), Array.from({ length: 22 }, (_, index) => start + index * STEAM_DISPATCH_INTERVAL_MS))
  for (const request of f.state.requests) {
    assert.ok(request.url.startsWith('https://api.github.com/repos/gonchiman/sf6/actions/workflows/'))
    assert.equal(request.options?.redirect, 'error')
    assert.equal(request.options?.credentials, 'omit')
    assert.equal((request.options?.headers as Record<string, string>).Authorization, 'Bearer secret-test-token')
  }
  for (const request of f.posts()) {
    assert.equal(request.url, 'https://api.github.com/repos/gonchiman/sf6/actions/workflows/steam-player-count.yml/dispatches')
    assert.deepEqual(JSON.parse(String(request.options?.body)), { ref: 'main' })
  }
  assert.ok(f.state.logs.every(message => !message.includes(env.GH_TOKEN)))
})

test('dispatcher logs retain the checked-out version on success, skips and request failures', async () => {
  const sourceSha = 'b'.repeat(40)
  for (const scenario of ['success', 'skip', 'failure']) {
    const f = fixture({ request: request => {
      if (scenario === 'failure' && request.url.endsWith('steam-player-count.yml')) {
        throw new Error('private-network-error-must-not-appear')
      }
    } })
    if (scenario === 'skip') f.state.latest = collectionRun('200', 'completed', start)
    await f.run({ durationMs: 60_000, env: { ...env, GITHUB_SHA: sourceSha } })
    const logs = f.state.logs.map(message => JSON.parse(message))
    const expectedEvent = scenario === 'success' ? 'dispatched' : scenario === 'skip' ? 'slot-skipped' : 'slot-failed'
    assert.ok(logs.some(log => log.event === expectedEvent), scenario)
    for (const log of logs) {
      assert.equal(log.component, 'dispatcher')
      assert.equal(log.processVersion, STEAM_COLLECTION_VERSION)
      assert.equal(log.codeSha, sourceSha)
    }
    assert.ok(f.state.logs.every(message => !message.includes(env.GH_TOKEN)
      && !message.includes('private-network-error-must-not-appear')))
  }
  const unknown = fixture()
  await unknown.run({ durationMs: 60_000, env: { ...env, GITHUB_SHA: 'unsafe-private-sha' } })
  assert.ok(unknown.state.logs.every(message => JSON.parse(message).codeSha === null
    && !message.includes('unsafe-private-sha')))
})

test('starts at the next existing minute offset and does not emit an out-of-cycle observation', async () => {
  const f = fixture({ start: start + 120_000 })
  await f.run({ durationMs: 30 * 60_000 })
  assert.deepEqual(f.posts().map(item => item.time), [start + 15 * 60_000, start + 30 * 60_000])
  assert.equal(nextSteamDispatchBoundary(Date.parse('2026-11-01T00:59:00Z')), Date.parse('2026-11-01T01:07:00Z'))
})

test('request latency does not accumulate into a progressively later schedule', async () => {
  const f = fixture({ request: () => { f.state.wall += 1000; f.state.elapsed += 1000 } })
  await f.run({ durationMs: 46 * 60_000 })
  assert.deepEqual(f.posts().map(item => item.time), [0, 1, 2, 3].map(index => start + index * 15 * 60_000 + 3000))
})

test('a forward clock jump skips missed slots without catch-up requests', async () => {
  let jumped = false
  const f = fixture({ afterWait: () => {
    if (!jumped && f.state.elapsed >= 3 * 60_000) { jumped = true; f.state.wall += 90 * 60_000 }
  } })
  const result = await f.run({ durationMs: 30 * 60_000 })
  assert.equal(result.skipped, 1)
  assert.deepEqual(f.posts().map(item => item.time), [start, start + 105 * 60_000])
})

test('a backward wall clock jump cannot extend the monotonic generation budget', async () => {
  let jumped = false
  const f = fixture({ afterWait: () => {
    if (!jumped && f.state.elapsed >= 3 * 60_000) { jumped = true; f.state.wall -= 60 * 60_000 }
  } })
  await f.run({ durationMs: 30 * 60_000 })
  assert.equal(f.state.elapsed, 30 * 60_000)
  assert.deepEqual(f.posts().map(item => item.time), [start])
})

test('an existing run in the current aligned slot prevents a handoff duplicate', async () => {
  const f = fixture()
  f.state.latest = collectionRun('200', 'completed', start + 1000)
  const result = await f.run({ durationMs: 16 * 60_000 })
  assert.equal(result.skipped, 1)
  assert.deepEqual(f.posts().map(item => item.time), [start + 15 * 60_000])
})

test('an unfinished collection prevents building a queue of new collection runs', async () => {
  const f = fixture()
  f.state.latest = collectionRun('200', 'in_progress', start - 60 * 60_000)
  const result = await f.run({ durationMs: 16 * 60_000 })
  assert.equal(result.skipped, 2)
  assert.equal(f.posts().length, 0)
})

test('a stale active list entry is rechecked once and a matching completed detail clears it', async () => {
  const f = fixture()
  f.state.latest = collectionRun('200', 'in_progress')
  f.state.collectionDetail = collectionRun('200', 'completed')
  const result = await f.run({ durationMs: 60_000 })
  assert.equal(result.dispatched, 1)
  assert.equal(result.failed, 0)
  assert.equal(result.skipped, 0)
  assert.deepEqual(f.collectorPosts().map(request => request.time), [start + 5000])
  assert.equal(f.state.requests.filter(request => request.url.endsWith('/actions/runs/200')).length, 1)
  assert.equal(f.state.requests.filter(request => request.url.endsWith('/runs?branch=main&per_page=1')).length, 2)
  const events = f.state.logs.map(line => JSON.parse(line))
  assert.equal(events.filter(event => event.event === 'collection-recheck').length, 1)
  const detail = events.find(event => event.event === 'collection-state' && event.stage === 'collection-run-recheck')
  assert.ok(detail)
  assert.equal(detail.runId, '200')
  assert.equal(detail.runAttempt, 1)
  assert.equal(detail.runStatus, 'completed')
  assert.equal(detail.runCreatedAt, f.state.collectionDetail.created_at)
  assert.equal(detail.runUpdatedAt, f.state.collectionDetail.updated_at)
})

test('a genuinely unfinished run remains skipped after the bounded recheck', async () => {
  for (const status of ['queued', 'in_progress', 'waiting', 'requested', 'pending']) {
    const f = fixture()
    f.state.latest = collectionRun('200', status)
    const result = await f.run({ durationMs: 60_000 })
    assert.equal(result.skipped, 1, status)
    assert.equal(f.collectorPosts().length, 0)
    assert.equal(f.state.requests.filter(request => request.url.endsWith('/actions/runs/200')).length, 1)
    const skip = f.state.logs.map(line => JSON.parse(line)).find(event => event.event === 'slot-skipped')
    assert.equal(skip.reason, 'active-run')
    assert.equal(skip.runId, '200')
    assert.equal(skip.runStatus, status)
  }
})

test('current and future slot runs remain duplicates even when completed', async () => {
  for (const [offset, reason] of [[1000, 'current-slot'], [15 * 60_000, 'future-slot']] as const) {
    for (const status of ['completed', 'in_progress']) {
      const f = fixture()
      f.state.latest = collectionRun('200', status, start + offset)
      const result = await f.run({ durationMs: 60_000 })
      assert.equal(result.skipped, 1)
      assert.equal(f.collectorPosts().length, 0)
      assert.equal(f.state.requests.filter(request => request.url.includes('/actions/runs/')).length, 0)
      assert.equal(f.state.logs.map(line => JSON.parse(line)).find(event => event.event === 'slot-skipped').reason, reason)
    }
  }
})

test('a completed old detail cannot clear a replaced, rerun, retimed or newer active list entry', async () => {
  for (const change of ['id', 'attempt', 'created-at', 'updated-at']) {
    let reads = 0
    const f = fixture({ request: request => {
      if (!request.url.endsWith('/runs?branch=main&per_page=1') || ++reads !== 2) return
      const latest = { ...f.state.latest! }
      if (change === 'id') latest.id = '201'
      if (change === 'attempt') latest.run_attempt = 2
      if (change === 'created-at') latest.created_at = new Date(start - 5 * 60_000).toISOString()
      if (change === 'updated-at') latest.updated_at = new Date(start + 1000).toISOString()
      return Response.json({ workflow_runs: [latest] })
    } })
    f.state.latest = collectionRun('200', 'in_progress')
    f.state.collectionDetail = collectionRun('200', 'completed')
    const result = await f.run({ durationMs: 60_000 })
    assert.equal(f.collectorPosts().length, 0, change)
    assert.equal(result.skipped, 1, change)
    assert.equal(f.state.logs.map(line => JSON.parse(line)).find(event => event.event === 'slot-skipped').reason, 'run-changed', change)
  }
})

test('a recheck detail cannot authorize another repository, workflow, branch or run identity', async () => {
  for (const field of ['id', 'run_attempt', 'repository', 'head_repository', 'path', 'head_branch', 'event', 'created_at', 'updated_at']) {
    const f = fixture()
    f.state.latest = collectionRun('200', 'in_progress')
    f.state.collectionDetail = collectionRun('200', 'completed')
    const invalid: Record<string, unknown> = { ...f.state.collectionDetail }
    if (field === 'id') invalid.id = '201'
    else if (field === 'run_attempt') invalid.run_attempt = 0
    else if (field === 'repository' || field === 'head_repository') invalid[field] = { full_name: 'other/private-secret' }
    else invalid[field] = 'private-secret'
    const broken = fixture({ request: request => request.url.endsWith('/actions/runs/200') ? Response.json(invalid) : undefined })
    broken.state.latest = f.state.latest
    const result = await broken.run({ durationMs: 60_000 })
    assert.equal(result.failed, 1, field)
    assert.equal(broken.collectorPosts().length, 0)
    const failure = broken.state.logs.map(line => JSON.parse(line)).find(event => event.event === 'slot-failed')
    assert.equal(failure.stage, 'collection-run-recheck')
    assert.equal(failure.errorKind, 'invalid-response')
    assert.ok(broken.state.logs.every(line => !line.includes('private-secret')))
  }
})

test('disabling either workflow during the recheck wait prevents a new collection', async () => {
  for (const field of ['dispatcher', 'collector'] as const) {
    const f = fixture({ afterWait: ms => { if (ms === 5000) f.state[field] = 'disabled_manually' } })
    f.state.latest = collectionRun('200', 'in_progress')
    f.state.collectionDetail = collectionRun('200', 'completed')
    const result = await f.run({ durationMs: 60_000 })
    assert.equal(result.reason, field === 'dispatcher' ? 'dispatcher-disabled' : 'collector-disabled')
    assert.equal(f.collectorPosts().length, 0)
  }
})

test('the recheck wait and later API responses cannot exceed the slot or generation budget', async () => {
  const exhausted = fixture()
  exhausted.state.latest = collectionRun('200', 'in_progress')
  await exhausted.run({ durationMs: 3000 })
  assert.ok(exhausted.state.elapsed <= 3000)
  assert.equal(exhausted.collectorPosts().length, 0)
  assert.equal(exhausted.state.requests.filter(request => request.url.includes('/actions/runs/')).length, 0)

  for (const phase of ['wait', 'detail', 'list']) {
    let listReads = 0
    const f = fixture({
      afterWait: ms => { if (phase === 'wait' && ms === 5000) f.state.wall += 60_000 },
      request: request => {
        if (request.url.endsWith('/runs?branch=main&per_page=1')) listReads++
        if (phase === 'detail' && request.url.endsWith('/actions/runs/200')
          || phase === 'list' && request.url.endsWith('/runs?branch=main&per_page=1') && listReads === 2) {
          f.state.wall += 60_000; f.state.elapsed += 60_000
        }
      },
    })
    f.state.latest = collectionRun('200', 'in_progress')
    f.state.collectionDetail = collectionRun('200', 'completed')
    await f.run({ durationMs: 120_000 })
    assert.equal(f.collectorPosts().length, 0, phase)
    assert.ok(f.state.logs.map(line => JSON.parse(line)).some(event =>
      event.event === 'slot-skipped' && event.reason === 'late'
      || event.event === 'slot-failed' && event.errorKind === 'budget-exhausted'), phase)
  }
})

test('collection API failures record the exact safe stage and kind without response or credential data', async () => {
  const cases = [
    { stage: 'collector-status', path: 'steam-player-count.yml', kind: 'http', status: 503 },
    { stage: 'collection-list', path: '/runs?branch=main&per_page=1', kind: 'invalid-json', status: 200 },
    { stage: 'collection-list', path: '/runs?branch=main&per_page=1', kind: 'response-too-large', status: 200 },
    { stage: 'collection-list', path: '/runs?branch=main&per_page=1', kind: 'invalid-response', status: 200 },
    { stage: 'collection-dispatch', path: 'steam-player-count.yml/dispatches', kind: 'network', status: null },
    { stage: 'collection-dispatch', path: 'steam-player-count.yml/dispatches', kind: 'timeout', status: null },
    { stage: 'collection-run-recheck', path: '/actions/runs/200', kind: 'http', status: 502 },
  ] as const
  for (const entry of cases) {
    const f = fixture({ request: request => {
      if (!request.url.endsWith(entry.path)) return
      if (entry.kind === 'network') throw new Error(`private response ${env.GH_TOKEN}`)
      if (entry.kind === 'timeout') return new Promise<Response>(() => {})
      if (entry.kind === 'invalid-response') return Response.json({ workflow_runs: [{ private: env.GH_TOKEN }] })
      return new Response(entry.kind === 'response-too-large' ? 'private response'.repeat(10000) : `private response ${env.GH_TOKEN}`,
        { status: entry.status! })
    } })
    if (entry.stage === 'collection-run-recheck') f.state.latest = collectionRun('200', 'in_progress')
    const result = await f.run({ durationMs: 60_000, requestTimeoutMs: 10 })
    assert.equal(result.failed, 1, `${entry.stage}/${entry.kind}`)
    assert.equal(result.dispatched, 0)
    const failure = f.state.logs.map(line => JSON.parse(line)).find(event => event.event === 'slot-failed')
    assert.equal(failure.stage, entry.stage)
    assert.equal(failure.errorKind, entry.kind)
    if (entry.kind === 'http') assert.equal(failure.httpStatus, entry.status)
    assert.ok(f.state.logs.every(line => !line.includes(env.GH_TOKEN) && !line.includes('private response')))
    assert.ok(f.collectorPosts().length <= 1)
  }
})

test('disabling the dispatcher stops the running generation at the next heartbeat', async () => {
  const f = fixture({ afterWait: () => { f.state.dispatcher = 'disabled_manually' } })
  const result = await f.run()
  assert.equal(result.reason, 'dispatcher-disabled')
  assert.equal(f.state.elapsed, 60_000)
  assert.equal(f.posts().length, 1)
})

test('a disabled collector ends the driver without dispatching it', async () => {
  const f = fixture()
  f.state.collector = 'disabled_manually'
  const result = await f.run()
  assert.equal(result.reason, 'collector-disabled')
  assert.equal(f.posts().length, 0)
  assert.equal(f.state.elapsed, 0)
})

test('rejects other repositories, branches, workflows, event types, runners and missing credentials before networking', async () => {
  assert.equal(isAllowedSteamDispatcher(env), true)
  for (const [key, value] of Object.entries({ GITHUB_ACTIONS: 'false', RUNNER_ENVIRONMENT: 'self-hosted', RUNNER_OS: 'Windows',
    GITHUB_REPOSITORY: 'other/sf6', GITHUB_REF: 'refs/heads/other', GITHUB_WORKFLOW_REF: 'other',
    GITHUB_EVENT_NAME: 'pull_request', GH_TOKEN: '' })) {
    const f = fixture()
    await assert.rejects(f.run({ env: { ...env, [key]: value } }), /固定main/)
    assert.equal(f.state.requests.length, 0)
  }
  for (const durationMs of [0, -1, STEAM_DISPATCH_DURATION_MS + 1, NaN]) {
    const f = fixture()
    await assert.rejects(f.run({ durationMs }), /実行時間/)
    assert.equal(f.state.requests.length, 0)
  }
})

test('401, 403 and 404 stop the generation instead of repeating rejected requests', async () => {
  for (const status of [401, 403, 404]) {
    const f = fixture({ request: () => new Response('private response', { status }) })
    const result = await f.run()
    assert.equal(result.reason, 'access-denied')
    assert.equal(f.state.requests.length, 1)
    assert.equal(f.state.elapsed, 0)
    assert.ok(f.state.logs.every(message => !message.includes('private response')))
  }
})

test('429 ends the generation without violating the server retry interval', async () => {
  const f = fixture({ request: () => new Response(null, { status: 429, headers: { 'Retry-After': '7200' } }) })
  const result = await f.run()
  assert.equal(result.reason, 'rate-limited')
  assert.equal(f.state.requests.length, 1)
})

test('an ambiguous POST is not retried and the next slot remains on schedule', async () => {
  let attempts = 0
  const f = fixture({ request: request => {
    if (request.method === 'POST' && ++attempts === 1) throw new Error('transport error containing secret-test-token')
  } })
  const result = await f.run({ durationMs: 16 * 60_000 })
  assert.equal(result.failed, 1)
  assert.equal(result.dispatched, 1)
  assert.deepEqual(f.posts().map(item => item.time), [start, start + 15 * 60_000])
  assert.ok(f.state.logs.every(message => !message.includes(env.GH_TOKEN)))
})

test('supports successful 200 dispatch acknowledgements without following response URLs', async () => {
  const f = fixture({ request: request => request.method === 'POST'
    ? Response.json({ workflow_run_id: 123, html_url: 'https://untrusted.invalid/' }) : undefined })
  const result = await f.run({ durationMs: 60_000 })
  assert.equal(result.dispatched, 1)
  assert.ok(f.state.requests.every(item => item.url.startsWith('https://api.github.com/')))
  assert.ok(f.state.logs.every(message => !message.includes('untrusted.invalid')))
})

test('failed or malformed heartbeat cannot authorize a collection for that slot', async () => {
  for (const value of ['http', 'json', 'state']) {
    let calls = 0
    const f = fixture({ request: request => {
      if (request.url.endsWith('steam-player-count-dispatch.yml') && ++calls === 1) {
        return value === 'http' ? new Response(null, { status: 503 })
          : value === 'json' ? new Response('not JSON') : Response.json({ state: 'unknown-state' })
      }
    } })
    const result = await f.run({ durationMs: 16 * 60_000 })
    assert.equal(result.failed, 1)
    assert.deepEqual(f.posts().map(item => item.time), [start + 15 * 60_000])
  }
})

test('a sustained heartbeat outage reports failure instead of a successful empty generation', async () => {
  const f = fixture({ request: () => new Response(null, { status: 503 }) })
  const result = await f.run()
  assert.equal(result.reason, 'duration')
  assert.equal(result.dispatched, 0)
  assert.equal(result.failed, 22)
  assert.equal(f.posts().length, 0)
})

test('bounds stalled fetch and body reads, and never leaks or retries the failed POST', async () => {
  for (const mode of ['fetch', 'body']) {
    const f = fixture({ request: request => {
      if (mode === 'fetch' && request.method === 'POST') return new Promise<Response>(() => {})
      if (mode === 'body' && request.url.endsWith('steam-player-count-dispatch.yml')) return new Response(new ReadableStream({ start() {} }))
    } })
    const started = Date.now()
    const result = await f.run({ durationMs: 60_000, requestTimeoutMs: 5 })
    assert.ok(Date.now() - started < 1000)
    assert.equal(f.posts().length, mode === 'fetch' ? 1 : 0)
    assert.equal(result.failed, 1)
  }
})

test('an overlarge API response is rejected before it can authorize a dispatch', async () => {
  const f = fixture({ request: request => request.url.endsWith('/runs?branch=main&per_page=1')
    ? new Response('x'.repeat(65 * 1024)) : undefined })
  const result = await f.run({ durationMs: 60_000 })
  assert.equal(result.failed, 1)
  assert.equal(f.posts().length, 0)
})

test('normal 330-minute completion reserves and verifies exactly one standard successor', async () => {
  const f = fixture()
  const result = await f.run({ handoff: true })
  assert.equal(result.reason, 'duration')
  assert.equal(result.handoff, 'confirmed')
  assert.equal(result.successorRunId, '101')
  assert.equal(f.collectorPosts().length, 22)
  assert.equal(f.handoffPosts().length, 1)
  assert.deepEqual(JSON.parse(String(f.handoffPosts()[0].options?.body)), {
    ref: 'main', inputs: { mode: 'standard', predecessor_run_id: '100', predecessor_run_attempt: '1' },
  })
  assert.ok(f.state.elapsed >= STEAM_DISPATCH_DURATION_MS && f.state.elapsed <= STEAM_DISPATCH_DURATION_MS + STEAM_DISPATCH_HANDOFF_MS)
  assert.ok(f.state.logs.some(line => JSON.parse(line).event === 'handoff-requested'))
  assert.ok(f.state.logs.some(line => JSON.parse(line).event === 'handoff-confirmed'))
  assert.ok(f.state.logs.every(line => !line.includes(env.GH_TOKEN)))
})

test('handoff-check is manual-only, lasts two minutes, and never propagates its short mode', async () => {
  assert.equal(resolveSteamDispatchDuration({}), STEAM_DISPATCH_DURATION_MS)
  assert.equal(resolveSteamDispatchDuration({ STEAM_DISPATCH_MODE: 'standard' }), STEAM_DISPATCH_DURATION_MS)
  assert.equal(resolveSteamDispatchDuration({ STEAM_DISPATCH_MODE: 'handoff-check', GITHUB_EVENT_NAME: 'workflow_dispatch' }), STEAM_DISPATCH_HANDOFF_CHECK_MS)
  assert.throws(() => resolveSteamDispatchDuration({ STEAM_DISPATCH_MODE: 'handoff-check', GITHUB_EVENT_NAME: 'schedule' }))
  assert.throws(() => resolveSteamDispatchDuration({ STEAM_DISPATCH_MODE: 'unexpected' }))
  const f = fixture()
  const result = await f.run({ handoff: true, env: { ...env, GITHUB_EVENT_NAME: 'workflow_dispatch', STEAM_DISPATCH_MODE: 'handoff-check' } })
  assert.equal(result.handoff, 'confirmed')
  assert.equal(f.collectorPosts().length, 1)
  assert.equal(f.handoffPosts()[0].time, start + 2 * 60_000)
  assert.equal(JSON.parse(String(f.handoffPosts()[0].options?.body)).inputs.mode, 'standard')
})

test('reuses a newer pending successor by exact ID and ignores timestamp anomalies, completed and current runs', async () => {
  for (const status of ['queued', 'waiting', 'requested', 'pending']) {
    const f = fixture()
    f.state.successors = [driverRun('99', 'pending'), driverRun('102', 'completed', 'success'),
      { ...driverRun('101', status), created_at: '2099-01-01T00:00:00Z' }]
    const result = await f.run({ handoff: true, durationMs: 60_000 })
    assert.equal(result.successorRunId, '101')
    assert.equal(f.handoffPosts().length, 0)
  }
})

test('handoff compares large string IDs without unsafe-number rounding', async () => {
  const f = fixture()
  f.state.currentRun = driverRun('9007199254740993')
  f.state.successors = [driverRun('9007199254740994', 'pending')]
  const result = await f.run({ handoff: true, durationMs: 60_000, env: { ...env, GITHUB_RUN_ID: '9007199254740993' } })
  assert.equal(result.successorRunId, '9007199254740994')
  assert.equal(f.handoffPosts().length, 0)
})

test('an ambiguous successor POST is never repeated but the queued run can be confirmed', async () => {
  const f = fixture({ request: request => {
    if (request.url.endsWith('steam-player-count-dispatch.yml/dispatches')) {
      f.state.successors.push(driverRun('101', 'pending'))
      throw new Error(`lost response ${env.GH_TOKEN}`)
    }
  } })
  const result = await f.run({ handoff: true, durationMs: 60_000 })
  assert.equal(result.handoff, 'confirmed')
  assert.equal(f.handoffPosts().length, 1)
  assert.ok(f.state.logs.every(line => !line.includes(env.GH_TOKEN)))
})

test('successor acknowledgement 200 is accepted without following its response URL', async () => {
  const f = fixture({ request: request => {
    if (request.url.endsWith('steam-player-count-dispatch.yml/dispatches')) {
      f.state.successors.push(driverRun('101', 'pending'))
      return Response.json({ html_url: 'https://untrusted.invalid/private', workflow_run_id: 101 })
    }
  } })
  const result = await f.run({ handoff: true, durationMs: 60_000 })
  assert.equal(result.handoff, 'confirmed')
  assert.ok(f.state.requests.every(item => item.url.startsWith('https://api.github.com/repos/gonchiman/sf6/actions/')))
  assert.ok(f.state.logs.every(line => !line.includes('untrusted.invalid')))
})

test('unconfirmed or ambiguous handoff fails within its separate budget and sends only one POST', async () => {
  for (const ambiguous of [false, true]) {
    const f = fixture({ request: request => {
      if (request.url.endsWith('steam-player-count-dispatch.yml/dispatches')) {
        if (ambiguous) throw new Error('lost acknowledgement')
        return new Response(null, { status: 204 })
      }
    } })
    const result = await f.run({ handoff: true, durationMs: 60_000 })
    assert.equal(result.handoff, 'failed')
    assert.equal(result.failed, 1)
    assert.equal(f.handoffPosts().length, 1)
    assert.ok(f.state.elapsed <= 60_000 + STEAM_DISPATCH_HANDOFF_MS)
    assert.ok(f.state.requests.filter(item => item.url.includes('per_page=20')).length <= 12)
  }
})

test('transient GET failures before and after successor dispatch use the bounded handshake retry', async () => {
  for (const phase of ['initial-gate', 'initial-list', 'confirmation-gate', 'confirmation-list']) {
    let failed = false
    const f = fixture({ request: request => {
      const afterPost = f.handoffPosts().length > 0
      if (!failed && f.state.elapsed >= 60_000 && request.method === 'GET'
        && (phase.startsWith('confirmation') ? afterPost : !afterPost)
        && (phase.endsWith('gate') ? request.url.endsWith('steam-player-count-dispatch.yml') : request.url.includes('per_page=20'))) {
        failed = true; return new Response(null, { status: 503 })
      }
    } })
    const result = await f.run({ handoff: true, durationMs: 60_000 })
    assert.equal(failed, true)
    assert.equal(result.handoff, 'confirmed', phase)
    assert.equal(f.handoffPosts().length, 1)
  }
})

test('disabled workflows, cancelled current run, auth failure or rate limiting cannot reserve a successor', async () => {
  for (const failure of ['driver', 'collector', 'cancelled', 'access', 'rate']) {
    const f = fixture({ request: request => {
      if (f.state.elapsed < 60_000) return
      if (failure === 'access') return new Response(null, { status: 403 })
      if (failure === 'rate') return new Response(null, { status: 429 })
      if (failure === 'driver') f.state.dispatcher = 'disabled_manually'
      if (failure === 'collector') f.state.collector = 'disabled_manually'
      if (failure === 'cancelled') f.state.currentRun = driverRun('100', 'completed', 'cancelled')
    } })
    const result = await f.run({ handoff: true, durationMs: 60_000 })
    assert.notEqual(result.handoff, 'confirmed')
    assert.equal(f.handoffPosts().length, 0)
  }
})

test('a normal generation with earlier missed observations still confirms handoff while retaining failure visibility', async () => {
  let failed = false
  const f = fixture({ request: request => {
    if (!failed && request.url.endsWith('steam-player-count.yml/dispatches')) { failed = true; throw new Error('temporary transport error') }
  } })
  const result = await f.run({ handoff: true, durationMs: 60_000 })
  assert.equal(result.reason, 'duration')
  assert.equal(result.failed, 1)
  assert.equal(result.handoff, 'confirmed')
})

test('handoff list permits real-sized payloads above 64KiB but rejects over its 1MiB bound', async () => {
  for (const oversized of [false, true]) {
    const f = fixture({ request: request => request.url.includes('per_page=20') ? Response.json({
      workflow_runs: [{ ...driverRun('101', 'pending'), padding: 'x'.repeat(oversized ? 1024 * 1024 : 80 * 1024) }],
    }) : undefined })
    const result = await f.run({ handoff: true, durationMs: 60_000 })
    assert.equal(result.handoff, oversized ? 'failed' : 'confirmed')
    assert.equal(f.handoffPosts().length, 0)
  }
})

test('linked successor starts only after a matching completed predecessor and exact proof step, including prior failed slots', async () => {
  for (const conclusion of ['success', 'failure']) {
    const f = fixture()
    f.state.predecessor = driverRun('90', 'completed', conclusion, 2)
    f.state.predecessorJobs = proofJobs('90', conclusion)
    const result = await f.run({ handoff: true, durationMs: 60_000, env: { ...env,
      STEAM_DISPATCH_PREDECESSOR_RUN_ID: '90', STEAM_DISPATCH_PREDECESSOR_RUN_ATTEMPT: '2' } })
    assert.equal(result.handoff, 'confirmed')
    assert.equal(f.collectorPosts().length, 1)
    const proofIndex = f.state.requests.findIndex(item => item.url.endsWith('/90/attempts/2/jobs?per_page=100'))
    const firstPost = f.state.requests.findIndex(item => item.method === 'POST')
    assert.ok(proofIndex >= 0 && proofIndex < firstPost)
  }
})

test('startup proof retries stale predecessor state within 120 seconds before starting a full generation', async () => {
  let stale = true
  const f = fixture({ request: request => {
    if (request.url.endsWith('/actions/runs/90') && stale) { stale = false; return Response.json(driverRun('90', 'in_progress')) }
  } })
  const result = await f.run({ handoff: true, durationMs: 60_000, env: { ...env,
    STEAM_DISPATCH_PREDECESSOR_RUN_ID: '90', STEAM_DISPATCH_PREDECESSOR_RUN_ATTEMPT: '1' } })
  assert.equal(result.handoff, 'confirmed')
  assert.equal(f.collectorPosts().length, 0) // The elapsed :07 boundary is not replayed at :07:10.
  assert.equal(f.handoffPosts()[0].time, start + 70_000)
  assert.equal(f.state.elapsed, 70_000)
})

test('cancelled, timed-out, unproven or mismatched predecessors cannot resurrect collection or handoff', async () => {
  for (const failure of ['cancelled', 'timed_out', 'proof', 'attempt', 'branch', 'repo', 'workflow', 'same-id', 'future-id']) {
    const f = fixture()
    let predecessorId = '90'
    if (failure === 'cancelled' || failure === 'timed_out') f.state.predecessor.conclusion = failure
    if (failure === 'proof') f.state.predecessorJobs.jobs[0].steps[0].conclusion = 'skipped'
    if (failure === 'attempt') f.state.predecessor.run_attempt = 2
    if (failure === 'branch') f.state.predecessor.head_branch = 'other'
    if (failure === 'repo') f.state.predecessor.repository.full_name = 'other/sf6'
    if (failure === 'workflow') f.state.predecessor.path = '.github/workflows/other.yml'
    if (failure === 'same-id') predecessorId = '100'
    if (failure === 'future-id') predecessorId = '101'
    const result = await f.run({ handoff: true, durationMs: 60_000, env: { ...env,
      STEAM_DISPATCH_PREDECESSOR_RUN_ID: predecessorId, STEAM_DISPATCH_PREDECESSOR_RUN_ATTEMPT: '1' } })
    assert.equal(result.reason, 'predecessor-rejected', failure)
    assert.equal(result.handoff, 'not-attempted')
    assert.equal(result.failed, 1)
    assert.equal(f.posts().length, 0)
    assert.ok(f.state.elapsed <= STEAM_DISPATCH_HANDOFF_MS)
  }
})

test('unpaired predecessor metadata and invalid current identity are rejected before networking', async () => {
  for (const extraEnv of [{ STEAM_DISPATCH_PREDECESSOR_RUN_ID: '90' }, { STEAM_DISPATCH_PREDECESSOR_RUN_ATTEMPT: '1' },
    { GITHUB_RUN_ID: '0' }, { GITHUB_RUN_ID: 'unsafe/path' }, { GITHUB_RUN_ATTEMPT: '0' }]) {
    const f = fixture()
    await assert.rejects(f.run({ handoff: true, env: { ...env, ...extraEnv } }))
    assert.equal(f.state.requests.length, 0)
  }
})

test('workflow exposes standard and short modes, paired predecessor inputs and an uncancelled proof step', async () => {
  const workflow = await readFile(new URL('../.github/workflows/steam-player-count-dispatch.yml', import.meta.url), 'utf8')
  assert.match(workflow, /handoff-check/)
  assert.match(workflow, /predecessor_run_id:/)
  assert.match(workflow, /predecessor_run_attempt:/)
  assert.match(workflow, /STEAM_DISPATCH_MODE:/)
  assert.match(workflow, /STEAM_DISPATCH_PREDECESSOR_RUN_ID:/)
  assert.match(workflow, /STEAM_DISPATCH_PREDECESSOR_RUN_ATTEMPT:/)
  assert.ok(workflow.includes(`name: ${STEAM_DISPATCH_HANDOFF_PROOF_STEP}`))
  assert.match(workflow, /always\(\).*cancelled\(\).*steps\.dispatch\.outputs\.handoff == 'confirmed'/)
  assert.match(workflow, /queue: single/)
  assert.match(workflow, /cancel-in-progress: false/)
})
