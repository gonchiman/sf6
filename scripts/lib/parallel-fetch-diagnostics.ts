import type { Page, Request, Response } from 'playwright'
import { PARALLEL_FETCH_MAX_TRACE_NETWORK_EVENTS, PARALLEL_FETCH_MAX_TRACE_OBSERVATIONS } from '../../src/lib/parallelFetch.ts'
import type { ParallelFetchNetworkEvent, ParallelFetchPostStopDiagnostics, ParallelFetchReadDiagnostics,
  ParallelFetchReadObservation, ParallelFetchReadTrace } from '../../src/types/parallelFetch.ts'

/** Per-page event recording. URLs are classified immediately and never retained. */
export function createParallelFetchDiagnosticRecorder(page: Page, now: () => number, onWafAction?: () => void) {
  let active = false, generation = 0, started = 0
  let phase: 'read' | 'after-stop' = 'read'
  let trace: ParallelFetchReadTrace = { observations: [], network: [], droppedObservations: 0, droppedNetworkEvents: 0 }
  const requests = new WeakMap<Request, number>()
  const elapsed = () => Math.min(7 * 86400000, Math.max(0, now() - started))
  function network(request: Request, kind: ParallelFetchNetworkEvent['kind'], status: number | null,
    wafAction?: ParallelFetchNetworkEvent['wafAction']): void {
    if (!active || requests.get(request) !== generation) return
    try {
      const hostname = new URL(request.url()).hostname
      const site = hostname === 'www.streetfighter.com' ? 'buckler'
        : hostname === 'cid.capcom.com' || hostname === 'auth.cid.capcom.com' ? 'capcom-auth' : 'other'
      const rawResource = request.resourceType()
      const resource = ['document', 'xhr', 'fetch', 'script', 'stylesheet', 'image'].includes(rawResource)
        ? rawResource as ParallelFetchNetworkEvent['resource'] : 'other'
      trace.network.push({ elapsedMs: elapsed(), phase, kind, resource, site, status,
        ...(wafAction !== undefined ? { wafAction } : {}) })
      if (trace.network.length > PARALLEL_FETCH_MAX_TRACE_NETWORK_EVENTS) {
        trace.network.shift(); trace.droppedNetworkEvents++
      }
      if (kind === 'waf-action' && site !== 'other') onWafAction?.()
    } catch { /* Diagnostic event failures cannot affect collection. */ }
  }
  const onRequest = (request: Request) => { if (active) requests.set(request, generation) }
  const onResponse = (response: Response) => {
    try {
      const status = response.status()
      if (!Number.isInteger(status) || status < 100 || status > 599) return
      // Keep only the documented action enum, never raw headers (including cookies).
      // The synchronous accessor avoids a late event being attributed to a later read.
      let wafAction: ParallelFetchNetworkEvent['wafAction']
      try {
        const value = response.headers()['x-amzn-waf-action']
        wafAction = value === 'captcha' || value === 'challenge' ? value : null
      } catch { /* Missing evidence stays omitted, distinct from checked-but-absent. */ }
      if (wafAction) network(response.request(), 'waf-action', status, wafAction)
      else if (status >= 400) network(response.request(), 'http-error', status, wafAction)
    } catch { /* Never retain response objects, raw headers, bodies or error text. */ }
  }
  const onFailed = (request: Request) => network(request, 'request-failed', null)
  page.on('request', onRequest)
  page.on('response', onResponse)
  page.on('requestfailed', onFailed)
  return {
    begin() {
      generation++; active = true; started = now(); phase = 'read'
      trace = { observations: [], network: [], droppedObservations: 0, droppedNetworkEvents: 0 }
    },
    afterStop() { phase = 'after-stop' },
    observe(value: Omit<ParallelFetchReadObservation, 'elapsedMs' | 'phase'>, force = false) {
      if (!active) return
      const next = { elapsedMs: elapsed(), phase, authenticationEvidence: value.authenticationEvidence,
        loginRequiredHeading: value.loginRequiredHeading, rankingReadable: value.rankingReadable,
        humanVerification: value.humanVerification }
      const last = trace.observations.at(-1)
      if (!force && last && last.phase === next.phase && last.authenticationEvidence === next.authenticationEvidence
        && last.loginRequiredHeading === next.loginRequiredHeading && last.rankingReadable === next.rankingReadable
        && last.humanVerification === next.humanVerification) return
      trace.observations.push(next)
      if (trace.observations.length > PARALLEL_FETCH_MAX_TRACE_OBSERVATIONS) {
        trace.observations.shift(); trace.droppedObservations++
      }
    },
    postStop(value: ParallelFetchPostStopDiagnostics) { trace.postStop = { durationMs: value.durationMs, outcome: value.outcome } },
    snapshot(base?: ParallelFetchReadDiagnostics, compact = false): ParallelFetchReadDiagnostics | undefined {
      if (!trace.observations.length && !trace.network.length && !trace.postStop) return base
      const result = structuredClone(trace)
      // Successful and retryable 5xx reads need only a compact tail; retain
      // the richer trace for the fatal failure that ends the run.
      // This also bounds artifacts even for the 200-navigation local test limit.
      if (compact) {
        result.droppedObservations += Math.max(0, result.observations.length - 8)
        result.droppedNetworkEvents += Math.max(0, result.network.length - 8)
        result.observations = result.observations.slice(-8)
        result.network = result.network.slice(-8)
      }
      return { authenticationEvidence: base?.authenticationEvidence ?? null, loginRequiredHeading: base?.loginRequiredHeading ?? null,
        rankingReadable: base?.rankingReadable ?? null, trace: result }
    },
    end() { active = false },
    dispose() {
      active = false
      page.off('request', onRequest); page.off('response', onResponse); page.off('requestfailed', onFailed)
    },
  }
}
