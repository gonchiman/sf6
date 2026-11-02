import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectSteamPlayerCount, collectSteamPlayerCounts, isAllowedSteamWorkflow, parseSteamPlayerCountBatch,
  parseSteamPlayerCountCapture, parseSteamPlayerCountResponse, writeSteamObservation, writeSteamPlayerCountBatch } from './collect-steam-player-count.ts'
import { STEAM_PLAYER_COUNT_SOURCE_URL } from '../src/lib/steamPlayerCount.ts'
import { STEAM_PLAYER_COUNT_GAMES } from '../src/lib/steamPlayerCountGames.ts'
import type { SteamPlayerCountAppId } from '../src/types/steamPlayerCount.ts'

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
      fetch: async () => { calls++; return new Response('', { status: 429, headers: { 'Retry-After': header } }) } }), /backoff/)
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

test('single-game collection uses the selected registered source and rejects unknown IDs before fetching', async () => {
  for (const game of STEAM_PLAYER_COUNT_GAMES) {
    const observation = await collectSteamPlayerCount({ appId: game.appId, env: allowed, now, fetch: async url => {
      assert.equal(url, game.sourceUrl)
      return response(game.appId)
    } })
    assert.equal(observation.playerCount, game.appId)
    assert.equal(observation.id, game.key === 'sf6' ? 'steam-123-2' : `steam-${game.appId}-123-2`)
  }
  await assert.rejects(collectSteamPlayerCount({ appId: 440 as SteamPlayerCountAppId, fetch: async () => assert.fail('unknown game must not fetch') }))
})

test('batch collection stays sequential, retains four successes after one game exhausts retries, and saves safe failure state', async t => {
  const root = await mkdtemp(join(tmpdir(), 'sf6-steam-batch-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const urls: string[] = [], waits: number[] = []
  let active = 0, maxActive = 0
  const batch = await collectSteamPlayerCounts({ env: allowed, now, wait: async ms => { waits.push(ms) }, fetch: async url => {
    urls.push(String(url)); active++; maxActive = Math.max(maxActive, active)
    await Promise.resolve()
    active--
    return String(url).includes('appid=1778820') ? new Response('private upstream error body', { status: 503 }) : response(0)
  } })
  assert.equal(maxActive, 1)
  assert.equal(urls.length, 7)
  assert.equal(batch.results.filter(item => item.status === 'succeeded').length, 4)
  assert.deepEqual(batch.results[1], { appId: 1778820, status: 'failed', errorCode: 'http' })
  assert.deepEqual(waits, [500, 1000])
  const output = await writeSteamPlayerCountBatch(root, batch), text = await readFile(output, 'utf8')
  assert.doesNotMatch(text, /private upstream/)
  assert.deepEqual(parseSteamPlayerCountBatch(JSON.parse(text)), batch)
  assert.equal(batch.results[4].status, 'succeeded')
  await assert.rejects(writeSteamPlayerCountBatch(root, batch), /output/)
})

test('all-game failure keeps five failure records with no fabricated observations and a strict request bound', async () => {
  let calls = 0
  const batch = await collectSteamPlayerCounts({ env: {}, now, wait: async () => {}, fetch: async () => {
    calls++; throw new Error('sensitive transport diagnostic')
  } })
  assert.equal(calls, 15)
  assert.ok(batch.results.every(result => result.status === 'failed' && result.errorCode === 'network'))
  assert.doesNotMatch(JSON.stringify(batch), /playerCount|sensitive/)
})

test('capture/batch validators reject swapped games, URLs, duplicate games, foreign runs and extra failure payload', async () => {
  const valid = await collectSteamPlayerCounts({ env: allowed, now, fetch: async () => response() })
  const capture = valid.results[1].status === 'succeeded' ? valid.results[1].capture : assert.fail()
  assert.throws(() => parseSteamPlayerCountCapture(capture, 1364780))
  assert.throws(() => parseSteamPlayerCountCapture({ ...capture, sourceUrl: STEAM_PLAYER_COUNT_SOURCE_URL }))
  const duplicate = structuredClone(valid); duplicate.results[1] = duplicate.results[0]
  assert.throws(() => parseSteamPlayerCountBatch(duplicate))
  const swapped = structuredClone(valid); swapped.results[0] = { ...valid.results[1], appId: 1364780 }
  assert.throws(() => parseSteamPlayerCountBatch(swapped))
  assert.throws(() => parseSteamPlayerCountBatch({ ...valid, runId: '999' }))
  assert.throws(() => parseSteamPlayerCountBatch({ ...valid, results: [{ appId: 1364780, status: 'failed', errorCode: 'http', playerCount: 0 }, ...valid.results.slice(1)] }))
})

test('single non-SF6 output includes a validated game envelope while legacy SF6 remains unchanged', async t => {
  const root = await mkdtemp(join(tmpdir(), 'sf6-steam-game-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const observation = await collectSteamPlayerCount({ appId: 1778820, env: {}, now, fetch: async () => response(5) })
  const path = await writeSteamObservation(root, observation, 1778820)
  const capture = parseSteamPlayerCountCapture(JSON.parse(await readFile(path, 'utf8')), 1778820)
  assert.equal(capture.observation.playerCount, 5)
  assert.equal(capture.appId, 1778820)
})

test('shared-host backoff stops remaining games after long Retry-After or exhausted 429 attempts', async () => {
  for (const scenario of [{ status: 429, retryAfter: '120', expectedCalls: 2 }, { status: 503, retryAfter: '120', expectedCalls: 2 },
    { status: 429, retryAfter: null, expectedCalls: 4 }, { status: 503, retryAfter: '2', expectedCalls: 4 }]) {
    let calls = 0
    const batch = await collectSteamPlayerCounts({ env: {}, now, wait: async () => {}, fetch: async () => {
      calls++
      if (calls === 1) return response(100)
      return new Response('', { status: scenario.status, headers: scenario.retryAfter ? { 'Retry-After': scenario.retryAfter } : {} })
    } })
    assert.equal(calls, scenario.expectedCalls)
    assert.equal(batch.results[0].status, 'succeeded')
    assert.ok(batch.results.slice(1).every(result => result.status === 'failed' && result.errorCode === 'backoff'))
  }
})
