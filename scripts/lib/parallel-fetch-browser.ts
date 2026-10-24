import { lstat, readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import type { Browser, BrowserContext, BrowserContextOptions, Page } from 'playwright'
import { isParallelFetchInterval, PARALLEL_FETCH_MAX_CONCURRENCY } from '../../src/lib/parallelFetch.ts'
import { PARALLEL_FETCH_ERRORS } from '../../src/types/parallelFetch.ts'
import type { ParallelFetchErrorCode, ParallelFetchInterval, ParallelFetchReadDiagnostics, ParallelFetchTarget } from '../../src/types/parallelFetch.ts'
import { disableRankDistributionDiagnostics } from '../collect-rank-distribution.ts'
import { rankDistributionCloudBrowserEnvironment } from '../collect-rank-distribution-cloud.ts'
import { BUCKLER_SESSION_CAPTURE_PATH, createBucklerSessionStore, validateBucklerSessionState } from './buckler-session-store.ts'
import { createMrDistributionPageReader, MrDistributionDomError } from './mr-distribution-dom.ts'
import { mrDistributionPageUrl } from './mr-distribution-collector.ts'
import { rankBoundaryPageUrl, RANK_BOUNDARY_SOURCE_URL } from './rank-distribution-boundaries.ts'
import { createRankDistributionPageReader, RankDistributionDomError } from './rank-distribution-dom.ts'
import { ParallelFetchReadError } from './parallel-fetch-runner.ts'
import type { ParallelFetchNavigationGate, ParallelFetchReader } from './parallel-fetch-runner.ts'
import { createParallelFetchDiagnosticRecorder } from './parallel-fetch-diagnostics.ts'

type StorageState = Exclude<NonNullable<BrowserContextOptions['storageState']>, string>
export interface ParallelFetchBrowserSession {
  createReader(workerId: number, target: ParallelFetchTarget, signal: AbortSignal, intervalMs?: ParallelFetchInterval): Promise<ParallelFetchReader>
  close(): Promise<void>
}
export interface ParallelFetchBrowserDependencies {
  loadSession?(): Promise<StorageState>
  launch?(): Promise<Browser>
  createLpReader?: typeof createRankDistributionPageReader
  createMrReader?: typeof createMrDistributionPageReader
  now?(): number
  wait?(milliseconds: number, signal: AbortSignal): Promise<void>
}

/** Only visible challenge controls/headings are inspected; no page text leaves the browser. */
export function observeParallelFetchChallenge(): boolean {
  const visible = (element: Element): boolean => {
    const rect = element.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return false
    for (let parent: Element | null = element; parent; parent = parent.parentElement) {
      const style = window.getComputedStyle(parent)
      if (parent.hasAttribute('hidden') || style.display === 'none' || style.visibility === 'hidden'
        || style.visibility === 'collapse' || Number(style.opacity) === 0) return false
    }
    return true
  }
  return [...document.querySelectorAll('h1,h2')].filter(visible).some(element =>
    /ユーザーが人間であることを確認|セキュリティ検証|セキュリティ確認|Human Verification|Verify.*human|security verification|checking.*browser/i.test((element as HTMLElement).innerText ?? ''))
    || [...document.querySelectorAll('#amzn-captcha-verify-button,#challenge-stage,#challenge-running,iframe[src*="challenges.cloudflare.com"],[class*="cf-turnstile"]')].some(visible)
}

async function loadFixedSession(): Promise<StorageState> {
  try {
    disableRankDistributionDiagnostics(process.env)
    const store = createBucklerSessionStore()
    const { parseCaptureRecord } = await import('../probe-buckler-session.ts')
    await store.checkCapturePath(BUCKLER_SESSION_CAPTURE_PATH)
    const info = await lstat(BUCKLER_SESSION_CAPTURE_PATH)
    if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > 1024) throw new Error()
    const bytes = await readFile(BUCKLER_SESSION_CAPTURE_PATH)
    if (bytes.length !== info.size || bytes.length > 1024) throw new Error()
    const capture = parseCaptureRecord(JSON.parse(bytes.toString('utf8')))
    if (await store.identity() !== capture.stateIdentity) throw new Error()
    const state = validateBucklerSessionState(await store.load())
    if (await store.identity() !== capture.stateIdentity) throw new Error()
    await store.checkCapturePath(BUCKLER_SESSION_CAPTURE_PATH)
    return JSON.parse(state) as StorageState
  } catch { throw new ParallelFetchReadError('session-unavailable') }
}

