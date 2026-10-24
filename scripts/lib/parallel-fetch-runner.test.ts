import assert from 'node:assert/strict'
import test from 'node:test'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { parseParallelFetchReport, summarizeParallelFetch } from '../../src/lib/parallelFetch.ts'
import type { ParallelFetchConfig, ParallelFetchReadDiagnostics, ParallelFetchReport } from '../../src/types/parallelFetch.ts'
import { ParallelFetchReadError, runParallelFetch } from './parallel-fetch-runner.ts'
import type { ParallelFetchDependencies, ParallelFetchReader } from './parallel-fetch-runner.ts'

const config: ParallelFetchConfig = { target: 'lp', startPage: 7, pageCount: 20, concurrencies: [1, 2], repetitions: 1, intervalMs: 5000 }

class Clock {
  time = 0
  afterFinish?: () => void
  private timers = new Set<{ at: number; finish(): void }>()
  now = () => this.time
  wallNow = () => new Date(Date.UTC(2026, 0, 1) + this.time).toISOString()
  wait = (milliseconds: number, signal: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error('aborted')); return }
    const remove = () => { this.timers.delete(timer); signal.removeEventListener('abort', abort) }
    const timer = { at: this.time + milliseconds, finish: () => { remove(); resolve() } }
    const abort = () => { remove(); reject(new Error('aborted')) }
    signal.addEventListener('abort', abort, { once: true })
    this.timers.add(timer)
  })
  async finish<T>(promise: Promise<T>): Promise<T> {
    let done = false
    const result = promise.then(value => { done = true; return value }, error => { done = true; throw error })
    for (let turns = 0; !done && turns < 5000; turns += 1) {
      await nextTurn()
      if (this.timers.size) {
        this.time = Math.min(...[...this.timers].map(timer => timer.at))
        for (const timer of [...this.timers]) if (timer.at <= this.time) timer.finish()
      }
    }
    assert.ok(done, 'virtual run must finish without an unresolved queue')
    const value = await result
    this.afterFinish?.()
    return value
  }
}

interface ReadEvent { instance: number; worker: number; page: number; occurrence: number; started: number }
function fixture(options: {
  latency?: number | ((event: ReadEvent) => number)
  outcome?(event: ReadEvent): Awaited<ReturnType<ParallelFetchReader['readPage']>>
} = {}) {
  const clock = new Clock()
  const reads: ReadEvent[] = []
  const closed: number[] = []
  const signals: AbortSignal[] = []
  const updates: ParallelFetchReport[] = []
  clock.afterFinish = () => {
    for (const snapshot of updates) assert.deepEqual(parseParallelFetchReport(snapshot), snapshot)
  }
  let instances = 0, active = 0, peak = 0
  const dependencies: ParallelFetchDependencies = {
    runId: 'synthetic-run', now: clock.now, wallNow: clock.wallNow, wait: clock.wait,
    onUpdate: report => { updates.push(report) },
    createReader: async (worker, _target, signal): Promise<ParallelFetchReader> => {
      const instance = ++instances
      const occurrences = new Map<number, number>()
      signals.push(signal)
      let busy = false
      return {
        readPage: async (page, navigateWithPacing) => {
          assert.equal(busy, false, 'one reader is never used concurrently')
          busy = true
          return navigateWithPacing(async () => {
            active += 1
            peak = Math.max(peak, active)
            const occurrence = (occurrences.get(page) ?? 0) + 1
            occurrences.set(page, occurrence)
            const event = { instance, worker, page, occurrence, started: clock.time }
            reads.push(event)
            try {
              await clock.wait(typeof options.latency === 'function' ? options.latency(event) : options.latency ?? 12000, signal)
              return options.outcome?.(event) ?? { totalCount: 2000, totalPages: 100, httpStatus: 200 }
            } finally { busy = false; active -= 1 }
          })
        },
        close: async () => { closed.push(instance) },
      }
    },
  }
  return { clock, reads, closed, signals, updates, dependencies, peak: () => peak, active: () => active }
}

test('uses the same exact target pages, fresh readers and one global interval across trials', async () => {
  const f = fixture()
  const report = await f.clock.finish(runParallelFetch(config, f.dependencies))
  assert.equal(report.state, 'complete')
  assert.equal(f.peak(), 2)
  assert.deepEqual(f.closed, [1, 2, 3])
  const targets = Array.from({ length: 20 }, (_, index) => index + 7)
  for (const trial of report.trials) {
    assert.deepEqual(trial.completedPages, targets)
    assert.deepEqual(trial.attempts.filter(attempt => attempt.phase === 'measure').map(attempt => attempt.page).sort((a, b) => a - b), targets)
    assert.equal(trial.attempts.filter(attempt => attempt.phase === 'prepare').length, trial.concurrency)
    assert.ok(trial.measurementMs! > 0)
    assert.ok(trial.totalMs >= trial.preparationMs! + trial.measurementMs!)
  }
  for (let index = 1; index < f.reads.length; index += 1) assert.ok(f.reads[index].started - f.reads[index - 1].started >= 5000)
  assert.equal(f.reads.length, 43)
  assert.deepEqual(parseParallelFetchReport(report), report)
})

