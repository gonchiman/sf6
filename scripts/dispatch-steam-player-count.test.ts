import test from 'node:test'
import assert from 'node:assert/strict'
import { isAllowedSteamDispatcher, nextSteamDispatchBoundary, runSteamPlayerCountDispatcher,
  STEAM_DISPATCH_DURATION_MS, STEAM_DISPATCH_INTERVAL_MS } from './dispatch-steam-player-count.ts'

const start = Date.parse('2026-11-01T00:07:00.000Z')
const env = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Linux', GITHUB_REPOSITORY: 'gonchiman/sf6',
  GITHUB_REF: 'refs/heads/main', GITHUB_WORKFLOW_REF: 'gonchiman/sf6/.github/workflows/steam-player-count-dispatch.yml@refs/heads/main',
  GITHUB_EVENT_NAME: 'schedule', GH_TOKEN: 'secret-test-token' }
type RequestRecord = { url: string; method: string; time: number; options: RequestInit | undefined }

function fixture(options: { start?: number; request?: (request: RequestRecord) => Promise<Response | void> | Response | void;
  afterWait?: (ms: number) => void } = {}) {
  const state = { wall: options.start ?? start, elapsed: 0, requests: [] as RequestRecord[], waits: [] as number[], logs: [] as string[],
    dispatcher: 'active', collector: 'active', latest: null as null | { created_at: string; head_branch: string; status: string } }
  const fetchData: typeof fetch = async (input, init) => {
    const request = { url: String(input), method: init?.method ?? 'GET', time: state.wall, options: init }
    state.requests.push(request)
    const override = await options.request?.(request)
    if (override) return override
    if (request.method === 'POST') {
      // GitHub records creation after the request; this must not lose alternate slots.
      state.latest = { created_at: new Date(state.wall + 1000).toISOString(), head_branch: 'main', status: 'completed' }
      return new Response(null, { status: 204 })
    }
    if (request.url.endsWith('steam-player-count-dispatch.yml')) return Response.json({ state: state.dispatcher })
    if (request.url.endsWith('steam-player-count.yml')) return Response.json({ state: state.collector })
    if (request.url.endsWith('/runs?branch=main&per_page=1')) return Response.json({ workflow_runs: state.latest ? [state.latest] : [] })
    assert.fail(`unexpected URL: ${request.url}`)
  }
  const run = (extra: Parameters<typeof runSteamPlayerCountDispatcher>[0] = {}) => runSteamPlayerCountDispatcher({
    env, now: () => state.wall, monotonicNow: () => state.elapsed,
    wait: async ms => { state.waits.push(ms); state.wall += ms; state.elapsed += ms; options.afterWait?.(ms) },
    fetch: fetchData, write: message => state.logs.push(message), ...extra,
  })
  const posts = () => state.requests.filter(item => item.method === 'POST')
  return { state, run, posts }
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
  f.state.latest = { created_at: new Date(start + 1000).toISOString(), head_branch: 'main', status: 'completed' }
  const result = await f.run({ durationMs: 16 * 60_000 })
  assert.equal(result.skipped, 1)
  assert.deepEqual(f.posts().map(item => item.time), [start + 15 * 60_000])
})

test('an unfinished collection prevents building a queue of new collection runs', async () => {
  const f = fixture()
  f.state.latest = { created_at: new Date(start - 60 * 60_000).toISOString(), head_branch: 'main', status: 'in_progress' }
  const result = await f.run({ durationMs: 16 * 60_000 })
  assert.equal(result.skipped, 2)
  assert.equal(f.posts().length, 0)
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
