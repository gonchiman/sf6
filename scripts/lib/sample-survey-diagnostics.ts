import type { Page } from 'playwright'
import { PARALLEL_FETCH_ERRORS } from '../../src/types/parallelFetch.ts'
import type { ParallelFetchReadDiagnostics } from '../../src/types/parallelFetch.ts'
import type { SampleSurveyTarget } from '../../src/types/sampleSurvey.ts'
import { ParallelFetchReadError } from './parallel-fetch-runner.ts'
import { SampleSurveyReadError } from './sample-survey-reader.ts'

const MAX_EVENTS = 32
const MAX_ELAPSED_MS = 7 * 86_400_000
const NETWORK_CODES = ['ERR_CONNECTION_RESET', 'ERR_CONNECTION_REFUSED', 'ERR_CONNECTION_CLOSED', 'ERR_TIMED_OUT',
  'ERR_NAME_NOT_RESOLVED', 'ERR_NETWORK_ACCESS_DENIED', 'ERR_TUNNEL_CONNECTION_FAILED', 'ERR_PROXY_CONNECTION_FAILED',
  'ERR_CERT_AUTHORITY_INVALID', 'ERR_ABORTED', 'ERR_INTERNET_DISCONNECTED', 'ERR_HTTP_RESPONSE_CODE_FAILURE'] as const
const SAFE_CODES = new Set<string>([...PARALLEL_FETCH_ERRORS, 'frame-changed', 'storage-error', 'interrupted'])
type NetworkCode = typeof NETWORK_CODES[number]
export type SampleSurveyDiagnosticFailureKind = 'timeout' | 'network' | 'undefined-helper' | 'reference-error'
  | 'type-error' | 'browser-closed' | 'other'
interface FailureClassification { failureKind: SampleSurveyDiagnosticFailureKind; networkCode?: NetworkCode }
export interface SampleSurveyDiagnosticObservation {
  maintenance?: boolean | null
  loginRequired?: boolean | null
  signedIn?: boolean | null
  authenticationEvidence?: 'logout-control' | 'login-control' | 'conflicting-controls' | 'no-control' | null
  loginRequiredHeading?: boolean | null
  conditionsMatch?: boolean | null
  leagueLabelsMatch?: boolean | null
  currentActMatch?: boolean | null
  selectedPage?: number | null
  range?: { from: number; to: number; total: number } | null
  rankIcons?: 'ready' | 'pending' | 'unsupported' | null
  entryCount?: number | null
}
export interface SampleSurveyDiagnosticEvent {
  elapsedMs: number
  stage: 'navigation' | 'ranking-evaluate' | 'capture-start' | 'capture-complete'
  outcome: 'start' | 'complete' | 'failed'
  target?: SampleSurveyTarget
  httpStatus?: number | null
  failureKind?: SampleSurveyDiagnosticFailureKind
  networkCode?: NetworkCode
  observation?: SampleSurveyDiagnosticObservation
}
export interface SampleSurveyFailureDiagnostic extends FailureClassification {
  schemaVersion: 1
  capturedAt: string
  innerCode: string | null
  httpStatus: number | null
  diagnostics?: ParallelFetchReadDiagnostics
  events: SampleSurveyDiagnosticEvent[]
  droppedEvents: number
  capture: 'not-started' | 'started' | 'complete'
}

function status(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 100 && Number(value) <= 599 ? Number(value) : null
}
function count(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 0 }
function observation(value: unknown): SampleSurveyDiagnosticObservation | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const input = value as Record<string, unknown>, result: SampleSurveyDiagnosticObservation = {}
  for (const key of ['maintenance', 'loginRequired', 'signedIn', 'loginRequiredHeading', 'conditionsMatch', 'leagueLabelsMatch', 'currentActMatch'] as const) {
    if (input[key] === null || typeof input[key] === 'boolean') result[key] = input[key] as boolean | null
  }
  if (input.authenticationEvidence === null || typeof input.authenticationEvidence === 'string'
    && ['logout-control', 'login-control', 'conflicting-controls', 'no-control'].includes(input.authenticationEvidence)) {
    result.authenticationEvidence = input.authenticationEvidence as SampleSurveyDiagnosticObservation['authenticationEvidence']
  }
  if (input.selectedPage === null || count(input.selectedPage)) result.selectedPage = input.selectedPage as number | null
  if (input.range === null) result.range = null
  else if (input.range && typeof input.range === 'object' && !Array.isArray(input.range)) {
    const range = input.range as Record<string, unknown>
    if (count(range.from) && count(range.to) && count(range.total)) result.range = { from: range.from, to: range.to, total: range.total }
  }
  if (input.rankIcons === null || typeof input.rankIcons === 'string' && ['ready', 'pending', 'unsupported'].includes(input.rankIcons)) {
    result.rankIcons = input.rankIcons as SampleSurveyDiagnosticObservation['rankIcons']
  }
  if (Array.isArray(input.entries)) result.entryCount = input.entries.length
  else if (input.entries === null) result.entryCount = null
  else if (Array.isArray(input.rows)) result.entryCount = input.rows.length
  return Object.keys(result).length ? result : undefined
}