test('per-tab intervals preserve preparation clocks and allow fresh tabs to start together', async () => {
  const f = fixture({ latency: 25 })
  const report = await f.clock.finish(runParallelFetch({ ...config, intervalScope: 'per-tab',
    intervalMs: 1000, intervalMsList: [1000], concurrencies: [1, 3, 8] }, f.dependencies))
  assert.equal(report.state, 'complete')
  assert.equal(report.schemaVersion, 3)
  assert.equal(report.config.intervalScope, 'per-tab')
  assert.equal(f.peak(), 8)
  for (let instance = 1; instance <= 12; instance++) {
    const reads = f.reads.filter(read => read.instance === instance)
    assert.equal(reads[1].started - reads[0].started, 1000, 'preparation start remains the tab clock for measurement')
    for (let index = 1; index < reads.length; index++) assert.ok(reads[index].started - reads[index - 1].started >= 1000)
  }
  const three = f.reads.filter(read => read.instance >= 2 && read.instance <= 4 && read.page === 1)
  assert.deepEqual(three.map(read => read.worker), [1, 2, 3])
  assert.equal(new Set(three.map(read => read.started)).size, 1)
  const preceding = f.reads.filter(read => read.instance === 1).at(-1)!
  assert.equal(three[0].started - preceding.started, 25, 'new tabs do not inherit clocks from a preceding trial')
  assert.deepEqual(report.trials.map(trial => trial.measurementMs), [20000, 7000, 3000])
})

test('one slow tab does not hold the pacing gate for other tabs', async () => {
  const f = fixture({ latency: event => event.instance === 2 ? 1200 : 25 })
  const report = await f.clock.finish(runParallelFetch({ ...config, intervalScope: 'per-tab', intervalMs: 1000 }, f.dependencies))
  assert.equal(report.state, 'complete')
  const fast = f.reads.filter(read => read.instance === 3 && read.page !== 1)
  assert.ok(fast.length > 10)
  for (let index = 1; index < fast.length; index++) assert.equal(fast[index].started - fast[index - 1].started, 1000)
})

test('per-tab retries extend the shared cooldown while other tabs are waiting', async () => {
  const failedAt: number[] = []
  const f = fixture({ latency: event => event.instance === 3 ? 300 : 100, outcome: event => {
    if (event.instance >= 2 && event.page >= 7 && event.page <= 8 && event.occurrence === 1) {
      failedAt.push(f.clock.time)
      throw new ParallelFetchReadError('server-error', 503)
    }
    return { totalCount: 2000, totalPages: 100, httpStatus: 200 }
  } })
  const report = await f.clock.finish(runParallelFetch({ ...config, intervalScope: 'per-tab', intervalMs: 1000 }, f.dependencies))
  assert.equal(report.state, 'complete')
  assert.equal(failedAt.length, 2)
  const subsequent = f.reads.filter(read => read.started > failedAt[0])
  assert.ok(subsequent.length)
  assert.ok(subsequent.every(read => read.started >= failedAt[1] + 5000))
  assert.equal(report.trials[1].attempts.filter(attempt => attempt.errorCode === 'server-error').length, 2)
})

test('zero interval adds no wait and retains the shared attempt cap with eight tabs', async () => {
  const f = fixture({ latency: 1, outcome: event => {
    if (event.occurrence === 1) throw new ParallelFetchReadError('server-error', 503)
    return { totalCount: 2000, totalPages: 100, httpStatus: 200 }
  } })
  const report = await f.clock.finish(runParallelFetch({ ...config, intervalScope: 'per-tab', intervalMs: 0,
    concurrencies: [1, 8], repetitions: 3 }, f.dependencies))
  assert.equal(report.state, 'stopped')
  assert.equal(report.errorCode, 'limit-reached')
  assert.ok(f.reads.length <= 200)
  assert.equal(report.trials.reduce((sum, trial) => sum + trial.attempts.length, 0), f.reads.length)
  assert.ok(f.peak() <= 8)
  assert.equal(f.active(), 0)
  assert.ok(f.signals.every(signal => signal.aborted))
  const immediate = fixture({ latency: 1 })
  const complete = await immediate.clock.finish(runParallelFetch({ ...config, intervalScope: 'global', intervalMs: 0 }, immediate.dependencies))
  assert.equal(complete.state, 'complete')
  assert.equal(complete.trials[0].measurementMs, 20)
  assert.equal(complete.trials[1].measurementMs, 10)
})

