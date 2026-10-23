import assert from 'node:assert/strict'
import test from 'node:test'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cloudConfig, DEFAULT_CLOUD_INTERVAL_OPTIONS, parseCloudRun } from '../../src/lib/parallelFetchCloud.ts'
import type { CloudRun } from '../../src/types/parallelFetchCloud.ts'
import { createCloudStateStore, createParallelFetchCloudService, PARALLEL_FETCH_CLOUD_API_PREFIX as API } from './parallel-fetch-cloud-service.ts'
import type { CloudStateStore } from './parallel-fetch-cloud-service.ts'
import { ParallelFetchCloudServiceError } from './parallel-fetch-github.ts'
import type { CloudGitHub, CloudRemoteRun } from './parallel-fetch-github.ts'

const REQUEST = '12345678-1234-4123-8123-123456789abc'
const TIME = '2026-10-21T00:00:00.000Z'
const SECRET = 'private-cookie-output-must-never-appear'
function pending(): CloudRun {
  return { requestId: REQUEST, mode: 'serial', createdAt: TIME, updatedAt: TIME, dispatchState: 'pending', runId: null,
    runAttempt: null, state: 'dispatching', startedAt: null, finishedAt: null, headSha: null, conclusion: null, report: null, error: null }
}
function remote(): CloudRemoteRun {
  return { runId: '123', runAttempt: 1, requestId: REQUEST, state: 'collecting', startedAt: TIME,
    finishedAt: null, headSha: 'a'.repeat(40), conclusion: null }
}
function fixture(saved: CloudRun[] = []) {
  let time = Date.parse(TIME), dispatched = 0, cancelled = 0, checked = 0, fetched = 0, downloads = 0
  let disk = structuredClone(saved), found: CloudRemoteRun | null = null
  const snapshots: CloudRun[][] = []
  const store: CloudStateStore = { load: async () => structuredClone(disk), save: async runs => {
    snapshots.push(structuredClone(runs)); disk = structuredClone(runs)
  } }
  const github: CloudGitHub = {
    readiness: async () => { checked++; return 'ready' },
    dispatch: async () => { assert.equal(disk[0].dispatchState, 'pending'); dispatched++ },
    findRun: async () => { fetched++; return found },
    getRun: async (id, attempt) => { fetched++; assert.equal(id, '123'); if (attempt !== undefined) assert.equal(attempt, 1); return found! },
    cancel: async id => { assert.equal(id, '123'); cancelled++ },
    readReport: async () => {
      downloads++
      return { schemaVersion: 1, runId: 'cloud-123-1-serial', config: cloudConfig('serial'), state: 'error',
        startedAt: TIME, finishedAt: TIME, trials: [], errorCode: 'authentication-unconfirmed' }
    },
  }
  const deps = { github, store, now: () => time, uuid: () => REQUEST, schedule: () => () => {} }
  const service = createParallelFetchCloudService(deps)
  return { service, deps, github, store, snapshots, setFound: (value: CloudRemoteRun | null) => { found = value },
    tick: () => { time += 16000 }, stats: () => ({ dispatched, cancelled, checked, fetched, downloads }),
    disk: () => disk,
    ready: async () => { await service.status(); await service.waitForIdle() },
    refresh: async () => { time += 16000; await service.status(); await service.waitForIdle(); return service.status() },
  }
}

test('reserves a request durably before one dispatch, correlates progress and preserves failed final reports', async () => {
  const f = fixture(); await f.ready()
  await f.service.start('serial'); await f.service.waitForIdle()
  assert.equal(f.stats().dispatched, 1)
  assert.equal(f.snapshots[0][0].dispatchState, 'pending')
  await assert.rejects(f.service.start('compare'), error => error instanceof ParallelFetchCloudServiceError && error.code === 'already-running')
  f.setFound(remote())
  let status = await f.refresh()
  assert.equal(status.runs[0].state, 'collecting'); assert.equal(status.runs[0].runId, '123')
  f.setFound({ ...remote(), state: 'completed', finishedAt: TIME, conclusion: 'failure' })
  status = await f.refresh()
  assert.equal(status.runs[0].state, 'failed')
  assert.equal(status.runs[0].report?.errorCode, 'authentication-unconfirmed')
  assert.equal(status.activeRequestId, null)
  assert.equal(f.disk()[0].report?.runId, 'cloud-123-1-serial')
  await f.service.close(); assert.equal(f.stats().cancelled, 0)
})

