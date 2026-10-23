import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { PARALLEL_FETCH_MAX_ATTEMPTS, parseParallelFetchConfig, parseParallelFetchReadDiagnostics } from '../../src/lib/parallelFetch.ts'
import { PARALLEL_FETCH_ERRORS } from '../../src/types/parallelFetch.ts'
import type {
  ParallelFetchAttempt, ParallelFetchConfig, ParallelFetchErrorCode, ParallelFetchReadDiagnostics, ParallelFetchReport, ParallelFetchTarget,
  ParallelFetchTrial, ParallelFetchWorker,
} from '../../src/types/parallelFetch.ts'

export class ParallelFetchReadError extends Error {
  readonly code: ParallelFetchErrorCode
  readonly httpStatus: number | null
  readonly diagnostics?: ParallelFetchReadDiagnostics
  constructor(code: ParallelFetchErrorCode, httpStatus: number | null = null, diagnostics?: ParallelFetchReadDiagnostics) {
    const safeCode = PARALLEL_FETCH_ERRORS.includes(code) ? code : 'read-failed'
    super(safeCode)
    this.name = 'ParallelFetchReadError'
    this.code = safeCode
    this.httpStatus = safeHttpStatus(httpStatus)
    const safe = safeDiagnostics(diagnostics)
    if (safe) this.diagnostics = safe
  }
}

export interface ParallelFetchReader {
  readPage(page: number): Promise<{ totalCount: number; totalPages: number; httpStatus: number | null; diagnostics?: ParallelFetchReadDiagnostics }>
  observeAfterStop?(signal: AbortSignal): Promise<ParallelFetchReadDiagnostics | undefined>
  close(): Promise<void>
}
export interface ParallelFetchDependencies {
  createReader(workerId: number, target: ParallelFetchTarget, signal: AbortSignal): Promise<ParallelFetchReader>
  onUpdate?(report: ParallelFetchReport): void
  signal?: AbortSignal
  now?(): number
  wallNow?(): string
  wait?(milliseconds: number, signal: AbortSignal): Promise<void>
  runId?: string
}

function safeHttpStatus(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599 ? value : null
}
function safeDiagnostics(value: unknown): ParallelFetchReadDiagnostics | undefined {
  // Optional observations must not change collection, retry or stop decisions.
  try { return value === undefined ? undefined : parseParallelFetchReadDiagnostics(value) } catch { return undefined }
}
function safeError(error: unknown, cancelled = false): ParallelFetchReadError {
  if (cancelled) return new ParallelFetchReadError('cancelled')
  return error instanceof ParallelFetchReadError ? error : new ParallelFetchReadError('read-failed')
}
function stoppedState(code: ParallelFetchErrorCode): 'stopped' | 'error' {
  return code === 'cancelled' || code === 'limit-reached' ? 'stopped' : 'error'
}