test('navigation gate is required exactly once and records time at the actual start', async () => {
  const f = fixture({ latency: 25 })
  const original = f.dependencies.createReader
  f.dependencies.createReader = async (worker, target, signal, interval) => {
    const reader = await original(worker, target, signal, interval)
    return { ...reader, readPage: async (page, gate) => {
      await f.clock.wait(75, signal)
      return reader.readPage(page, gate)
    } }
  }
  const report = await f.clock.finish(runParallelFetch({ ...config, intervalMs: 0, concurrencies: [1] }, f.dependencies))
  assert.equal(report.trials[0].attempts[0].startedAt, new Date(Date.UTC(2026, 0, 1) + 75).toISOString())
  assert.ok(report.trials[0].attempts.every(attempt => attempt.durationMs === 25))
  for (const calls of [0, 2]) {
    const broken = fixture()
    broken.dependencies.createReader = async () => ({ close: async () => {}, readPage: async (_page, gate) => {
      for (let call = 0; call < calls; call++) await gate(async () => {})
      return { totalCount: 2000, totalPages: 100, httpStatus: 200 }
    } })
    const failed = await broken.clock.finish(runParallelFetch(config, broken.dependencies))
    assert.equal(failed.errorCode, 'invalid-request')
    assert.equal(failed.trials[0].attempts.length, calls === 0 ? 0 : 1)
  }
})

test('three and eight workers share paced starts and complete every page exactly once', async () => {
  const f = fixture()
  const report = await f.clock.finish(runParallelFetch({ ...config, concurrencies: [1, 3, 8],
    intervalMs: 3000, intervalMsList: [3000] }, f.dependencies))
  assert.equal(report.state, 'complete')
  assert.deepEqual(report.trials.map(trial => trial.concurrency), [1, 3, 8])
  assert.equal(f.reads.length, 72)
  assert.equal(f.peak(), 4, '3-second starts and 12-second reads limit overlap even with eight workers')
  assert.ok(f.clock.time < 600000)
  assert.deepEqual(f.closed, Array.from({ length: 12 }, (_, index) => index + 1))
  const targets = Array.from({ length: 20 }, (_, index) => index + config.startPage)
  for (const trial of report.trials) {
    const workerIds = Array.from({ length: trial.concurrency }, (_, index) => index + 1)
    assert.deepEqual(trial.workers.map(worker => worker.id), workerIds)
    assert.deepEqual(trial.attempts.filter(attempt => attempt.phase === 'prepare').map(attempt => attempt.worker), workerIds)
    const measured = trial.attempts.filter(attempt => attempt.phase === 'measure')
    assert.deepEqual(measured.map(attempt => attempt.page).sort((a, b) => a - b), targets)
    assert.deepEqual([...new Set(measured.map(attempt => attempt.worker))].sort((a, b) => a - b), workerIds)
    assert.deepEqual(trial.completedPages, targets)
  }
  for (let index = 1; index < f.reads.length; index++) {
    assert.ok(f.reads[index].started - f.reads[index - 1].started >= 3000)
  }
  assert.deepEqual(parseParallelFetchReport(report), report)
})

test('a fatal read cancels active and queued work with eight workers', async () => {
  let failureAt = -1
  let readsAtStop: number | null = null
  const f = fixture({ outcome: event => {
    if (event.instance === 2 && event.page === 7) {
      failureAt = f.clock.time
      throw new ParallelFetchReadError('http-denied', 429)
    }
    return { totalCount: 2000, totalPages: 100, httpStatus: 200 }
  } })
  const onUpdate = f.dependencies.onUpdate
  f.dependencies.onUpdate = report => {
    onUpdate?.(report)
    if (readsAtStop === null && report.trials.some(trial => trial.attempts.some(attempt => attempt.errorCode === 'http-denied'))) {
      readsAtStop = f.reads.length
    }
  }
  const report = await f.clock.finish(runParallelFetch({ ...config, concurrencies: [1, 8],
    intervalMs: 3000, intervalMsList: [3000] }, f.dependencies))
  assert.equal(report.state, 'error')
  assert.equal(report.errorCode, 'http-denied')
  assert.equal(report.trials[0].state, 'complete')
  assert.equal(report.trials[1].state, 'error')
  assert.equal(report.trials[1].workers.length, 8)
  assert.deepEqual(report.trials[1].completedPages, [])
  assert.ok(report.trials[1].attempts.some(attempt => attempt.errorCode === 'cancelled'))
  assert.ok(failureAt >= 0)
  assert.ok(f.reads.every(event => event.started <= failureAt))
  assert.equal(f.reads.length, readsAtStop, 'no navigation starts after the fatal result is handled')
  assert.equal(f.active(), 0)
  assert.ok(f.signals.every(signal => signal.aborted))
  assert.deepEqual(f.closed, Array.from({ length: 9 }, (_, index) => index + 1))
  assert.deepEqual(parseParallelFetchReport(report), report)
})