test('uncertain dispatch and restart reconcile the same request without submitting it again', async () => {
  const f = fixture(); await f.ready()
  let attempts = 0
  f.github.dispatch = async () => { attempts++; throw new Error(SECRET) }
  await f.service.start('serial'); await f.service.waitForIdle()
  assert.equal(f.disk()[0].dispatchState, 'uncertain')
  await f.service.retry(REQUEST); await f.service.waitForIdle()
  assert.equal(attempts, 1)
  await f.service.close()
  const restarted = createParallelFetchCloudService(f.deps)
  f.setFound(remote())
  await restarted.status(); await restarted.waitForIdle()
  const status = await restarted.status()
  assert.equal(status.runs[0].runId, '123')
  assert.equal(status.runs[0].dispatchState, 'sent')
  assert.equal(attempts, 1)
  assert.equal(JSON.stringify(status).includes(SECRET), false)
  await restarted.close()
})

test('a crash-persisted pending request becomes uncertain and is monitored without redispatch', async () => {
  const f = fixture([pending()]); f.setFound(remote()); await f.ready()
  const status = await f.service.status()
  assert.equal(f.snapshots[0][0].dispatchState, 'uncertain')
  assert.equal(status.runs[0].state, 'collecting')
  assert.equal(f.stats().dispatched, 0)
  await f.service.close()
})

test('failed persistence prevents dispatch and missing artifacts can be retried without recollection', async () => {
  const refused = fixture(); await refused.ready()
  refused.store.save = async () => { throw new Error(SECRET) }
  await assert.rejects(refused.service.start('serial'))
  assert.equal(refused.stats().dispatched, 0)
  await refused.service.close()
  const f = fixture(); await f.ready(); await f.service.start('serial'); await f.service.waitForIdle()
  f.setFound({ ...remote(), state: 'completed', conclusion: 'failure', finishedAt: TIME })
  const download = f.github.readReport
  f.github.readReport = async () => { throw new ParallelFetchCloudServiceError('artifact-missing') }
  let status = await f.refresh()
  assert.equal(status.runs[0].error, 'artifact-missing')
  f.github.readReport = download
  await f.service.retry(REQUEST); await f.service.waitForIdle()
  status = await f.service.status()
  assert.equal(status.runs[0].report?.state, 'error')
  assert.equal(f.stats().dispatched, 1)
  await f.service.close()
})

test('cancel verifies the exact run attempt, a failed cancel can be retried, and backend close never cancels', async () => {
  const f = fixture(); await f.ready(); await f.service.start('serial'); await f.service.waitForIdle()
  f.setFound(remote()); await f.refresh()
  const cancel = f.github.cancel
  f.github.cancel = async () => { throw new Error(SECRET) }
  await f.service.stop(REQUEST); await f.service.waitForIdle()
  assert.equal((await f.service.status()).runs[0].error, 'cancel-failed')
  assert.equal((await f.service.status()).runs[0].state, 'collecting')
  f.github.cancel = cancel
  f.setFound({ ...remote(), runAttempt: 2 })
  await f.service.stop(REQUEST); await f.service.waitForIdle()
  assert.equal(f.stats().cancelled, 0)
  assert.equal((await f.service.status()).runs[0].error, 'run-ambiguous')
  f.setFound(remote())
  await f.service.stop(REQUEST); await f.service.waitForIdle()
  assert.equal(f.stats().cancelled, 1)
  await f.service.close(); assert.equal(f.stats().cancelled, 1)
})

test('status returns cached data while GitHub is slow and refreshes readiness at most every 60 seconds', async () => {
  const f = fixture()
  let release!: () => void
  f.github.readiness = async () => { await new Promise<void>(resolve => { release = resolve }); return 'ready' }
  const first = await f.service.status()
  assert.equal(first.readiness, 'checking')
  await new Promise<void>(resolve => setImmediate(resolve))
  release(); await f.service.waitForIdle()
  assert.equal((await f.service.status()).readiness, 'ready')
  await f.service.close()
  const normal = fixture(); await normal.ready()
  await normal.refresh(); await normal.refresh()
  assert.equal(normal.stats().checked, 1)
  await normal.service.close()
})

async function invoke(service: ReturnType<typeof createParallelFetchCloudService>, route: string, options: {
  method?: string; token?: string; origin?: string; host?: string; remote?: string; body?: unknown
} = {}) {
  const method = options.method ?? 'GET', host = options.host ?? '127.0.0.1:5175'
  const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(options.body ?? {}))]), {
    method, url: `${API}/${route}`, headers: { host, origin: options.origin ?? `http://${host}`,
      'content-type': 'application/json', 'x-parallel-fetch-token': options.token },
    socket: { remoteAddress: options.remote ?? '127.0.0.1', localPort: 5175 },
  }) as unknown as IncomingMessage
  let body = ''; const headers: Record<string, string> = {}
  const res = { statusCode: 0, setHeader(name: string, value: string) { headers[name] = value },
    removeHeader(name: string) { delete headers[name] }, end(value: string) { body += value } } as unknown as ServerResponse
  await service.handle(req, res, () => { throw new Error('unexpected-next') })
  return { status: res.statusCode, body: JSON.parse(body), headers }
}