/** Inspect raw exception text only to select fixed enums; never retain the exception or its text. */
function classify(error: unknown): FailureClassification {
  try {
    if (!(error instanceof Error)) return { failureKind: 'other' }
    const message = typeof error.message === 'string' ? error.message : ''
    if (/\b__name is not defined\b/.test(message)) return { failureKind: 'undefined-helper' }
    if (error.name === 'TimeoutError') return { failureKind: 'timeout' }
    const code = /\b(ERR_[A-Z_]+)\b/.exec(message)?.[1]
    if (NETWORK_CODES.includes(code as NetworkCode)) return { failureKind: 'network', networkCode: code as NetworkCode }
    if (/Target page, context or browser has been closed|Target closed|Browser has been closed|browser has been closed/.test(message)) return { failureKind: 'browser-closed' }
    if (error.name === 'ReferenceError' || /\bReferenceError:/.test(message)) return { failureKind: 'reference-error' }
    if (error.name === 'TypeError' || /\bTypeError:/.test(message)) return { failureKind: 'type-error' }
  } catch { /* Hostile exception accessors cannot affect collection. */ }
  return { failureKind: 'other' }
}

/** In-memory, bounded evidence only. The caller decides whether and where a failure is saved. */
export function createSampleSurveyDiagnostics() {
  const started = performance.now()
  let droppedEvents = 0, httpStatus: number | null = null
  let capture: SampleSurveyFailureDiagnostic['capture'] = 'not-started'
  let lastFailure: FailureClassification | null = null
  const events: SampleSurveyDiagnosticEvent[] = []
  function add(value: Omit<SampleSurveyDiagnosticEvent, 'elapsedMs'>): void {
    events.push({ elapsedMs: Math.min(MAX_ELAPSED_MS, Math.max(0, performance.now() - started)), ...value })
    if (events.length > MAX_EVENTS) { events.shift(); droppedEvents++ }
  }
  return {
    wrapPage(page: Page, target: SampleSurveyTarget): Page {
      if (target !== 'lp' && target !== 'mr') throw new TypeError('Unsupported diagnostic target')
      return {
        async goto(...args: Parameters<Page['goto']>) {
          httpStatus = null; capture = 'not-started'; lastFailure = null
          add({ stage: 'navigation', outcome: 'start', target })
          try {
            const response = await page.goto(...args)
            try { httpStatus = status(response?.status()) } catch { httpStatus = null }
            add({ stage: 'navigation', outcome: 'complete', target, httpStatus })
            return response
          } catch (error) {
            lastFailure = classify(error)
            add({ stage: 'navigation', outcome: 'failed', target, httpStatus, ...lastFailure })
            throw error
          }
        },
        async evaluate(fn: unknown, argument?: unknown) {
          add({ stage: 'ranking-evaluate', outcome: 'start', target })
          try {
            const value = await page.evaluate(fn as (argument: unknown) => unknown, argument)
            let summary: SampleSurveyDiagnosticObservation | undefined
            try { summary = observation(value) } catch { /* Diagnostics never alter accepted values. */ }
            add({ stage: 'ranking-evaluate', outcome: 'complete', target, ...(summary ? { observation: summary } : {}) })
            return value
          } catch (error) {
            lastFailure = classify(error)
            add({ stage: 'ranking-evaluate', outcome: 'failed', target, ...lastFailure })
            throw error
          }
        },
        url: () => page.url(),
      } as unknown as Page
    },
    mark(stage: 'capture-start' | 'capture-complete'): void {
      if (stage !== 'capture-start' && stage !== 'capture-complete') return
      capture = stage === 'capture-start' ? 'started' : 'complete'
      add({ stage, outcome: stage === 'capture-start' ? 'start' : 'complete' })
    },
    failure(error: unknown): SampleSurveyFailureDiagnostic {
      let innerCode: string | null = null, existing: ParallelFetchReadError | undefined
      if (error instanceof ParallelFetchReadError) existing = new ParallelFetchReadError(error.code, error.httpStatus, error.diagnostics)
      if (existing) innerCode = existing.code
      else if (error instanceof SampleSurveyReadError && SAFE_CODES.has(error.code)) innerCode = error.code
      const current = classify(error)
      const kind = current.failureKind !== 'other' ? current : lastFailure ?? { failureKind: innerCode === 'timeout' ? 'timeout' as const : 'other' as const }
      return { schemaVersion: 1, capturedAt: new Date().toISOString(), innerCode,
        httpStatus: existing?.httpStatus ?? httpStatus, ...(existing?.diagnostics ? { diagnostics: structuredClone(existing.diagnostics) } : {}),
        events: structuredClone(events), droppedEvents, capture, ...kind }
    },
  }
}