test('interval conditions share one queue, use actual 3-second pacing, and pass each condition to fresh readers', async () => {
  const f = fixture({ latency: 1000 })
  const originalCreate = f.dependencies.createReader
  const intervals: number[] = []
  f.dependencies.createReader = async (worker, target, signal, intervalMs) => {
    intervals.push(intervalMs!)
    return originalCreate(worker, target, signal, intervalMs)
  }
  const report = await f.clock.finish(runParallelFetch({ ...config, intervalMsList: [5000, 3000] }, f.dependencies))
  assert.equal(report.schemaVersion, 3)
  assert.deepEqual(report.trials.map(trial => [trial.intervalMs, trial.concurrency, trial.repetition]),
    [[5000, 1, 1], [5000, 2, 1], [3000, 1, 1], [3000, 2, 1]])
  assert.deepEqual(intervals, [5000, 5000, 5000, 3000, 3000, 3000])
  assert.equal(f.reads.length, 86)
  for (let index = 1; index < f.reads.length; index++) {
    const read = f.reads[index]
    assert.equal(read.started - f.reads[index - 1].started, intervals[read.instance - 1])
  }
  assert.equal(f.reads[43].started - f.reads[42].started, 3000, 'transition retains previous start instead of beginning another immediate queue')
  assert.deepEqual(parseParallelFetchReport(report), report)
})

test('a fatal result in one interval stops every later concurrency and interval', async () => {
  const f = fixture({ latency: 1, outcome: event => {
    if (event.instance === 1 && event.page === 9) throw new ParallelFetchReadError('http-denied', 429)
    return { totalCount: 2000, totalPages: 100, httpStatus: 200 }
  } })
  const report = await f.clock.finish(runParallelFetch({ ...config, intervalMsList: [5000, 3000] }, f.dependencies))
  assert.equal(report.errorCode, 'http-denied')
  assert.deepEqual(report.trials.map(trial => [trial.intervalMs, trial.concurrency]), [[5000, 1]])
  assert.deepEqual(f.closed, [1])
  assert.deepEqual(summarizeParallelFetch(report).slice(1).map(summary => summary.completedTrials), [0, 0, 0])
})

test('retry attempts consume the same 200-read budget across interval transitions', async () => {
  const f = fixture({ latency: 1, outcome: event => {
    if (event.occurrence === 1) throw new ParallelFetchReadError('server-error', 503)
    return { totalCount: 2000, totalPages: 100, httpStatus: 200 }
  } })
  const report = await f.clock.finish(runParallelFetch({ ...config, concurrencies: [1], repetitions: 3,
    intervalMsList: [5000, 3000] }, f.dependencies))
  assert.equal(report.state, 'stopped')
  assert.equal(report.errorCode, 'limit-reached')
  assert.equal(f.reads.length, 200)
  assert.ok(report.trials.some(trial => trial.intervalMs === 3000))
  assert.equal(report.trials.reduce((sum, trial) => sum + trial.attempts.length, 0), 200)
})

test('the shared deadline stops later intervals with a limit result', async () => {
  const f = fixture({ latency: 1 }), controller = new AbortController()
  f.dependencies.signal = controller.signal
  const originalUpdate = f.dependencies.onUpdate
  f.dependencies.onUpdate = report => {
    originalUpdate?.(report)
    if (report.trials.some(trial => trial.intervalMs === 3000 && trial.completedPages.length === 2)) {
      controller.abort(new ParallelFetchReadError('limit-reached'))
    }
  }
  const report = await f.clock.finish(runParallelFetch({ ...config, intervalMsList: [5000, 3000] }, f.dependencies))
  assert.equal(report.errorCode, 'limit-reached')
  assert.equal(report.trials.length, 3)
  assert.equal(report.trials.at(-1)?.errorCode, 'limit-reached')
  assert.equal(f.active(), 0)
})

test('serial-only repetitions finish exactly 63 reads with one owned reader at a time', async () => {
  const f = fixture()
  const createReader = f.dependencies.createReader
  let created = 0
  f.dependencies.createReader = async (worker, target, signal) => {
    assert.equal(worker, 1)
    assert.equal(f.closed.length, created, 'the previous repetition closes its reader before another is created')
    created += 1
    return createReader(worker, target, signal)
  }
  const report = await f.clock.finish(runParallelFetch({ ...config, concurrencies: [1], repetitions: 3 }, f.dependencies))
  assert.equal(report.state, 'complete')
  assert.equal(report.errorCode, null)
  assert.equal(created, 3)
  assert.equal(f.peak(), 1)
  assert.equal(f.reads.length, 63)
  assert.deepEqual(f.closed, [1, 2, 3])
  assert.deepEqual(report.trials.map(trial => [trial.concurrency, trial.repetition, trial.state]),
    [[1, 1, 'complete'], [1, 2, 'complete'], [1, 3, 'complete']])
  const targets = Array.from({ length: 20 }, (_, index) => index + config.startPage)
  for (const trial of report.trials) {
    assert.deepEqual(trial.completedPages, targets)
    assert.equal(trial.attempts.length, 21)
    assert.deepEqual(trial.attempts.filter(attempt => attempt.phase === 'prepare').map(attempt => attempt.page), [1])
    assert.deepEqual(trial.attempts.filter(attempt => attempt.phase === 'measure').map(attempt => attempt.page), targets)
    assert.deepEqual(trial.workers, [{ id: 1, page: null, state: 'complete', completedPages: 20 }])
  }
  for (let index = 1; index < f.reads.length; index += 1) assert.ok(f.reads[index].started - f.reads[index - 1].started >= config.intervalMs)
  assert.deepEqual(parseParallelFetchReport(report), report)
  assert.deepEqual(summarizeParallelFetch(report), [{ concurrency: 1, intervalMs: 5000, completedTrials: 3, plannedTrials: 3,
    medianMs: 240000, pagesPerMinute: 5, speedup: 1, estimatedFullScanMs: 1200000,
    successfulPages: 60, failedAttempts: 0, failedAttemptRate: 0, retries: 0 }])
})