test('loopback/origin/token guards and exact request bodies block unintended Actions operations', async () => {
  const f = fixture(); await f.ready(); const token = (await f.service.status()).token
  for (const options of [{ token: undefined }, { origin: 'https://evil.example' }, { host: 'evil.example:5175' },
    { remote: '192.168.1.1' }, { token: '0'.repeat(64) }]) {
    assert.equal((await invoke(f.service, 'run', { method: 'POST', token, body: { mode: 'serial' }, ...options })).status, 403)
  }
  for (const body of [{}, { mode: 'other' }, { mode: 'serial', repository: SECRET }, { mode: 'serial', ref: 'other' }]) {
    assert.equal((await invoke(f.service, 'run', { method: 'POST', token, body })).status, 400)
  }
  assert.equal(f.stats().dispatched, 0)
  assert.equal((await invoke(f.service, 'run', { method: 'POST', token, body: { mode: 'serial' } })).status, 202)
  await f.service.waitForIdle()
  assert.equal(f.stats().dispatched, 1)
  await f.service.close()
})

test('persistent state reconstructs safe fields and rejects malformed state without dispatch', async t => {
  const root = await mkdtemp(join(tmpdir(), 'sf6-cloud-state-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = createCloudStateStore(root)
  const run = { ...pending(), cookies: SECRET }
  await store.save([run])
  assert.deepEqual(await store.load(), [parseCloudRun(run)])
  await store.save([{ ...run, dispatchState: 'sent', state: 'queued' }])
  assert.equal((await store.load())[0].state, 'queued')
  assert.equal((await readFile(join(root, '.local', 'parallel-fetch-cloud', 'state.json'), 'utf8')).includes(SECRET), false)
  const f = fixture(); f.store.load = async () => [{ ...pending(), report: { cookies: SECRET } } as never]
  await f.ready()
  assert.equal((await f.service.status()).error, 'state-invalid')
  await assert.rejects(f.service.start('serial'))
  assert.equal(f.stats().dispatched, 0)
  await f.service.close()
})

test('interval selection is saved before dispatch and preserved when importing an exact matching report', async () => {
  const f = fixture(); await f.ready()
  const options = { ...structuredClone(DEFAULT_CLOUD_INTERVAL_OPTIONS), concurrencies: [1, 3, 8] }
  let dispatches = 0
  f.github.dispatch = async (mode, requestId, selected) => {
    assert.equal(mode, 'interval-compare'); assert.equal(requestId, REQUEST)
    assert.deepEqual(selected, options); assert.deepEqual(f.disk()[0].options, options)
    dispatches++
  }
  f.github.readReport = async (_run, mode, selected) => {
    assert.equal(mode, 'interval-compare'); assert.deepEqual(selected, options)
    return { schemaVersion: 2, runId: 'cloud-123-1-interval-compare', config: cloudConfig(mode, selected), state: 'error',
      startedAt: TIME, finishedAt: TIME, trials: [], errorCode: 'authentication-unconfirmed' }
  }
  const token = (await f.service.status()).token
  for (const body of [{ mode: 'interval-compare' }, { mode: 'serial', options },
    { mode: 'interval-compare', options: { ...options, repetitions: 3 } },
    ...[[1, 9], [1, 0], [1, 3.5], [1, 3, 3], [3], [1, '3'], []].map(concurrencies =>
      ({ mode: 'interval-compare', options: { ...options, concurrencies } })),
    { mode: 'interval-compare', options: { ...options, raw: SECRET } }]) {
    assert.equal((await invoke(f.service, 'run', { method: 'POST', token, body })).status, 400)
  }
  assert.equal(dispatches, 0)
  assert.equal((await invoke(f.service, 'run', { method: 'POST', token,
    body: { mode: 'interval-compare', options: { ...options, concurrencies: [8, 1, 3] } } })).status, 202)
  await f.service.waitForIdle()
  f.setFound({ ...remote(), state: 'completed', conclusion: 'failure', finishedAt: TIME })
  const status = await f.refresh()
  assert.equal(status.runs[0].report?.schemaVersion, 2)
  assert.deepEqual(status.runs[0].options, options)
  assert.equal(dispatches, 1)
  await f.service.close()
  const restarted = createParallelFetchCloudService(f.deps)
  await restarted.status(); await restarted.waitForIdle()
  assert.deepEqual((await restarted.status()).runs[0].options, options)
  await restarted.retry(REQUEST); await restarted.waitForIdle()
  assert.equal(dispatches, 1)
  await restarted.close()
})
