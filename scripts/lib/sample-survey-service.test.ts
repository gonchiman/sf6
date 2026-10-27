import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { parseSampleSurveyPlan, parseSampleSurveyRun } from '../../src/lib/sampleSurvey.ts'
import type { SampleSurveyConfig, SampleSurveyPlan } from '../../src/types/sampleSurvey.ts'
import { createSampleSurveyService, SAMPLE_SURVEY_API_PREFIX as API } from './sample-survey-service.ts'
import type { SampleSurveyServiceDependencies } from './sample-survey-service.ts'
import { createSampleSurveyCheckpoint, parseSampleSurveyCheckpoint, runSampleSurvey } from './sample-survey-runner.ts'
import type { SampleSurveyCheckpoint } from './sample-survey-runner.ts'
import { SampleSurveyReadError } from './sample-survey-reader.ts'
import type { SampleSurveyReader } from './sample-survey-reader.ts'
import { createSampleSurveyStore } from './sample-survey-store.ts'

const epoch = Date.parse('2026-10-27T00:00:00.000Z')
const config = (): SampleSurveyConfig => ({ ranks: ['MASTER'], rankSampleSize: 10, includeMr: false, mrSampleSize: 10, maxDurationMinutes: 30 })
const plan = (): SampleSurveyPlan => ({ schemaVersion: 1, id: 'synthetic-plan', createdAt: new Date(epoch).toISOString(), seed: 'a'.repeat(32), config: config() })
type Service = ReturnType<typeof createSampleSurveyService>
interface RequestOptions {
  method?: string; host?: string; origin?: string | null; token?: string; remote?: string; localPort?: number
  body?: unknown; chunks?: Buffer[]; headers?: Record<string, string>
}
async function invoke(service: Service, route: string, options: RequestOptions = {}) {
  const method = options.method ?? 'GET', host = options.host ?? '127.0.0.1:5174'
  const body = options.body === undefined ? '{}' : JSON.stringify(options.body)
  const request = Object.assign(Readable.from(options.chunks ?? [Buffer.from(body)]), { method, url: `${API}/${route}`,
    headers: { host, ...(method === 'POST' ? { origin: options.origin === null ? undefined : options.origin ?? `http://${host}`,
      'content-type': 'application/json', 'x-parallel-fetch-token': options.token } : options.origin ? { origin: options.origin } : {}), ...options.headers },
    socket: { remoteAddress: options.remote ?? '127.0.0.1', localPort: options.localPort ?? 5174 } }) as unknown as IncomingMessage
  const headers: Record<string, string> = {}
  let data = '', next = false
  const response = { statusCode: 0, setHeader(name: string, value: string) { headers[name.toLowerCase()] = value },
    removeHeader(name: string) { delete headers[name.toLowerCase()] }, end(value: string) { data += value } } as unknown as ServerResponse
  await service.handle(request, response, () => { next = true })
  return { status: response.statusCode, headers, value: data ? JSON.parse(data) : null, next }
}
const post = (service: Service, route: string, token: string, body: unknown) => invoke(service, route, { method: 'POST', token, body })
function memoryStore() {
  const plans = new Map<string, SampleSurveyPlan>(), checkpoints = new Map<string, SampleSurveyCheckpoint>()
  const events: string[] = []
  let closed = false, failReads = false
  let failSave: ((value: SampleSurveyCheckpoint) => boolean) | undefined
  const read = () => { if (closed || failReads) throw new Error('private storage path and account 999999') }
  const store: NonNullable<SampleSurveyServiceDependencies['store']> = {
    savePlan(value) { read(); const parsed = parseSampleSurveyPlan(value); plans.set(parsed.id, parsed) },
    listPlans() { read(); return [...plans.values()].map(value => structuredClone(value)) },
    saveRun(value) {
      read(); const parsed = parseSampleSurveyCheckpoint(value)
      if (failSave?.(parsed)) throw new Error('private storage path and account 999999')
      checkpoints.set(parsed.report.id, structuredClone(parsed)); events.push(`saved:${parsed.report.state}:${parsed.report.stopReason}`)
    },
    listRuns() { read(); return [...checkpoints.values()].map(value => parseSampleSurveyRun(value.report)) },
    loadRun(id) { read(); return checkpoints.has(id) ? structuredClone(checkpoints.get(id)!) : null },
    close() { assert.equal(closed, false); closed = true; events.push('store:closed') },
  }
  return { store, checkpoints, plans, events, breakReads: () => { failReads = true },
    failSave: (value: typeof failSave) => { failSave = value } }
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
function heldRun() {
  const memory = memoryStore(), entered = deferred(), readerClosed = deferred()
  let opened = 0, started = 0, probes = 0
  const service = createSampleSurveyService({ store: memory.store, now: () => epoch,
    sessionAvailable: async () => { probes++; return true },
    openReader: async () => { opened++; return { readPage: async () => { throw new Error('not used') },
      close: async () => { memory.events.push('reader:closed'); readerClosed.resolve() } } },
    run: async (_value, options) => {
      started++; entered.resolve()
      await new Promise<void>(resolve => {
        options.signal.addEventListener('abort', () => resolve(), { once: true })
        if (options.signal.aborted) resolve()
      })
      throw options.signal.reason
    },
  })
  return { service, memory, entered, readerClosed, stats: () => ({ opened, started, probes }) }
}
async function savePlan(service: Service) {
  const status = await invoke(service, 'status'), token = status.value.token as string
  const saved = await post(service, 'plan', token, config())
  assert.equal(saved.status, 202)
  return { token, planId: saved.value.plans[0].id as string }
}

test('status and plan creation never open a reader; only aggregate status and matching routes are served', async () => {
  const f = heldRun()
  let next = false
  await f.service.handle({ url: '/sf6/__parallel-fetch/status' } as IncomingMessage, {} as ServerResponse, () => { next = true })
  assert.equal(next, true)
  const status = await invoke(f.service, 'status')
  assert.equal(status.status, 200); assert.equal(status.value.available, true); assert.equal(status.value.sessionAvailable, true)
  assert.match(status.value.token, /^[a-f0-9]{64}$/)
  assert.equal(status.headers['cache-control'], 'no-store')
  assert.equal(status.headers['access-control-allow-origin'], undefined)
  await savePlan(f.service)
  assert.deepEqual(f.stats(), { opened: 0, started: 0, probes: 1 })
  assert.equal(f.memory.plans.size, 1)
  assert.doesNotMatch(JSON.stringify(status.value), /accountId|checkpoint|cookies|private storage/)
  await f.service.close()
})

test('same-host origin, loopback address, token, JSON size and action validation guard every write', async () => {
  const f = heldRun(), token = (await invoke(f.service, 'status')).value.token
  for (const options of [
    { host: 'evil.example:5174' }, { host: '127.0.0.1.evil.example:5174' }, { host: 'localhost:5175' },
    { remote: '192.168.1.1' }, { origin: 'https://evil.example' }, { origin: 'null' }, { origin: null },
    { token: '0'.repeat(64) }, { token: undefined }, { headers: { 'sec-fetch-site': 'cross-site' } },
  ]) assert.equal((await invoke(f.service, 'plan', { method: 'POST', token, body: config(), ...options })).status, 403)
  for (const options of [
    { body: { ...config(), private: 'private-cookie' }, status: 400 },
    { chunks: [Buffer.from('{private-cookie')], status: 400 },
    { chunks: [Buffer.from([0xff])], status: 400 },
    { headers: { 'content-type': 'text/plain' }, status: 400 },
    { headers: { 'content-length': '4097' }, status: 413 },
    { chunks: [Buffer.alloc(3000), Buffer.alloc(3000)], status: 413 },
  ]) {
    const result = await invoke(f.service, 'plan', { method: 'POST', token, body: config(), ...options })
    assert.equal(result.status, options.status)
    assert.doesNotMatch(JSON.stringify(result.value), /private-cookie|999999|C:\\/)
  }
  assert.equal((await invoke(f.service, 'status', { origin: 'https://evil.example' })).status, 403)
  assert.equal((await invoke(f.service, 'status', { host: 'localhost:5174' })).status, 200)
  assert.equal((await invoke(f.service, 'status', { host: '[::1]:5174', remote: '::1' })).status, 200)
  assert.equal((await invoke(f.service, 'run')).status, 405)
  assert.equal((await post(f.service, 'stop', token, { runId: '../outside' })).status, 400)
  assert.equal((await post(f.service, 'stop', token, { runId: 'unknown' })).status, 404)
  assert.equal(f.stats().opened, 0)
  await f.service.close()
})

test('concurrent starts reserve a single reader; stop closes it and prevents duplicate plan runs', async () => {
  const f = heldRun(), { token, planId } = await savePlan(f.service)
  const responses = await Promise.all([1, 2, 3].map(() => post(f.service, 'run', token, { planId })))
  assert.deepEqual(responses.map(value => value.status).sort(), [202, 409, 409])
  await f.entered.promise
  assert.equal(f.stats().opened, 1); assert.equal(f.stats().started, 1)
  const running = (await invoke(f.service, 'status')).value
  assert.equal(running.activeRunId, running.runs[0].id)
  assert.equal((await post(f.service, 'stop', token, { runId: running.activeRunId })).status, 202)
  await f.readerClosed.promise
  const stopped = (await invoke(f.service, 'status')).value
  assert.equal(stopped.activeRunId, null)
  assert.equal(stopped.runs[0].stopReason, 'cancelled'); assert.equal(stopped.runs[0].resumeAllowed, true)
  const duplicate = await post(f.service, 'run', token, { planId })
  assert.equal(duplicate.status, 409); assert.equal(duplicate.value.error, 'already-started')
  await f.service.close()
})

test('stop remains available when storage fails, and the terminal memory report wins over the stored active report', async () => {
  const f = heldRun(), { token, planId } = await savePlan(f.service)
  await post(f.service, 'run', token, { planId }); await f.entered.promise
  const runId = (await invoke(f.service, 'status')).value.activeRunId
  f.memory.breakReads()
  const response = await post(f.service, 'stop', token, { runId })
  assert.equal(response.status, 202)
  await f.readerClosed.promise
  const status = (await invoke(f.service, 'status')).value
  assert.equal(status.available, false); assert.equal(status.error, 'storage-error'); assert.equal(status.activeRunId, null)
  assert.equal(status.runs[0].state, 'stopped'); assert.equal(status.runs[0].stopReason, 'cancelled')
  assert.doesNotMatch(JSON.stringify(status), /999999|private storage|accountId/)
  assert.equal(f.memory.checkpoints.get(runId)!.report.state, 'preparing')
  await f.service.close()
})

test('closing is idempotent, blocks new starts, and persists interruption before closing storage', async () => {
  const f = heldRun(), { token, planId } = await savePlan(f.service)
  await post(f.service, 'run', token, { planId }); await f.entered.promise
  const first = f.service.close(), second = f.service.close()
  assert.equal(first, second)
  const response = await post(f.service, 'run', token, { planId })
  assert.equal(response.status, 503); assert.equal(response.value.error, 'service-closed')
  await first
  assert.equal(f.memory.events.at(-1), 'store:closed')
  assert.ok(f.memory.events.indexOf('saved:stopped:interrupted') < f.memory.events.indexOf('reader:closed'))
  assert.ok(f.memory.events.indexOf('reader:closed') < f.memory.events.indexOf('store:closed'))
  const status = (await invoke(f.service, 'status')).value
  assert.equal(status.error, 'service-closed'); assert.equal(status.runs[0].stopReason, 'interrupted')
})

test('authentication failure through the actual runner is terminal and cannot resume', async () => {
  const memory = memoryStore(), closed = deferred()
  let reads = 0
  const service = createSampleSurveyService({ store: memory.store, now: () => epoch, sessionAvailable: async () => true,
    openReader: async () => ({ readPage: async () => { reads++; throw new SampleSurveyReadError('authentication-unconfirmed') }, close: async () => { closed.resolve() } }),
  })
  const { token, planId } = await savePlan(service)
  await post(service, 'run', token, { planId }); await closed.promise
  const status = (await invoke(service, 'status')).value, report = status.runs[0]
  assert.equal(reads, 1); assert.equal(report.state, 'error'); assert.equal(report.stopReason, 'authentication-unconfirmed')
  assert.equal(report.resumeAllowed, false)
  const response = await post(service, 'resume', token, { runId: report.id })
  assert.equal(response.status, 409); assert.equal(response.value.error, 'not-resumable')
  await service.close()
})

function syntheticReader(now: () => number, close: () => void): SampleSurveyReader {
  return { async readPage(target, page) {
    assert.equal(target, 'lp'); assert.equal(page, 1)
    return { target, page, pageSize: 20, totalCount: 20, totalPages: 1, observedAt: new Date(now()).toISOString(),
      entries: Array.from({ length: 20 }, (_, index) => ({ accountId: String(100000 + index), value: 25000 + index, rankId: 36 })) }
  }, async close() { close() } }
}
function stoppedSelection(): SampleSurveyCheckpoint {
  const value = createSampleSurveyCheckpoint(plan(), epoch)
  value.frames = [{ target: 'lp', totalCount: 20, pageSize: 20, totalPages: 1, checkedAt: new Date(epoch).toISOString(),
    ranges: [{ stratumId: 'lp-MASTER', start: 0, end: 20 }] }]
  value.slots = Array.from({ length: 10 }, (_, position) => ({ id: `lp-MASTER:${position}`, target: 'lp', stratumId: 'lp-MASTER',
    position, page: 1, rowIndex: position, status: position === 0 ? 'collected' : 'pending',
    accountId: position === 0 ? '100000' : null, value: position === 0 ? 25000 : null, rankId: position === 0 ? 36 : null,
    observedAt: position === 0 ? new Date(epoch).toISOString() : null, reason: null }))
  Object.assign(value.report, { state: 'stopped', phase: 'sampling', finishedAt: new Date(epoch).toISOString(),
    attempts: 1, successfulPages: 1, uniqueAccountCount: 1, stopReason: 'cancelled', resumeAllowed: true })
  Object.assign(value.report.strata[0], { population: 20, selected: 10, processed: 1, succeeded: 1, mean: 25000, min: 25000, max: 25000 })
  return parseSampleSurveyCheckpoint(value)
}

test('resume reaches the actual runner with a stopped checkpoint, preserves selected slots and prior observations', async () => {
  const memory = memoryStore(), previous = stoppedSelection(), closed = deferred()
  memory.store.savePlan(previous.plan); memory.store.saveRun(previous)
  let clock = epoch + 1000, calls = 0
  const service = createSampleSurveyService({ store: memory.store, now: () => clock, sessionAvailable: async () => true,
    openReader: async () => syntheticReader(() => clock, closed.resolve),
    run: async (value, options) => {
      calls++; assert.equal(options.checkpoint!.report.state, 'stopped'); assert.equal(options.checkpoint!.report.resumeAllowed, true)
      return runSampleSurvey(value, { ...options, wait: async milliseconds => { clock += milliseconds } })
    },
  })
  const token = (await invoke(service, 'status')).value.token
  assert.equal((await post(service, 'resume', token, { runId: previous.report.id })).status, 202)
  await closed.promise
  const result = memory.store.loadRun(previous.report.id)!
  assert.equal(calls, 1); assert.equal(result.report.state, 'complete')
  assert.deepEqual(result.slots.map(slot => slot.id), previous.slots.map(slot => slot.id))
  assert.deepEqual(result.slots[0], previous.slots[0])
  assert.equal(result.report.uniqueAccountCount, 10)
  assert.equal(result.report.attempts, 4) // Includes fresh confirmation of the saved boundary.
  const status = (await invoke(service, 'status')).value
  assert.equal(status.runs[0].state, 'complete'); assert.equal(status.activeRunId, null)
  assert.doesNotMatch(JSON.stringify(status), /accountId|100000|observedAt|rowIndex/)
  await service.close()
})

test('failed terminal writes retain a storage-error report in memory instead of appearing active forever', async () => {
  const memory = memoryStore(), closed = deferred()
  memory.failSave(value => value.report.state === 'complete' || value.report.state === 'error')
  let clock = epoch
  const service = createSampleSurveyService({ store: memory.store, now: () => clock, sessionAvailable: async () => true,
    openReader: async () => syntheticReader(() => clock, closed.resolve),
    run: (value, options) => runSampleSurvey(value, { ...options, wait: async milliseconds => { clock += milliseconds } }),
  })
  const { token, planId } = await savePlan(service)
  await post(service, 'run', token, { planId }); await closed.promise
  const status = (await invoke(service, 'status')).value
  assert.equal(status.error, 'storage-error'); assert.equal(status.activeRunId, null); assert.equal(status.available, false)
  assert.equal(status.runs[0].state, 'error'); assert.equal(status.runs[0].stopReason, 'storage-error')
  assert.equal(status.runs[0].resumeAllowed, false)
  assert.equal(memory.store.listRuns()[0].state, 'running')
  assert.doesNotMatch(JSON.stringify(status), /private storage|999999|accountId/)
  await service.close()
})

test('opening SQLite after a previous process ended marks orphaned active work interrupted without opening a reader', async t => {
  const root = mkdtempSync(join(tmpdir(), 'sf6-sample-service-'))
  let service: Service | null = null
  t.after(async () => {
    await service?.close()
    const absolute = resolve(root), temporary = resolve(tmpdir())
    assert.equal(dirname(absolute), temporary); assert.ok(absolute.startsWith(join(temporary, 'sf6-sample-service-')))
    rmSync(absolute, { recursive: true, force: true })
  })
  const original = createSampleSurveyStore(root), checkpoint = createSampleSurveyCheckpoint(plan(), epoch)
  original.saveRun(checkpoint); original.close()
  let opened = 0
  service = createSampleSurveyService({ root, now: () => epoch + 1000, sessionAvailable: async () => false,
    openReader: async () => { opened++; throw new Error('must stay idle') } })
  const status = (await invoke(service, 'status')).value
  assert.equal(status.activeRunId, null); assert.equal(status.runs[0].state, 'stopped')
  assert.equal(status.runs[0].stopReason, 'interrupted'); assert.equal(status.runs[0].resumeAllowed, true)
  assert.equal(opened, 0)
  await service.close()
  const reopened = createSampleSurveyStore(root)
  try { assert.equal(reopened.loadRun(checkpoint.report.id)!.report.stopReason, 'interrupted') }
  finally { reopened.close() }
})