/** Every tab has its own reader; all navigation starts share one paced, bounded queue. */
export async function runParallelFetch(input: ParallelFetchConfig, dependencies: ParallelFetchDependencies): Promise<ParallelFetchReport> {
  const config = parseParallelFetchConfig(input)
  const now = dependencies.now ?? (() => performance.now())
  const wallNow = dependencies.wallNow ?? (() => new Date().toISOString())
  const wait = dependencies.wait ?? (async (milliseconds, signal) => { await delay(milliseconds, undefined, { signal }) })
  const controller = new AbortController()
  const signal = controller.signal
  const report: ParallelFetchReport = {
    schemaVersion: 1, runId: dependencies.runId ?? randomUUID(), config: structuredClone(config),
    state: 'running', startedAt: wallNow(), finishedAt: null, trials: [], errorCode: null,
  }
  let failure: ParallelFetchReadError | null = null
  let totalAttempts = 0
  let lastStart: number | null = null
  let pausedUntil = 0
  let startQueue: Promise<void> = Promise.resolve()

  function stop(error: ParallelFetchReadError): void {
    if (failure) return
    failure = error
    controller.abort()
  }
  function failureCode(): ParallelFetchErrorCode { return failure?.code ?? 'read-failed' }
  const onAbort = () => stop(new ParallelFetchReadError('cancelled'))
  dependencies.signal?.addEventListener('abort', onAbort, { once: true })
  if (dependencies.signal?.aborted) onAbort()
  function checkStopped(): void {
    if (signal.aborted) throw new ParallelFetchReadError('cancelled')
  }
  function emit(): void {
    // Subscribers receive independent snapshots and cannot change an active run.
    try { dependencies.onUpdate?.(structuredClone(report)) } catch { /* A view failure must not start another fetch. */ }
  }

  function reserveStart(): Promise<void> {
    const reservation = startQueue.then(async () => {
      checkStopped()
      // Retry backoff can extend while another worker is already waiting here.
      while (true) {
        const due = Math.max(pausedUntil, lastStart === null ? now() : lastStart + config.intervalMs)
        const remaining = due - now()
        if (remaining <= 0) break
        await wait(remaining, signal)
        checkStopped()
      }
      if (totalAttempts >= PARALLEL_FETCH_MAX_ATTEMPTS) {
        const error = new ParallelFetchReadError('limit-reached')
        stop(error)
        throw error
      }
      checkStopped()
      totalAttempts += 1
      lastStart = now()
    })
    startQueue = reservation.catch(() => {})
    return reservation
  }

  async function runTrial(concurrency: 1 | 2 | 4, repetition: number): Promise<void> {
    const trialStart = now()
    let measurementStart: number | null = null
    let measurementEnd: number | null = null
    const readers: ParallelFetchReader[] = []
    const postStop: { candidate?: { attempt: ParallelFetchAttempt; reader: ParallelFetchReader } } = {}
    const trial: ParallelFetchTrial = {
      concurrency, repetition, state: 'preparing', startedAt: wallNow(), finishedAt: null,
      preparationMs: null, measurementMs: null, totalMs: 0, completedPages: [], attempts: [],
      workers: Array.from({ length: concurrency }, (_, index) => ({ id: index + 1, page: null, state: 'idle', completedPages: 0 })),
      errorCode: null,
    }
    const endPage = config.startPage + config.pageCount - 1
    report.trials.push(trial)
    function publish(): void {
      const current = now()
      trial.totalMs = Math.max(0, current - trialStart)
      if (measurementStart !== null) trial.measurementMs = Math.max(0, (measurementEnd ?? current) - measurementStart)
      emit()
    }
    async function read(worker: ParallelFetchWorker, page: number, phase: 'prepare' | 'measure'): Promise<void> {
      for (let retry = 0; retry <= 1; retry += 1) {
        worker.page = page
        worker.state = 'waiting'
        publish()
        await reserveStart()
        checkStopped()
        const started = now()
        const attempt: ParallelFetchAttempt = {
          worker: worker.id, page, phase, startedAt: wallNow(), durationMs: 0,
          httpStatus: null as number | null, errorCode: null as ParallelFetchErrorCode | null,
          totalCount: null as number | null, totalPages: null as number | null,
        }
        worker.state = 'reading'
        publish()
        try {
          const value = await readers[worker.id - 1].readPage(page)
          checkStopped()
          const diagnostics = safeDiagnostics(value.diagnostics)
          if (diagnostics) attempt.diagnostics = diagnostics
          attempt.httpStatus = safeHttpStatus(value.httpStatus)
          if (attempt.httpStatus === 401 || attempt.httpStatus === 403 || attempt.httpStatus === 429) throw new ParallelFetchReadError('http-denied', attempt.httpStatus)
          if (attempt.httpStatus !== null && attempt.httpStatus >= 500) throw new ParallelFetchReadError('server-error', attempt.httpStatus)
          if (attempt.httpStatus !== null && attempt.httpStatus >= 400) throw new ParallelFetchReadError('http-error', attempt.httpStatus)
          if (!Number.isSafeInteger(value.totalCount) || value.totalCount < 1 || !Number.isSafeInteger(value.totalPages) || value.totalPages < 1) {
            throw new ParallelFetchReadError('unsupported-dom', attempt.httpStatus)
          }
          attempt.totalCount = value.totalCount
          attempt.totalPages = value.totalPages
          if (endPage > value.totalPages || page > value.totalPages) throw new ParallelFetchReadError('out-of-range', attempt.httpStatus)
          attempt.durationMs = Math.max(0, now() - started)
          trial.attempts.push(attempt)
          worker.state = 'idle'
          if (phase === 'measure') {
            trial.completedPages.push(page)
            trial.completedPages.sort((a, b) => a - b)
            worker.completedPages += 1
          }
          publish()
          return
        } catch (error) {
          const safe = safeError(error, signal.aborted)
          attempt.durationMs = Math.max(0, now() - started)
          attempt.errorCode = safe.code
          attempt.httpStatus = safe.httpStatus ?? attempt.httpStatus
          const diagnostics = safeDiagnostics(safe.diagnostics)
          if (diagnostics) attempt.diagnostics = diagnostics
          trial.attempts.push(attempt)
          const retryable = safe.code === 'server-error' && retry === 0 && !signal.aborted
          if (retryable) pausedUntil = Math.max(pausedUntil, now() + 5_000)
          else {
            const reader = readers[worker.id - 1]
            if (!failure && safe.code === 'authentication-unconfirmed' && typeof reader.observeAfterStop === 'function') {
              postStop.candidate = { attempt, reader }
            }
            stop(safe)
          }
          worker.state = retryable ? 'waiting' : 'stopped'
          publish()
          if (!retryable) throw safe
        }
      }
    }
    async function work(worker: ParallelFetchWorker, action: () => Promise<void>): Promise<void> {
      try { await action() } catch (error) {
        stop(safeError(error, signal.aborted))
        worker.state = 'stopped'
        publish()
      }
    }

    publish()
    try {
      for (const worker of trial.workers) {
        checkStopped()
        readers.push(await dependencies.createReader(worker.id, config.target, signal))
        checkStopped()
      }
      await Promise.all(trial.workers.map(worker => work(worker, () => read(worker, 1, 'prepare'))))
      trial.preparationMs = Math.max(0, now() - trialStart)
      checkStopped()
      trial.state = 'running'
      measurementStart = now()
      let nextPage = config.startPage
      publish()
      await Promise.all(trial.workers.map(worker => work(worker, async () => {
        while (nextPage <= endPage) {
          checkStopped()
          const page = nextPage++
          await read(worker, page, 'measure')
        }
        worker.page = null
        worker.state = 'complete'
        publish()
      })))
      measurementEnd = now()
      checkStopped()
      if (trial.completedPages.length !== config.pageCount || new Set(trial.completedPages).size !== config.pageCount) {
        throw new ParallelFetchReadError('read-failed')
      }
      trial.state = 'complete'
    } catch (error) {
      stop(safeError(error, signal.aborted))
    } finally {
      const ended = now()
      if (trial.preparationMs === null) trial.preparationMs = Math.max(0, ended - trialStart)
      if (measurementStart !== null && measurementEnd === null) measurementEnd = ended
      // All worker tasks have settled and the internal signal already blocks new reads.
      // Only passive diagnostics may continue; they never alter the measured duration or failure.
      if (postStop.candidate) {
        publish()
        if (!dependencies.signal?.aborted) {
          try {
            const { attempt, reader } = postStop.candidate
            const diagnosticSignal = dependencies.signal ?? new AbortController().signal
            const diagnostics = safeDiagnostics(await reader.observeAfterStop?.(diagnosticSignal))
            if (diagnostics) attempt.diagnostics = diagnostics
          } catch { /* Optional diagnostic failures leave the original read result intact. */ }
        }
      }
      await Promise.allSettled(readers.map(reader => reader.close()))
      if (failure) {
        const code = failureCode()
        trial.state = stoppedState(code)
        trial.errorCode = code
        trial.workers.forEach(worker => { if (worker.state !== 'complete') worker.state = 'stopped' })
      }
      trial.finishedAt = wallNow()
      publish()
    }
  }

  try {
    emit()
    for (const concurrency of config.concurrencies) {
      for (let repetition = 1; repetition <= config.repetitions; repetition += 1) {
        checkStopped()
        await runTrial(concurrency, repetition)
        checkStopped()
      }
    }
    report.state = 'complete'
  } catch (error) {
    stop(safeError(error, signal.aborted))
    const code = failureCode()
    report.state = stoppedState(code)
    report.errorCode = code
  } finally {
    dependencies.signal?.removeEventListener('abort', onAbort)
    report.finishedAt = wallNow()
    emit()
  }
  return structuredClone(report)
}
