import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, symlink, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import test from 'node:test'
import { DEFAULT_PARALLEL_FETCH_CONFIG, PARALLEL_FETCH_MAX_DURATION_MS, parseParallelFetchReport } from '../../src/lib/parallelFetch.ts'
import type { ParallelFetchConfig, ParallelFetchReadDiagnostics, ParallelFetchReport } from '../../src/types/parallelFetch.ts'
import { createParallelFetchService, createParallelFetchReportWriter, PARALLEL_FETCH_API_PREFIX as API } from './parallel-fetch-service.ts'
import { ParallelFetchReadError, runParallelFetch } from './parallel-fetch-runner.ts'
import type { ParallelFetchDependencies } from './parallel-fetch-runner.ts'

const config = (): ParallelFetchConfig => structuredClone(DEFAULT_PARALLEL_FETCH_CONFIG)
function report(value: ParallelFetchConfig, state: 'running' | 'stopped' = 'running'): ParallelFetchReport {
  return { schemaVersion: value.intervalMsList ? 2 : 1, runId: 'test-run', config: value, state, startedAt: '2026-10-20T00:00:00.000Z',
    finishedAt: state === 'running' ? null : '2026-10-20T00:00:01.000Z', trials: [], errorCode: state === 'running' ? null : 'cancelled' }
}
interface RequestOptions { method?: string; host?: string; origin?: string | null; token?: string; remote?: string; localPort?: number; body?: unknown; chunks?: Buffer[]; headers?: Record<string, string> }
test('local middleware does not intercept the separate cloud API namespace', async () => {
  const service = createParallelFetchService()
  let next = false
  await service.handle({ url: '/sf6/__parallel-fetch-cloud/status' } as IncomingMessage, {} as ServerResponse, () => { next = true })
  assert.equal(next, true)
  await service.close()
})
async function invoke(service: ReturnType<typeof createParallelFetchService>, route: string, options: RequestOptions = {}) {
  const method = options.method ?? 'GET', host = options.host ?? '127.0.0.1:5174'
  const body = options.body === undefined ? '{}' : JSON.stringify(options.body)
  const request = Object.assign(Readable.from(options.chunks ?? [Buffer.from(body)]), { method, url: `${API}/${route}`,
    headers: { host, ...(method === 'POST' ? { origin: options.origin === null ? undefined : options.origin ?? `http://${host}`,
      'content-type': 'application/json', 'x-parallel-fetch-token': options.token } : options.origin ? { origin: options.origin } : {}), ...options.headers },
    socket: { remoteAddress: options.remote ?? '127.0.0.1', localPort: options.localPort ?? 5174 } }) as unknown as IncomingMessage
  const headers: Record<string, string> = {}
  let data = '', next = false
  const response = { statusCode: 0, setHeader(name: string, value: string) { headers[name.toLowerCase()] = value },
    removeHeader(name: string) { delete headers[name.toLowerCase()] },
    end(value: string) { data += value } } as unknown as ServerResponse
  await service.handle(request, response, () => { next = true })
  return { status: response.statusCode, headers, value: data ? JSON.parse(data) : null, next }
}
function fixture() {
  let probeCount = 0, starts = 0, browserStarts = 0, cancelled = false
  const saved: ParallelFetchReport[] = []
  let finish: (() => void) | null = null
  const service = createParallelFetchService({
    sessionAvailable: async () => { probeCount++; return true },
    openBrowser: async () => { browserStarts++; throw new Error('private auth text') },
    run: async (input: ParallelFetchConfig, dependencies: ParallelFetchDependencies) => {
      starts++; dependencies.onUpdate?.(report(input))
      await new Promise<void>(resolve => {
        finish = resolve
        dependencies.signal?.addEventListener('abort', () => { cancelled = true; resolve() }, { once: true })
      })
      return { ...report(input, 'stopped'), private: 'do not return or save' } as ParallelFetchReport
    },
    saveReport: async value => { saved.push(value) },
  })
  return { service, saved, stats: () => ({ probeCount, starts, browserStarts, cancelled }), finish: () => finish?.() }
}