test('rereads page 1 for measurement and freezes config and progress snapshots', async () => {
  const f = fixture({ latency: 1000 })
  const input = { ...config, startPage: 1, concurrencies: [1, 2] as (1 | 2)[] }
  let firstSnapshot: string | undefined
  f.dependencies.onUpdate = report => {
    parseParallelFetchReport(report)
    if (!firstSnapshot) { f.updates.push(report); firstSnapshot = JSON.stringify(report) }
    input.startPage = 500
    input.concurrencies.push(1)
    report.config.target = 'mr'
  }
  const report = await f.clock.finish(runParallelFetch(input, f.dependencies))
  assert.equal(report.config.startPage, 1)
  assert.equal(report.config.target, 'lp')
  assert.deepEqual(report.config.concurrencies, [1, 2])
  assert.equal(report.trials[0].attempts.filter(attempt => attempt.page === 1).length, 2)
  // Only the subscriber's explicit edit changed this snapshot; later updates did not append trials.
  assert.equal(f.updates[0].trials.length, 0)
  assert.equal(JSON.parse(firstSnapshot!).config.target, 'lp')
})

test('server errors retry once and impose a shared pause, including workers already queued', async () => {
  let failureAt = -1
  const f = fixture({ latency: 1000, outcome: event => {
    if (event.instance === 2 && event.page === 7 && event.occurrence === 1) {
      failureAt = event.started + 1000
      throw new ParallelFetchReadError('server-error', 503)
    }
    return { totalCount: 2000, totalPages: 100, httpStatus: 200 }
  } })
  const report = await f.clock.finish(runParallelFetch(config, f.dependencies))
  assert.equal(report.state, 'complete')
  assert.ok(failureAt >= 0)
  assert.ok(f.reads.filter(event => event.started > failureAt).every(event => event.started >= failureAt + 5000))
  const attempts = report.trials[1].attempts.filter(attempt => attempt.page === 7 && attempt.phase === 'measure')
  assert.deepEqual(attempts.map(attempt => attempt.errorCode), ['server-error', null])
  assert.equal(attempts[0].httpStatus, 503)
  assert.equal(report.trials[1].completedPages.filter(page => page === 7).length, 1)
})

test('a second server error stops the run without completing a partial trial', async () => {
  const f = fixture({ outcome: event => {
    if (event.page === 9) throw new ParallelFetchReadError('server-error', 503)
    return { totalCount: 2000, totalPages: 100, httpStatus: 200 }
  } })
  const report = await f.clock.finish(runParallelFetch(config, f.dependencies))
  assert.equal(report.state, 'error')
  assert.equal(report.errorCode, 'server-error')
  assert.equal(report.trials.length, 1)
  assert.equal(report.trials[0].state, 'error')
  assert.deepEqual(report.trials[0].completedPages, [7, 8])
  assert.equal(f.reads.filter(event => event.page === 9).length, 2)
  assert.deepEqual(f.closed, [1])
})

test('human verification aborts all workers and suppresses late in-flight successes', async () => {
  let failureAt = -1
  const f = fixture({ outcome: event => {
    if (event.instance === 2 && event.page === 7) {
      failureAt = event.started + 12000
      throw new ParallelFetchReadError('human-verification')
    }
    return { totalCount: 2000, totalPages: 100, httpStatus: 200 }
  } })
  const report = await f.clock.finish(runParallelFetch(config, f.dependencies))
  assert.equal(report.errorCode, 'human-verification')
  assert.equal(report.trials[0].state, 'complete')
  assert.equal(report.trials[1].state, 'error')
  assert.deepEqual(report.trials[1].completedPages, [])
  assert.ok(f.reads.every(event => event.started <= failureAt))
  assert.ok(f.signals.every(signal => signal.aborted))
  assert.deepEqual(f.closed, [1, 2, 3])
  assert.ok(report.trials[1].attempts.some(attempt => attempt.errorCode === 'cancelled'))
})