async function launchFixedBrowser(): Promise<Browser> {
  disableRankDistributionDiagnostics(process.env)
  const { chromium } = await import('playwright')
  return chromium.launch({ channel: 'msedge', headless: false, timeout: 30000,
    env: rankDistributionCloudBrowserEnvironment(process.env) })
}

function safeReadCode(error: unknown): ParallelFetchErrorCode {
  if (error instanceof ParallelFetchReadError) return error.code
  if (error instanceof RankDistributionDomError || error instanceof MrDistributionDomError) {
    if (PARALLEL_FETCH_ERRORS.includes(error.code as ParallelFetchErrorCode)) return error.code as ParallelFetchErrorCode
    if (error.code === 'unsupported-rank-icon') return 'unsupported-dom'
    if (error.code === 'first-page-required' || error.code === 'concurrent-read') return 'invalid-request'
    if (error.code === 'total-count-changed') return 'condition-mismatch'
  }
  return error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'read-failed'
}

/** One browser/context per user-started run; each worker owns one independent Page. */
export async function createParallelFetchBrowserSession(options: { intervalMs: ParallelFetchInterval; signal: AbortSignal },
  dependencies: ParallelFetchBrowserDependencies = {}): Promise<ParallelFetchBrowserSession> {
  if (!isParallelFetchInterval(options.intervalMs)) throw new ParallelFetchReadError('invalid-request')
  const check = (): void => { if (options.signal.aborted) throw new ParallelFetchReadError('cancelled') }
  check()
  let state: StorageState
  try {
    state = JSON.parse(validateBucklerSessionState(JSON.stringify(await (dependencies.loadSession ?? loadFixedSession)()))) as StorageState
  } catch { throw new ParallelFetchReadError(options.signal.aborted ? 'cancelled' : 'session-unavailable') }
  check()
  let browser: Browser
  try { browser = await (dependencies.launch ?? launchFixedBrowser)() }
  catch { throw new ParallelFetchReadError(options.signal.aborted ? 'cancelled' : 'browser-unavailable') }
  let context: BrowserContext
  try {
    check()
    context = await browser.newContext({ locale: 'ja-JP', acceptDownloads: false, storageState: state })
    check()
  } catch {
    await browser.close().catch(() => {})
    throw new ParallelFetchReadError(options.signal.aborted ? 'cancelled' : 'browser-unavailable')
  } finally { state = undefined as unknown as StorageState }
  let closed = false
  const now = dependencies.now ?? (() => performance.now())
  const wait = dependencies.wait ?? (async (milliseconds, signal) => { await delay(milliseconds, undefined, { signal }) })
  const pages = new Set<Page>()
  let closing: Promise<void> | null = null
  const close = (): Promise<void> => {
    if (closing) return closing
    closed = true
    options.signal.removeEventListener('abort', aborted)
    closing = (async () => {
      await context.close().catch(() => {})
      await browser.close().catch(() => {})
      pages.clear()
    })()
    return closing
  }
  const aborted = (): void => { void close() }
  options.signal.addEventListener('abort', aborted, { once: true })
  if (options.signal.aborted) { await close(); throw new ParallelFetchReadError('cancelled') }
  return {
    async createReader(workerId, target, signal, intervalMs = options.intervalMs) {
      if (!isParallelFetchInterval(intervalMs)) throw new ParallelFetchReadError('invalid-request')
      if (!Number.isSafeInteger(workerId) || workerId < 1 || workerId > PARALLEL_FETCH_MAX_CONCURRENCY || !['lp', 'mr'].includes(target)) throw new ParallelFetchReadError('invalid-request')
      if (closed || options.signal.aborted || signal.aborted) throw new ParallelFetchReadError('cancelled')
      let page: Page
      try { page = await context.newPage() } catch { throw new ParallelFetchReadError(closed || signal.aborted ? 'cancelled' : 'browser-unavailable') }
      pages.add(page)
      let pageClosed = false
      let challenge = false, wafStopped = false, httpStatus: number | null = null, domObserved = false
      let rejectProtection: ((error: Error) => void) | null = null
      const recorder = createParallelFetchDiagnosticRecorder(page, now, () => {
        challenge = true; wafStopped = true
        // Subresources can demand CAPTCHA without displaying a visible challenge.
        // Reject the current read promptly; the runner stops all other workers.
        rejectProtection?.(new ParallelFetchReadError('human-verification'))
      })
      let pendingStop: { pageNumber: number; diagnostics?: ParallelFetchReadDiagnostics } | null = null
      const closePage = async (): Promise<void> => {
        if (pageClosed) return
        pageClosed = true
        recorder.dispose()
        signal.removeEventListener('abort', abortPage)
        pages.delete(page)
        await page.close().catch(() => {})
      }
      // The first auth-failure page survives the runner's collection abort for
      // passive inspection. The external run abort still closes the whole context.
      const abortPage = (): void => { if (!pendingStop || options.signal.aborted) void closePage() }
      signal.addEventListener('abort', abortPage, { once: true })
      if (closed || options.signal.aborted || signal.aborted) { await closePage(); throw new ParallelFetchReadError('cancelled') }
      let navigationGate: ParallelFetchNavigationGate | null = null
      const navigateWithPacing: ParallelFetchNavigationGate = navigate => {
        if (!navigationGate) throw new ParallelFetchReadError('invalid-request')
        return navigationGate(() => {
          recorder.begin()
          return navigate()
        })
      }
      const inspectChallenge = async (): Promise<void> => {
        if (wafStopped) throw new ParallelFetchReadError('human-verification')
        if (await page.evaluate(observeParallelFetchChallenge)) {
          challenge = true
          recorder.observe({ authenticationEvidence: null, loginRequiredHeading: null, rankingReadable: null, humanVerification: true })
          // Existing LP readers sanitize unknown errors; retain the challenge flag outside them.
          throw new RankDistributionDomError('unsupported-dom')
        }
      }
      const guarded = {
        async goto(...args: Parameters<Page['goto']>) {
          const response = await page.goto(...args)
          const status = response?.status()
          httpStatus = Number.isSafeInteger(status) && status! >= 100 && status! <= 599 ? status! : null
          await inspectChallenge()
          return response
        },
        async evaluate(fn: unknown, argument?: unknown) {
          await inspectChallenge()
          const value = await page.evaluate(fn as (value: unknown) => unknown, argument)
          domObserved = true
          return value
        },
        url: () => page.url(),
      } as unknown as Page
      const onObservation = (value: ParallelFetchReadDiagnostics) => recorder.observe({
        authenticationEvidence: value.authenticationEvidence, loginRequiredHeading: value.loginRequiredHeading,
        rankingReadable: value.rankingReadable, humanVerification: false,
      })
      const lp = target === 'lp' ? (dependencies.createLpReader ?? createRankDistributionPageReader)(guarded, {
        signal, navigateWithPacing, totalCountPolicy: 'record', allowReadablePagesAfterSignIn: false, onObservation,
      }) : null
      const mr = target === 'mr' ? (dependencies.createMrReader ?? createMrDistributionPageReader)(guarded, {
        signal, navigateWithPacing, allowReadablePagesAfterSignIn: false, onObservation,
      }) : null
      const readDiagnostics = (pageNumber: number): ParallelFetchReadDiagnostics | undefined => {
        // Only an observation made after this read's navigation may contribute.
        if (!domObserved) return undefined
        const value = lp ? lp.getDiagnostics() : mr!.getDiagnostics()
        if (value.lastAttemptedPage !== pageNumber) return undefined
        const evidence = value.lastAuthenticationEvidence
        const authenticationEvidence = evidence === 'logout-control' || evidence === 'login-control'
          || evidence === 'conflicting-controls' || evidence === 'no-control' ? evidence : null
        const loginRequiredHeading = typeof value.lastLoginRequiredHeading === 'boolean' ? value.lastLoginRequiredHeading : null
        const rankingReadable = typeof value.lastRankingReadable === 'boolean' ? value.lastRankingReadable : null
        if (authenticationEvidence === null && loginRequiredHeading === null && rankingReadable === null) return undefined
        return { authenticationEvidence, loginRequiredHeading, rankingReadable }
      }
      return {
        async readPage(pageNumber, navigateWithPacing) {
          if (closed || pageClosed || signal.aborted || options.signal.aborted) throw new ParallelFetchReadError('cancelled')
          if (wafStopped) throw new ParallelFetchReadError('human-verification')
          if (typeof navigateWithPacing !== 'function' || navigationGate) throw new ParallelFetchReadError('invalid-request')
          navigationGate = navigateWithPacing
          challenge = false; httpStatus = null; domObserved = false
          const protection = new Promise<never>((_, reject) => { rejectProtection = reject })
          try {
            const value = await Promise.race([protection, Promise.resolve().then(async () => lp
              ? await lp.fetchPage(pageNumber, rankBoundaryPageUrl(RANK_BOUNDARY_SOURCE_URL, pageNumber))
              : await mr!.fetchPage(pageNumber, mrDistributionPageUrl(pageNumber)))])
            if (closed || pageClosed || signal.aborted || options.signal.aborted) throw new ParallelFetchReadError('cancelled')
            // Rows/IDs/salts/URLs are deliberately discarded at this boundary.
            const diagnostics = recorder.snapshot(readDiagnostics(pageNumber), true)
            recorder.end()
            return { totalCount: value.totalCount, totalPages: value.totalPages, httpStatus, ...(diagnostics ? { diagnostics } : {}) }
          } catch (error) {
            const status = httpStatus
            const code = signal.aborted || options.signal.aborted || closed ? 'cancelled'
              : challenge ? 'human-verification' : status === 401 || status === 403 || status === 429 ? 'http-denied'
                : status !== null && status >= 500 ? 'server-error' : status !== null && status >= 400 ? 'http-error' : safeReadCode(error)
            const baseDiagnostics = readDiagnostics(pageNumber)
            if (code === 'human-verification') recorder.observe({ authenticationEvidence: baseDiagnostics?.authenticationEvidence ?? null,
              loginRequiredHeading: baseDiagnostics?.loginRequiredHeading ?? null, rankingReadable: baseDiagnostics?.rankingReadable ?? null,
              humanVerification: true })
            const diagnostics = recorder.snapshot(baseDiagnostics, code === 'server-error')
            if (code === 'authentication-unconfirmed') {
              pendingStop = { pageNumber, diagnostics }
              recorder.afterStop()
            } else recorder.end()
            throw new ParallelFetchReadError(code, status, diagnostics)
          } finally { navigationGate = null; rejectProtection = null }
        },
        async observeAfterStop(externalSignal) {
          const pending = pendingStop
          if (!pending) return undefined
          const started = now(), deadline = started + 30_000
          const combined = AbortSignal.any([externalSignal, options.signal])
          let outcome: 'observed' | 'cancelled' | 'page-unavailable' | 'human-verification' = 'observed'
          // page.evaluate has no built-in timeout. Bound each sample by the
          // remaining total observation window and by the user's stop signal.
          async function boundedSample<T>(sample: () => Promise<T>): Promise<T> {
            if (combined.aborted) throw new Error('cancelled')
            let timer: ReturnType<typeof setTimeout> | undefined
            let abort: () => void = () => {}
            try {
              return await Promise.race([sample(), new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error('page-unavailable')), Math.max(1, deadline - now()))
                abort = () => reject(new Error('cancelled'))
                combined.addEventListener('abort', abort, { once: true })
                if (combined.aborted) abort()
              })])
            } finally { clearTimeout(timer); combined.removeEventListener('abort', abort) }
          }
          try {
            if (combined.aborted) throw new Error('cancelled')
            if (closed || pageClosed) throw new Error('page-unavailable')
            while (now() < deadline) {
              const value = await boundedSample(() => (lp ?? mr!).observeCurrentPage(pending.pageNumber))
              recorder.observe({ ...value, humanVerification: false }, true)
              const remaining = deadline - now()
              if (remaining <= 0) break
              await wait(Math.min(5000, remaining), combined)
            }
          } catch (error) {
            outcome = combined.aborted ? 'cancelled'
              : challenge || safeReadCode(error) === 'human-verification' ? 'human-verification' : 'page-unavailable'
            if (outcome === 'human-verification') recorder.observe({ authenticationEvidence: null, loginRequiredHeading: null,
              rankingReadable: null, humanVerification: true })
          } finally {
            pendingStop = null
            recorder.postStop({ durationMs: Math.min(30_000, Math.max(0, now() - started)), outcome })
            recorder.end()
          }
          return recorder.snapshot(pending.diagnostics)
        },
        close: closePage,
      }
    },
    close,
  }
}