test('status checks availability only; user-started runs are single, stopped, and sanitized', async () => {
  const f = fixture()
  const status = await invoke(f.service, 'status')
  assert.equal(status.status, 200); assert.equal(status.value.sessionAvailable, true)
  assert.match(status.value.token, /^[a-f0-9]{64}$/)
  assert.equal(status.headers['cache-control'], 'no-store')
  assert.equal(status.headers['access-control-allow-origin'], undefined)
  assert.deepEqual(f.stats(), { probeCount: 1, starts: 0, browserStarts: 0, cancelled: false })
  const token = status.value.token
  assert.equal((await invoke(f.service, 'run', { method: 'POST', token, body: config() })).status, 202)
  assert.equal((await invoke(f.service, 'run', { method: 'POST', token, body: config() })).status, 409)
  assert.equal(f.stats().starts, 1)
  assert.equal((await invoke(f.service, 'stop', { method: 'POST', token, body: {} })).status, 202)
  await f.service.close()
  assert.equal(f.stats().cancelled, true); assert.equal(f.saved.length, 1)
  assert.equal('private' in f.saved[0], false)
  assert.equal(JSON.stringify((await invoke(f.service, 'status')).value).includes('do not return'), false)
})

test('foreign hosts, remotes, origins, missing token and cross-site writes cannot start a job', async () => {
  const f = fixture(), token = (await invoke(f.service, 'status')).value.token
  for (const options of [
    { host: 'evil.example:5174' }, { host: '127.0.0.1.evil.example:5174' }, { host: '127.0.0.2:5174' },
    { host: 'localhost:5175' }, { remote: '192.168.1.1' }, { origin: 'https://evil.example' }, { origin: 'null' },
    { origin: null }, { token: '0'.repeat(64) }, { token: undefined }, { headers: { 'sec-fetch-site': 'cross-site' } },
    { headers: { 'sec-fetch-site': 'none' } },
  ]) {
    assert.equal((await invoke(f.service, 'run', { method: 'POST', token, body: config(), ...options })).status, 403)
  }
  assert.equal(f.stats().starts, 0)
  assert.equal((await invoke(f.service, 'status', { origin: 'https://evil.example' })).status, 403)
  assert.equal((await invoke(f.service, 'status', { host: 'localhost:5174' })).status, 200)
  assert.equal((await invoke(f.service, 'status', { host: '[::1]:5174', remote: '::1' })).status, 200)
  await f.service.close()
})

test('JSON input is bounded, validated, and fixed errors disclose no arbitrary strings', async () => {
  const f = fixture(), token = (await invoke(f.service, 'status')).value.token
  const requests = [
    { body: {}, expected: 400 }, { body: { ...config(), startPage: -1, secret: 'private-cookie' }, expected: 400 },
    { chunks: [Buffer.from('{broken-private-cookie')], expected: 400 },
    { chunks: [Buffer.from([0xff])], expected: 400 },
    { headers: { 'content-type': 'text/plain' }, expected: 400 },
    { headers: { 'content-length': '4097' }, expected: 413 },
    { chunks: [Buffer.alloc(3000), Buffer.alloc(3000)], expected: 413 },
  ]
  for (const { expected, ...options } of requests) {
    const result = await invoke(f.service, 'run', { method: 'POST', token, body: config(), ...options })
    assert.equal(result.status, expected); assert.doesNotMatch(JSON.stringify(result.value), /private-cookie|cookie|auth|C:\\/)
  }
  assert.equal((await invoke(f.service, 'stop', { method: 'POST', token, body: { anything: true } })).status, 400)
  assert.equal((await invoke(f.service, 'run', { token })).status, 405)
  assert.equal(f.stats().starts, 0)
  await f.service.close()
})

test('parallel start requests reserve the one job before asynchronous work', async () => {
  const f = fixture(), token = (await invoke(f.service, 'status')).value.token
  const results = await Promise.all([1, 2, 3].map(() => invoke(f.service, 'run', { method: 'POST', token, body: config() })))
  assert.deepEqual(results.map(result => result.status).sort(), [202, 409, 409])
  assert.equal(f.stats().starts, 1)
  await f.service.close()
})