test('allowed observations survive successful and failed attempts without changing authentication stops', async () => {
  const success = { authenticationEvidence: 'logout-control' as const, loginRequiredHeading: false, rankingReadable: true }
  const failure = { authenticationEvidence: 'login-control' as const, loginRequiredHeading: false, rankingReadable: true }
  const f = fixture({ outcome: event => {
    if (event.page === 9) throw new ParallelFetchReadError('authentication-unconfirmed', 200, { ...failure, cookie: 'secret' } as typeof failure)
    return { totalCount: 2000, totalPages: 100, httpStatus: 200, diagnostics: { ...success, rawRows: ['secret'] } as typeof success }
  } })
  const report = await f.clock.finish(runParallelFetch(config, f.dependencies))
  assert.equal(report.state, 'error')
  assert.equal(report.errorCode, 'authentication-unconfirmed')
  assert.equal(report.trials.length, 1)
  assert.deepEqual(report.trials[0].completedPages, [7, 8])
  assert.deepEqual(f.reads.map(event => event.page), [1, 7, 8, 9])
  assert.deepEqual(report.trials[0].attempts.slice(0, -1).map(attempt => attempt.diagnostics), [success, success, success])
  assert.deepEqual(report.trials[0].attempts.at(-1)!.diagnostics, failure)
  assert.deepEqual(parseParallelFetchReport(JSON.parse(JSON.stringify(report))), report)
  assert.equal(JSON.stringify(report).includes('secret'), false)
  assert.deepEqual(f.closed, [1])
})

test('malformed optional diagnostics cannot replace a challenge error or turn success into failure', async () => {
  const malformed = { authenticationEvidence: 'secret', loginRequiredHeading: 'false', rankingReadable: 1 } as never
  const f = fixture({ outcome: event => {
    if (event.page === 7) throw new ParallelFetchReadError('human-verification', 405, malformed)
    return { totalCount: 2000, totalPages: 100, httpStatus: 200, diagnostics: malformed }
  } })
  const report = await f.clock.finish(runParallelFetch(config, f.dependencies))
  assert.equal(report.errorCode, 'human-verification')
  assert.deepEqual(f.reads.map(event => event.page), [1, 7])
  assert.deepEqual(report.trials[0].attempts.map(attempt => attempt.errorCode), [null, 'human-verification'])
  assert.ok(report.trials[0].attempts.every(attempt => !('diagnostics' in attempt)))
  assert.equal(JSON.stringify(report).includes('secret'), false)
})

test('only the first authentication failure is observed after workers settle, without including passive time in measurement', async () => {
  const initial: ParallelFetchReadDiagnostics = { authenticationEvidence: 'login-control', loginRequiredHeading: false, rankingReadable: true }
  const expected: ParallelFetchReadDiagnostics = { ...initial, trace: {
    observations: [
      { elapsedMs: 12000, phase: 'read', ...initial, humanVerification: false },
      { elapsedMs: 42000, phase: 'after-stop', authenticationEvidence: 'logout-control', loginRequiredHeading: false,
        rankingReadable: true, humanVerification: false },
    ], network: [], droppedObservations: 0, droppedNetworkEvents: 0,
    postStop: { durationMs: 30000, outcome: 'observed' },
  } }
  let failedAt = -1, observationCalls = 0, readsAtObservation = 0
  const f = fixture({ outcome: event => {
    if (event.instance === 2 && event.page === 7) {
      failedAt = f.clock.time
      throw new ParallelFetchReadError('authentication-unconfirmed', 200, initial)
    }
    return { totalCount: 2000, totalPages: 100, httpStatus: 200 }
  } })
  const createReader = f.dependencies.createReader
  f.dependencies.createReader = async (worker, target, signal) => {
    const reader = await createReader(worker, target, signal)
    const instance = f.signals.length
    return { ...reader, observeAfterStop: async diagnosticSignal => {
      observationCalls += 1
      assert.equal(instance, 2)
      assert.equal(f.active(), 0, 'all other reads have settled before observation')
      assert.ok(signal.aborted, 'the navigation queue is already stopped')
      assert.equal(diagnosticSignal.aborted, false, 'passive observation does not inherit internal abort')
      assert.deepEqual(f.closed, [1], 'trial readers remain open until observation finishes')
      readsAtObservation = f.reads.length
      await f.clock.wait(30000, diagnosticSignal)
      assert.equal(f.reads.length, readsAtObservation)
      return { ...expected, cookie: 'private-cookie', rawRows: ['private-player'] } as ParallelFetchReadDiagnostics
    } }
  }
  const report = await f.clock.finish(runParallelFetch(config, f.dependencies))
  assert.equal(observationCalls, 1)
  assert.equal(report.errorCode, 'authentication-unconfirmed')
  assert.equal(report.state, 'error')
  assert.equal(report.trials.length, 2)
  const trial = report.trials[1]
  assert.deepEqual(trial.completedPages, [])
  assert.equal(trial.measurementMs, 12000)
  assert.equal(trial.totalMs - trial.preparationMs! - trial.measurementMs!, 30000)
  const attempt = trial.attempts.find(item => item.errorCode === 'authentication-unconfirmed')!
  assert.equal(attempt.durationMs, 12000)
  assert.deepEqual(attempt.diagnostics, expected)
  assert.ok(trial.attempts.filter(item => item !== attempt).every(item => item.diagnostics === undefined))
  assert.ok(f.reads.every(event => event.started < failedAt))
  assert.equal(f.reads.length, readsAtObservation)
  assert.deepEqual(f.closed, [1, 2, 3])
  assert.doesNotMatch(JSON.stringify(report), /private-cookie|private-player/)
})

