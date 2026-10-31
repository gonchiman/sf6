import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectSteamPlayerCount, isAllowedSteamWorkflow, parseSteamPlayerCountResponse, writeSteamObservation } from './collect-steam-player-count.ts'
import { STEAM_PLAYER_COUNT_SOURCE_URL } from '../src/lib/steamPlayerCount.ts'

const response = (player_count = 12345) => Response.json({ response: { player_count, result: 1 } })
const timestamp = '2026-10-31T10:07:12.000Z'
const now = () => new Date(timestamp)
const allowed = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Linux', GITHUB_REPOSITORY: 'gonchiman/sf6',
  GITHUB_REF: 'refs/heads/main', GITHUB_WORKFLOW_REF: 'gonchiman/sf6/.github/workflows/steam-player-count.yml@refs/heads/main',
  GITHUB_EVENT_NAME: 'schedule', GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '2' }

test('collects exactly the official public API and timestamps actual response completion', async () => {
  const times = ['2026-10-31T10:07:59.000Z', '2026-10-31T10:08:02.000Z']
  const observation = await collectSteamPlayerCount({ env: allowed, now: () => new Date(times.shift()!), fetch: async (url, options) => {
    assert.equal(url, STEAM_PLAYER_COUNT_SOURCE_URL)
    assert.equal(options?.credentials, 'omit')
    assert.equal(options?.redirect, 'error')
    return response(0)
  } })
  assert.deepEqual(observation, { id: 'steam-123-2', requestStartedAt: '2026-10-31T10:07:59.000Z', observedAt: '2026-10-31T10:08:02.000Z',
    playerCount: 0, runId: '123', runAttempt: 2 })
})

test('local single collection needs no secret and uses independent observation identity', async () => {
  const observation = await collectSteamPlayerCount({ env: {}, now, uuid: () => 'local-test', fetch: async () => response() })
  assert.equal(observation.runId, null)
  assert.equal(observation.runAttempt, null)
  assert.match(observation.id, /^observation-2026-10-31T10-07-12-000Z-local-test$/)
})

test('retries transient failures only and uses the successful request time', async () => {
  let calls = 0
  const waits: number[] = []
  const observation = await collectSteamPlayerCount({ env: {}, now, wait: async ms => { waits.push(ms) }, fetch: async () => {
    calls++
    if (calls === 1) throw new Error('temporary transport error')
    if (calls === 2) return new Response('', { status: 503 })
    return response(321)
  } })
  assert.equal(observation.playerCount, 321)
  assert.equal(calls, 3)
  assert.deepEqual(waits, [500, 1000])
})

test('honors short Retry-After seconds and stops instead of shortening long backoffs', async () => {
  for (const header of ['120', 'Sat, 31 Oct 2026 10:09:12 GMT']) {
    let calls = 0
    await assert.rejects(collectSteamPlayerCount({ env: {}, now, wait: async () => assert.fail('must not wait then retry early'),
      fetch: async () => { calls++; return new Response('', { status: 429, headers: { 'Retry-After': header } }) } }), /http/)
    assert.equal(calls, 1)
  }
  const waits: number[] = []
  let calls = 0
  await collectSteamPlayerCount({ env: {}, now, wait: async ms => { waits.push(ms) }, fetch: async () => ++calls === 1
    ? new Response('', { status: 429, headers: { 'Retry-After': '3' } }) : response() })
  assert.deepEqual(waits, [3000])
})

test('permanent HTTP failure and invalid payload never become zero or trigger extra requests', async () => {
  for (const failure of [new Response('', { status: 403 }), Response.json({ response: { result: 2, player_count: 0 } }),
    Response.json({ response: { result: 1, player_count: -1 } }), new Response('not json'), new Response('x'.repeat(17 * 1024))]) {
    let calls = 0
    await assert.rejects(collectSteamPlayerCount({ env: {}, now, fetch: async () => { calls++; return failure }, wait: async () => {} }))
    assert.equal(calls, 1)
  }
  for (const value of [null, {}, { response: { result: 1, player_count: '0' } }, { response: { result: 1, player_count: 1.5 } }]) {
    assert.throws(() => parseSteamPlayerCountResponse(value))
  }
})

test('deadline bounds stalled transports, including body reads, with at most three attempts', async () => {
  for (const mode of ['fetch', 'body']) {
    let calls = 0
    const started = Date.now()
    await assert.rejects(collectSteamPlayerCount({ env: {}, now, timeoutMs: 5, wait: async () => {}, fetch: async () => {
      calls++
      if (mode === 'fetch') return new Promise<Response>(() => {})
      return new Response(new ReadableStream({ start() {} }))
    } }), /network/)
    assert.equal(calls, 3)
    assert.ok(Date.now() - started < 1000)
  }
})

test('workflow execution is constrained to the fixed repository, main, runner and workflow', async () => {
  assert.equal(isAllowedSteamWorkflow(allowed), true)
  for (const [key, value] of Object.entries({ GITHUB_REF: 'refs/heads/other', GITHUB_REPOSITORY: 'fork/sf6', RUNNER_OS: 'Windows',
    GITHUB_WORKFLOW_REF: 'other', GITHUB_EVENT_NAME: 'pull_request', GITHUB_RUN_ID: 'bad', GITHUB_RUN_ATTEMPT: '0' })) {
    await assert.rejects(collectSteamPlayerCount({ env: { ...allowed, [key]: value }, fetch: async () => { assert.fail('must reject before networking') } }), /runner/)
  }
})

test('writes only a validated observation and refuses to overwrite previous output', async t => {
  const root = await mkdtemp(join(tmpdir(), 'sf6-steam-collect-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const observation = await collectSteamPlayerCount({ env: {}, now, fetch: async () => response() })
  const path = await writeSteamObservation(root, observation)
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), observation)
  await assert.rejects(writeSteamObservation(root, observation), /output/)
})