test('availability metadata is cached, shares an in-flight probe, and stays idle during a run', async () => {
  let clock = 0, probes = 0
  let release: (() => void) | null = null
  const service = createParallelFetchService({ now: () => clock, sessionAvailable: async () => {
    probes++; await new Promise<void>(resolve => { release = resolve }); return true
  } })
  const first = invoke(service, 'status'), second = invoke(service, 'status')
  assert.equal(probes, 1)
  release!(); await Promise.all([first, second])
  clock = 29999; await invoke(service, 'status'); assert.equal(probes, 1)
  clock = 30000; const refresh = invoke(service, 'status'); assert.equal(probes, 2)
  release!(); await refresh; await service.close()
  const f = fixture(), token = (await invoke(f.service, 'status')).value.token
  await invoke(f.service, 'run', { method: 'POST', token, body: config() })
  await Promise.all(Array.from({ length: 5 }, () => invoke(f.service, 'status')))
  assert.equal(f.stats().probeCount, 1)
  await f.service.close()
})

test('browser session is opened lazily once on an authorized run and is closed before saving', async () => {
  let opened = 0, closed = 0, saved = 0
  const readers: number[] = []
  let savedDone: (() => void) | null = null
  const done = new Promise<void>(resolve => { savedDone = resolve })
  const service = createParallelFetchService({ sessionAvailable: async () => true,
    openBrowser: async () => { opened++; return { createReader: async id => {
      readers.push(id); return { readPage: async (_page, navigateWithPacing) => navigateWithPacing(async () =>
        ({ totalCount: 1, totalPages: 1, httpStatus: 200 })), close: async () => {} }
    }, close: async () => { closed++ } } },
    run: async (input, dependencies) => {
      dependencies.onUpdate?.(report(input))
      await dependencies.createReader(1, 'lp', dependencies.signal!)
      await dependencies.createReader(2, 'lp', dependencies.signal!)
      return report(input, 'stopped')
    },
    saveReport: async () => { assert.equal(closed, 1); saved++; savedDone!() },
  })
  const token = (await invoke(service, 'status')).value.token
  assert.equal(opened, 0)
  await invoke(service, 'run', { method: 'POST', token, body: config() })
  await done; await service.close()
  assert.deepEqual(readers, [1, 2]); assert.equal(opened, 1); assert.equal(saved, 1)
})

test('intervals reach the shared browser and the one ten-minute deadline is not reset by the next condition', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const intervals: (number | undefined)[] = [], saved: ParallelFetchReport[] = []
  let runDependencies: ParallelFetchDependencies | undefined
  const service = createParallelFetchService({ sessionAvailable: async () => true,
    openBrowser: async () => ({ createReader: async (_worker, _target, _signal, intervalMs) => {
      intervals.push(intervalMs)
      return { readPage: async (_page, navigateWithPacing) => navigateWithPacing(async () =>
        ({ totalCount: 2000, totalPages: 100, httpStatus: 200 })), close: async () => {} }
    }, close: async () => {} }),
    run: async (input, dependencies) => {
      runDependencies = dependencies
      dependencies.onUpdate?.(report(input))
      await dependencies.createReader(1, 'lp', dependencies.signal!, 5000)
      await new Promise<void>(resolve => dependencies.signal!.addEventListener('abort', () => resolve(), { once: true }))
      return { ...report(input, 'stopped'), errorCode: (dependencies.signal!.reason as ParallelFetchReadError).code }
    }, saveReport: async value => { saved.push(value) },
  })
  const token = (await invoke(service, 'status')).value.token
  assert.equal((await invoke(service, 'run', { method: 'POST', token,
    body: { ...config(), intervalMsList: [5000, 3000] } })).status, 202)
  t.mock.timers.tick(300000)
  await runDependencies!.createReader(1, 'lp', runDependencies!.signal!, 3000)
  t.mock.timers.tick(PARALLEL_FETCH_MAX_DURATION_MS - 300000 - 1)
  assert.equal(runDependencies!.signal!.aborted, false)
  t.mock.timers.tick(1)
  assert.equal(runDependencies!.signal!.aborted, true)
  assert.equal(runDependencies!.signal!.reason.code, 'limit-reached')
  await service.close()
  assert.deepEqual(intervals, [5000, 3000])
  assert.equal(saved[0].schemaVersion, 2)
  assert.equal(saved[0].errorCode, 'limit-reached')
})