test('passive observer errors and malformed diagnostics preserve the initial failure and observations', async () => {
  const initial: ParallelFetchReadDiagnostics = { authenticationEvidence: 'login-control', loginRequiredHeading: false, rankingReadable: true }
  for (const outcome of ['throw', 'malformed'] as const) {
    let calls = 0
    const f = fixture({ outcome: event => {
      if (event.page === 7) throw new ParallelFetchReadError('authentication-unconfirmed', 200, initial)
      return { totalCount: 2000, totalPages: 100, httpStatus: 200 }
    } })
    const createReader = f.dependencies.createReader
    f.dependencies.createReader = async (worker, target, signal) => ({
      ...await createReader(worker, target, signal), observeAfterStop: async () => {
        calls += 1
        if (outcome === 'throw') throw new Error('private browser failure')
        return { authenticationEvidence: 'private cookie' } as never
      },
    })
    const report = await f.clock.finish(runParallelFetch(config, f.dependencies))
    assert.equal(calls, 1)
    assert.equal(report.errorCode, 'authentication-unconfirmed')
    assert.equal(report.trials[0].errorCode, 'authentication-unconfirmed')
    assert.deepEqual(report.trials[0].attempts.at(-1)!.diagnostics, initial)
    assert.deepEqual(f.reads.map(event => event.page), [1, 7])
    assert.deepEqual(f.closed, [1])
    assert.doesNotMatch(JSON.stringify(report), /private/)
  }
})

test('external cancellation skips post-stop observation without replacing an earlier authentication error', async () => {
  let observationCalls = 0
  const controller = new AbortController()
  const f = fixture({ outcome: event => {
    if (event.page === 7) throw new ParallelFetchReadError('authentication-unconfirmed', 200)
    return { totalCount: 2000, totalPages: 100, httpStatus: 200 }
  } })
  f.dependencies.signal = controller.signal
  const createReader = f.dependencies.createReader
  f.dependencies.createReader = async (worker, target, signal) => ({
    ...await createReader(worker, target, signal), observeAfterStop: async () => { observationCalls += 1; return undefined },
  })
  f.dependencies.onUpdate = report => {
    f.updates.push(report)
    if (report.trials.some(trial => trial.attempts.some(attempt => attempt.errorCode === 'authentication-unconfirmed'))) controller.abort()
  }
  const report = await f.clock.finish(runParallelFetch(config, f.dependencies))
  assert.equal(observationCalls, 0)
  assert.equal(report.errorCode, 'authentication-unconfirmed')
  assert.equal(report.trials[0].state, 'error')
  assert.deepEqual(f.reads.map(event => event.page), [1, 7])
  assert.deepEqual(f.closed, [1])
})

test('a running passive observation receives the external cancellation signal', async () => {
  const controller = new AbortController()
  const f = fixture({ outcome: event => {
    if (event.page === 7) throw new ParallelFetchReadError('authentication-unconfirmed', 200)
    return { totalCount: 2000, totalPages: 100, httpStatus: 200 }
  } })
  f.dependencies.signal = controller.signal
  const createReader = f.dependencies.createReader
  let calls = 0
  f.dependencies.createReader = async (worker, target, signal) => ({
    ...await createReader(worker, target, signal), observeAfterStop: async diagnosticSignal => {
      calls += 1
      assert.equal(diagnosticSignal, controller.signal)
      controller.abort()
      await f.clock.wait(30000, diagnosticSignal)
      return undefined
    },
  })
  const report = await f.clock.finish(runParallelFetch(config, f.dependencies))
  assert.equal(calls, 1)
  assert.equal(controller.signal.aborted, true)
  assert.equal(report.errorCode, 'authentication-unconfirmed')
  assert.equal(report.trials[0].totalMs, report.trials[0].preparationMs! + report.trials[0].measurementMs!)
  assert.deepEqual(f.closed, [1])
})

test('preparation failures freeze preparation time before passive observation and never begin measurement', async () => {
  const initial: ParallelFetchReadDiagnostics = { authenticationEvidence: 'login-control', loginRequiredHeading: false, rankingReadable: true }
  const f = fixture({ outcome: () => { throw new ParallelFetchReadError('authentication-unconfirmed', 200, initial) } })
  const createReader = f.dependencies.createReader
  f.dependencies.createReader = async (worker, target, signal) => ({
    ...await createReader(worker, target, signal), observeAfterStop: async diagnosticSignal => {
      await f.clock.wait(30000, diagnosticSignal)
      return initial
    },
  })
  const report = await f.clock.finish(runParallelFetch(config, f.dependencies))
  assert.equal(report.errorCode, 'authentication-unconfirmed')
  assert.equal(report.trials[0].preparationMs, 12000)
  assert.equal(report.trials[0].measurementMs, null)
  assert.equal(report.trials[0].totalMs, 42000)
  assert.equal(report.trials[0].attempts[0].durationMs, 12000)
  assert.deepEqual(f.reads.map(event => event.page), [1])
  assert.deepEqual(f.closed, [1])
})