test('safe report writer saves only terminal allowlisted data and refuses overwrite', async t => {
  const root = await mkdtemp(join(tmpdir(), 'parallel-fetch-writer-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const save = createParallelFetchReportWriter(root)
  const input = { ...report(config(), 'stopped'), cookies: ['private-cookie'], url: 'https://private.example' }
  await save(input)
  const directory = join(root, '.local', 'parallel-fetch')
  const files = await readdir(directory)
  assert.deepEqual(files, ['parallel-fetch-test-run.json'])
  const text = await readFile(join(directory, files[0]), 'utf8')
  assert.doesNotMatch(text, /cookies|private-cookie|private\.example/)
  await assert.rejects(save(input), /ローカルへ保存できません/)
  await assert.rejects(save(report(config())), /ローカルへ保存できません/)
  assert.equal(await readFile(join(directory, files[0]), 'utf8'), text)
})

test('compact report storage round-trips 200 attempts with detailed failures or the retry limit', async t => {
  const root = await mkdtemp(join(tmpdir(), 'parallel-fetch-diagnostic-writer-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const save = createParallelFetchReportWriter(root)
  for (const scenario of [{ failures: 43, failureNetworkEvents: 80, state: 'complete' },
    { failures: 100, failureNetworkEvents: 8, state: 'stopped' }] as const) {
    let clock = 0, failures = 0
    const diagnostics = (failed: boolean): ParallelFetchReadDiagnostics => ({
      authenticationEvidence: failed ? null : 'logout-control', loginRequiredHeading: failed ? null : false,
      rankingReadable: failed ? null : true,
      trace: {
        observations: Array.from({ length: failed ? 0 : 8 }, () => ({ elapsedMs: 1234.123456789, phase: 'read',
          authenticationEvidence: 'conflicting-controls', loginRequiredHeading: false, rankingReadable: false, humanVerification: false })),
        network: Array.from({ length: failed ? scenario.failureNetworkEvents : 8 }, () => ({ elapsedMs: 1234.123456789,
          phase: 'read', kind: 'http-error', resource: 'stylesheet', site: 'buckler', status: 503 })),
        droppedObservations: 0, droppedNetworkEvents: 0,
      },
    })
    const input = await runParallelFetch({ ...config(), pageCount: 50, concurrencies: [1, 2, 4], intervalMs: 3000 }, {
      now: () => clock, wallNow: () => new Date(Date.parse('2026-10-20T00:00:00.000Z') + clock).toISOString(),
      wait: async milliseconds => { clock += milliseconds }, runId: `diagnostic-${scenario.failures}`,
      createReader: async () => {
        let retrying = false
        return { readPage: async (_page, navigateWithPacing) => navigateWithPacing(async () => {
          clock++
          if (!retrying && failures < scenario.failures) {
            failures++; retrying = true
            throw new ParallelFetchReadError('server-error', 503, diagnostics(true))
          }
          retrying = false
          return { totalCount: 2000, totalPages: 100, httpStatus: 200, diagnostics: diagnostics(false) }
        }), close: async () => {} }
      },
    })
    assert.equal(input.state, scenario.state)
    assert.equal(input.errorCode, scenario.state === 'stopped' ? 'limit-reached' : null)
    assert.equal(input.trials.reduce((sum, trial) => sum + trial.attempts.length, 0), 200)
    assert.equal(input.trials.flatMap(trial => trial.attempts).filter(attempt => attempt.errorCode === 'server-error').length, scenario.failures)
    if (scenario.failureNetworkEvents === 80) assert.ok(Buffer.byteLength(JSON.stringify(input, null, 2)) > 1024 * 1024)
    await save(input)
    const bytes = await readFile(join(root, '.local', 'parallel-fetch', `parallel-fetch-${input.runId}.json`))
    assert.ok(bytes.length <= 1024 * 1024)
    assert.deepEqual(parseParallelFetchReport(JSON.parse(bytes.toString('utf8'))), input)
    if (scenario.state === 'stopped') {
      // A conservative envelope: all 200 attempts retain 8+8 items, and four
      // terminal workers retain 80+80. Long valid values also fit the byte limit.
      const envelope = structuredClone(input)
      envelope.runId = 'capacity-envelope-'.padEnd(80, 'x')
      envelope.trials.flatMap(trial => trial.attempts).forEach((attempt, index) => {
        const length = index < 4 ? 80 : 8
        attempt.diagnostics = { authenticationEvidence: 'conflicting-controls', loginRequiredHeading: false, rankingReadable: false,
          trace: {
            observations: Array.from({ length }, () => ({ elapsedMs: 1.2345678901234567e-300, phase: 'after-stop',
              authenticationEvidence: 'conflicting-controls', loginRequiredHeading: false, rankingReadable: false, humanVerification: false })),
            network: Array.from({ length }, () => ({ elapsedMs: 1.2345678901234567e-300, phase: 'after-stop',
              kind: 'request-failed', resource: 'stylesheet', site: 'capcom-auth', status: null })),
            droppedObservations: Number.MAX_SAFE_INTEGER, droppedNetworkEvents: Number.MAX_SAFE_INTEGER,
            ...(index < 4 ? { postStop: { durationMs: 35000, outcome: 'human-verification' as const } } : {}),
          },
        }
      })
      await save(envelope)
      const bounded = await readFile(join(root, '.local', 'parallel-fetch', `parallel-fetch-${envelope.runId}.json`))
      assert.ok(bounded.length <= 1024 * 1024)
      assert.deepEqual(parseParallelFetchReport(JSON.parse(bounded.toString('utf8'))), envelope)
    }
  }
})

test('report writer refuses a linked private directory', async t => {
  const root = await mkdtemp(join(tmpdir(), 'parallel-fetch-link-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const outside = join(root, 'outside'); await mkdir(outside)
  try { await symlink(outside, join(root, '.local'), process.platform === 'win32' ? 'junction' : 'dir') }
  catch (error) { if (error && typeof error === 'object' && 'code' in error && ['EPERM', 'EACCES'].includes(String(error.code))) { t.skip(); return }; throw error }
  await assert.rejects(createParallelFetchReportWriter(root)(report(config(), 'stopped')), /ローカルへ保存できません/)
  assert.deepEqual(await readdir(outside), [])
})

test('service save failures expose a fixed status and shutdown prevents another run', async () => {
  const service = createParallelFetchService({ sessionAvailable: async () => false,
    run: async input => report(input, 'stopped'), saveReport: async () => { throw new Error('private C:/auth cookies') } })
  const token = (await invoke(service, 'status')).value.token
  await invoke(service, 'run', { method: 'POST', token, body: config() })
  await service.close()
  const result = await invoke(service, 'status')
  assert.equal(result.value.error, 'report-save-failed'); assert.equal(result.value.available, false)
  assert.doesNotMatch(JSON.stringify(result.value), /cookies|C:\/auth/)
  assert.equal((await invoke(service, 'run', { method: 'POST', token, body: config() })).status, 503)
})

test('unexpected runner failure preserves new interval scope and zero seconds in the saved v3 report', async () => {
  const saved: ParallelFetchReport[] = []
  let savedDone!: () => void
  const done = new Promise<void>(resolve => { savedDone = resolve })
  const service = createParallelFetchService({ sessionAvailable: async () => true,
    run: async () => { throw new Error('private runner failure') },
    saveReport: async report => { saved.push(report); savedDone() },
  })
  const token = (await invoke(service, 'status')).value.token
  const input = { ...config(), intervalMs: 0, intervalMsList: [0], intervalScope: 'per-tab' }
  assert.equal((await invoke(service, 'run', { method: 'POST', token, body: input })).status, 202)
  await done
  await service.close()
  assert.equal(saved.length, 1)
  assert.equal(saved[0].schemaVersion, 3)
  assert.equal(saved[0].errorCode, 'read-failed')
  assert.deepEqual(saved[0].config, input)
  assert.equal(JSON.stringify(saved[0]).includes('private'), false)
})