test('other fatal errors never invoke an available post-stop observer', async () => {
  let calls = 0
  const f = fixture({ outcome: event => {
    if (event.page === 7) throw new ParallelFetchReadError('human-verification', 403)
    return { totalCount: 2000, totalPages: 100, httpStatus: 200 }
  } })
  const createReader = f.dependencies.createReader
  f.dependencies.createReader = async (worker, target, signal) => ({
    ...await createReader(worker, target, signal), observeAfterStop: async () => { calls += 1; return undefined },
  })
  const report = await f.clock.finish(runParallelFetch(config, f.dependencies))
  assert.equal(calls, 0)
  assert.equal(report.errorCode, 'human-verification')
  assert.deepEqual(f.reads.map(event => event.page), [1, 7])
})

test('cancellation interrupts active and queued reads and closes every created reader', async () => {
  const f = fixture()
  const controller = new AbortController()
  f.dependencies.signal = controller.signal
  f.dependencies.onUpdate = report => {
    f.updates.push(report)
    if (report.trials[1]?.workers.some(worker => worker.state === 'reading') && report.trials[1].state === 'running') controller.abort()
  }
  const report = await f.clock.finish(runParallelFetch(config, f.dependencies))
  assert.equal(report.state, 'stopped')
  assert.equal(report.errorCode, 'cancelled')
  assert.equal(report.trials[1].state, 'stopped')
  assert.equal(report.trials[1].completedPages.length, 0)
  assert.deepEqual(f.closed, [1, 2, 3])
  assert.deepEqual(parseParallelFetchReport(report), report)
})

test('retries cannot exceed the global 200-attempt cap', async () => {
  const f = fixture({ latency: 1000, outcome: event => {
    if (event.occurrence === 1) throw new ParallelFetchReadError('server-error', 503)
    return { totalCount: 2000, totalPages: 100, httpStatus: 200 }
  } })
  const report = await f.clock.finish(runParallelFetch({ ...config, intervalMs: 1000, repetitions: 3 }, f.dependencies))
  assert.equal(report.state, 'stopped')
  assert.equal(report.errorCode, 'limit-reached')
  assert.equal(f.reads.length, 200)
  assert.equal(report.trials.reduce((sum, trial) => sum + trial.attempts.length, 0), 200)
  assert.notEqual(report.trials.at(-1)!.state, 'complete')
  assert.deepEqual(parseParallelFetchReport(report), report)
})

test('preparation verifies the complete requested range before measurement', async () => {
  const f = fixture({ outcome: () => ({ totalCount: 400, totalPages: 20, httpStatus: 200 }) })
  const report = await f.clock.finish(runParallelFetch(config, f.dependencies))
  assert.equal(report.errorCode, 'out-of-range')
  assert.equal(report.trials[0].measurementMs, null)
  assert.equal(report.trials[0].completedPages.length, 0)
  assert.deepEqual(f.reads.map(event => event.page), [1])
})

test('unknown errors and invalid reader data are represented only by safe codes', async () => {
  const f = fixture({ outcome: () => { throw new Error('secret-cookie-and-private-player') } })
  const report = await f.clock.finish(runParallelFetch(config, f.dependencies))
  assert.equal(report.errorCode, 'read-failed')
  assert.ok(!JSON.stringify(report).includes('secret-cookie'))
  assert.ok(!JSON.stringify(report).includes('private-player'))
  const malformed = fixture({ outcome: () => ({ totalCount: Number.NaN, totalPages: 100, httpStatus: 200 }) })
  const badReport = await malformed.clock.finish(runParallelFetch(config, malformed.dependencies))
  assert.equal(badReport.errorCode, 'unsupported-dom')
  assert.deepEqual(parseParallelFetchReport(badReport), badReport)
})

test('setup failure and already-aborted jobs release owned readers and never start measurement', async () => {
  const f = fixture()
  const make = f.dependencies.createReader
  f.dependencies.createReader = async (worker, target, signal) => {
    if (worker === 2) throw new ParallelFetchReadError('browser-unavailable')
    return make(worker, target, signal)
  }
  const report = await f.clock.finish(runParallelFetch(config, f.dependencies))
  assert.equal(report.errorCode, 'browser-unavailable')
  assert.deepEqual(f.closed, [1, 2])
  assert.equal(report.trials[1].attempts.length, 0)
  const before = fixture()
  before.dependencies.signal = AbortSignal.abort()
  const cancelled = await before.clock.finish(runParallelFetch(config, before.dependencies))
  assert.equal(cancelled.state, 'stopped')
  assert.equal(cancelled.trials.length, 0)
  assert.equal(before.reads.length, 0)
})
