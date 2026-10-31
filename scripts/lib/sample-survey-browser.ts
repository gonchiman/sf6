import type { Page } from 'playwright'
import type { SampleSurveyError, SampleSurveyTarget } from '../../src/types/sampleSurvey.ts'
import { createParallelFetchBrowserSession } from './parallel-fetch-browser.ts'
import type { ParallelFetchBrowserDependencies, ParallelFetchBrowserSession } from './parallel-fetch-browser.ts'
import { ParallelFetchReadError } from './parallel-fetch-runner.ts'
import type { ParallelFetchReader } from './parallel-fetch-runner.ts'
import type { RankBoundaryPage } from './rank-distribution-boundaries.ts'
import type { MrDistributionPage } from './mr-distribution-collector.ts'
import { SampleSurveyReadError, SampleSurveyRetryableReadError } from './sample-survey-reader.ts'
import type { SampleSurveyPage, SampleSurveyReader } from './sample-survey-reader.ts'
import { createRankDistributionPageReader } from './rank-distribution-dom.ts'
import { createMrDistributionPageReader } from './mr-distribution-dom.ts'
import { createSampleSurveyDiagnostics } from './sample-survey-diagnostics.ts'
import type { SampleSurveyFailureDiagnostic } from './sample-survey-diagnostics.ts'

interface PrivateRow { accountId: string; accountKey: string; value: number; rankId: number | null }
interface PrivateRows {
  selectedPage: number
  range: { from: number; to: number; total: number }
  rows: PrivateRow[]
}

/** Rendered public ranking links only. This private result must never enter diagnostics or frontend JSON. */
export async function observeSampleSurveyRows(input: { target: SampleSurveyTarget; salt: string }): Promise<PrivateRows | null> {
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
  const text = (element: Element): string => (element as HTMLElement).innerText?.trim() ?? ''
  const controls = [...document.querySelectorAll('a,button')].filter(visible)
    .filter(element => !element.closest('a[href*="/profile/"],ul[class*="ranking_ranking_list"]'))
  const label = (element: Element): string => text(element) || element.getAttribute('aria-label') || ''
  const logout = controls.some(element => /^(ログアウト|sign\s*out|log\s*out)$/i.test(label(element)))
  const login = controls.some(element => /^(ログイン(?:\s*\/\s*新規登録)?|log\s*in|sign\s*in)$/i.test(label(element)))
  if (!logout || login) return null
  const headings = [...document.querySelectorAll('h1,h2')].filter(visible).map(text)
  if (headings.some(value => /ログインが必要|ログインしてください|メンテナンス|Maintenance|ユーザーが人間であることを確認|Human Verification|セキュリティ検証|Verify.*human/i.test(value))) return null
  const selects = [...document.querySelectorAll('select')].filter(visible) as HTMLSelectElement[]
  const pages = selects.slice(input.target === 'lp' ? 4 : 3).map(select => select.value)
  if (pages.length !== 2 || !pages.every(value => /^[1-9]\d*$/.test(value) && value === pages[0])
    || !Number.isSafeInteger(Number(pages[0]))) return null
  const counters = [...new Set([...document.querySelectorAll('p')].filter(visible).map(text)
    .filter(value => /^\d+\s*-\s*\d+\s*\/\s*\d+$/.test(value)))]
  const counter = counters.length === 1 ? /^(\d+)\s*-\s*(\d+)\s*\/\s*(\d+)$/.exec(counters[0]) : null
  if (!counter) return null
  const range = { from: Number(counter[1]), to: Number(counter[2]), total: Number(counter[3]) }
  const lists = [...document.querySelectorAll('ul[class*="ranking_ranking_list"]:not([class*="ranking__my__list"])')].filter(visible)
  if (lists.length !== 1) return null
  const links = [...lists[0].querySelectorAll(input.target === 'lp' ? 'a[href*="/profile/"]' : 'li > a[href*="/profile/"]')].filter(visible)
  const rows: PrivateRow[] = []
  for (const link of links) {
    try {
      const points = [...link.querySelectorAll('dd')].filter(visible)
      const pointPattern = input.target === 'lp' ? /^(\d+)LP$/ : /^(\d+)MR$/
      const match = points.length === 1 ? pointPattern.exec(text(points[0])) : null
      if (!match || !Number.isSafeInteger(Number(match[1]))) return null
      const profile = new URL(link.getAttribute('href') ?? '', location.origin)
      const id = /^\/6\/buckler\/ja-jp\/profile\/(\d{1,32})$/.exec(profile.pathname)
      if (profile.origin !== 'https://www.streetfighter.com' || profile.username || profile.password
        || profile.search || profile.hash || !id) return null
      let rankId: number | null = null
      if (input.target === 'lp') {
        const images = [...link.querySelectorAll('div[class*="ranking_league_rank_icon"] img')].filter(visible) as HTMLImageElement[]
        if (images.length !== 1 || !images[0].complete || images[0].naturalWidth <= 0) return null
        let asset = new URL(images[0].currentSrc, location.origin)
        if (asset.origin !== 'https://www.streetfighter.com' || asset.username || asset.password || asset.hash) return null
        if (asset.pathname === '/_next/image' || asset.pathname === '/6/buckler/_next/image') {
          if (asset.searchParams.getAll('url').length !== 1 || [...asset.searchParams.keys()].some(key => !['url', 'w', 'q'].includes(key))) return null
          asset = new URL(asset.searchParams.get('url')!, location.origin)
        }
        const rank = /^\/6\/buckler\/assets\/images\/material\/rank\/rank([1-9]|[12]\d|3[0-6])_l\.png$/.exec(asset.pathname)
        if (asset.origin !== 'https://www.streetfighter.com' || asset.username || asset.password || asset.search || asset.hash || !rank) return null
        rankId = Number(rank[1])
      }
      const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${input.salt}:${profile.pathname}`))
      const accountKey = [...new Uint8Array(hash)].map(value => value.toString(16).padStart(2, '0')).join('')
      rows.push({ accountId: id[1], accountKey, value: Number(match[1]), rankId })
    } catch { return null }
  }
  return { selectedPage: Number(pages[0]), range, rows }
}

export interface SampleSurveyBrowserDependencies {
  browser?: Omit<ParallelFetchBrowserDependencies, 'onValidatedPage'>
  createSession?: typeof createParallelFetchBrowserSession
  now?(): number
}

const SAFE_ERRORS = new Set<SampleSurveyError>(['cancelled', 'limit-reached', 'human-verification', 'http-denied',
  'login-required', 'authentication-unconfirmed', 'maintenance', 'server-error', 'http-error', 'timeout',
  'read-failed', 'condition-mismatch', 'page-mismatch', 'frame-changed', 'session-unavailable', 'browser-unavailable', 'invalid-request'])
function safeError(error: unknown, signal: AbortSignal): SampleSurveyReadError {
  if (signal.aborted) return new SampleSurveyReadError('cancelled')
  if (error instanceof SampleSurveyReadError) return new SampleSurveyReadError(error.code)
  if (error instanceof ParallelFetchReadError && SAFE_ERRORS.has(error.code as SampleSurveyError)) return new SampleSurveyReadError(error.code as SampleSurveyError)
  return new SampleSurveyReadError('read-failed')
}

/** Eligibility permits a new strict read, never accepting the failed page. */
function retryReadStatus(error: unknown, priorStrictSuccess: boolean): 200 | 502 | 503 | 504 | null {
  if (!(error instanceof ParallelFetchReadError)) return null
  const diagnostics = error.diagnostics, trace = diagnostics?.trace
  if (!trace || trace.droppedObservations !== 0 || trace.droppedNetworkEvents !== 0 || trace.postStop
    || diagnostics.loginRequiredHeading === true
    || trace.observations.some(row => row.phase !== 'read' || row.humanVerification !== false || row.loginRequiredHeading === true)
    || trace.network.some(row => row.phase !== 'read' || row.kind === 'waf-action'
      || row.wafAction === 'captcha' || row.wafAction === 'challenge'
      || row.status !== null && row.status >= 400 && row.status < 500
      || row.kind === 'http-error' && row.wafAction !== null)) return null
  const transient = (status: number | null): status is 502 | 503 | 504 => status === 502 || status === 503 || status === 504
  // A failing main response is unambiguous even before the first authenticated page.
  if (error.code === 'server-error' && transient(error.httpStatus)
    && trace.network.some(row => row.kind === 'http-error' && row.site === 'buckler'
      && row.resource === 'document' && row.status === error.httpStatus && row.wafAction === null)) return error.httpStatus
  // The LP/MR reader sets rankingReadable only for this requested page's URL,
  // selected filters/rank labels or Act, complete row range and validated entries.
  // parallel-fetch-browser also rejects stale diagnostics from another navigation.
  if (error.code !== 'authentication-unconfirmed' || !priorStrictSuccess || error.httpStatus !== 200
    || diagnostics.authenticationEvidence !== 'login-control' || diagnostics.loginRequiredHeading !== false
    || diagnostics.rankingReadable !== true || trace.observations.length === 0) return null
  const event = trace.network.find(row => row.kind === 'http-error' && row.site === 'buckler'
    && (row.resource === 'fetch' || row.resource === 'xhr') && transient(row.status) && row.wafAction === null)
  // An otherwise complete HTTP 200 page can lose its header's authentication
  // evidence without a recorded 5xx. Only a new strict read may recover it;
  // the failed page remains rejected and the session/target stay unchanged.
  return event && transient(event.status) ? event.status : 200
}

async function readPrivateRows(page: Pick<Page, 'evaluate'>, target: SampleSurveyTarget, salt: string,
  signal: AbortSignal): Promise<PrivateRows | null> {
  if (signal.aborted) throw new ParallelFetchReadError('cancelled')
  let timer: ReturnType<typeof setTimeout> | undefined
  let abort = (): void => {}
  try {
    return await Promise.race([page.evaluate(observeSampleSurveyRows, { target, salt }), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new ParallelFetchReadError('timeout')), 30000)
      abort = () => reject(new ParallelFetchReadError('cancelled'))
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    })])
  } finally { clearTimeout(timer); signal.removeEventListener('abort', abort) }
}

function validatedPrivatePage(target: SampleSurveyTarget, snapshot: RankBoundaryPage | MrDistributionPage,
  capture: PrivateRows | null, observedAt: string): SampleSurveyPage {
  const integer = (value: unknown, minimum = 0): value is number => Number.isSafeInteger(value) && Number(value) >= minimum
  if (!capture || !integer(snapshot.page, 1) || !integer(snapshot.pageSize, 1) || snapshot.pageSize > 20
    || !integer(snapshot.totalCount, 1) || snapshot.totalPages !== Math.ceil(snapshot.totalCount / snapshot.pageSize)
    || capture.selectedPage !== snapshot.page || capture.range.total !== snapshot.totalCount
    || capture.range.from !== (snapshot.page - 1) * snapshot.pageSize + 1
    || capture.range.to !== Math.min(snapshot.page * snapshot.pageSize, snapshot.totalCount)
    || capture.rows.length !== capture.range.to - capture.range.from + 1 || capture.rows.length !== snapshot.entries.length
    || new Set(capture.rows.map(row => row.accountId)).size !== capture.rows.length) throw new ParallelFetchReadError('condition-mismatch')
  const rows = capture.rows.map((row, index) => {
    const expected = snapshot.entries[index]
    const value = target === 'lp' && 'leaguePoint' in expected ? expected.leaguePoint
      : target === 'mr' && 'masterRating' in expected ? expected.masterRating : null
    const rankId = target === 'lp' && 'rankId' in expected ? expected.rankId : null
    if (!/^\d{1,32}$/.test(row.accountId) || !/^[a-f0-9]{64}$/.test(row.accountKey) || row.accountKey !== expected.accountKey
      || !integer(row.value) || row.value !== value || row.rankId !== rankId
      || target === 'lp' && (!integer(rankId, 1) || rankId > 36)) throw new ParallelFetchReadError('condition-mismatch')
    return { accountId: row.accountId, value: row.value, rankId: row.rankId }
  })
  return { target, page: snapshot.page, pageSize: snapshot.pageSize, totalCount: snapshot.totalCount,
    totalPages: snapshot.totalPages, observedAt, entries: rows }
}

/** One private browser session; the runner controls global navigation spacing and limits. */
export async function createSampleSurveyReader(options: {
  signal: AbortSignal
  onReadFailure?(diagnostic: SampleSurveyFailureDiagnostic): Promise<void> | void
}, dependencies: SampleSurveyBrowserDependencies = {}): Promise<SampleSurveyReader> {
  const diagnostic = createSampleSurveyDiagnostics()
  let failureEmitted = false, pendingFailure: SampleSurveyFailureDiagnostic | null = null
  const emitFailure = async (value: SampleSurveyFailureDiagnostic) => {
    if (failureEmitted) return
    failureEmitted = true
    try { await options.onReadFailure?.(value) } catch { /* Diagnostics never replace the original failure. */ }
  }
  const recordFailure = async (error: unknown) => {
    await emitFailure(diagnostic.failure(error))
  }
  let pendingCapture: SampleSurveyPage | null = null
  let readingTarget: SampleSurveyTarget | null = null
  let closed = false, closing: Promise<void> | null = null
  const shutdown = new AbortController()
  const readSignal = AbortSignal.any([options.signal, shutdown.signal])
  const readers = new Map<SampleSurveyTarget, ParallelFetchReader>()
  const strictTargets = new Set<SampleSurveyTarget>()
  const now = dependencies.now ?? Date.now
  let session: ParallelFetchBrowserSession
  try {
    session = await (dependencies.createSession ?? createParallelFetchBrowserSession)({ intervalMs: 10000, signal: options.signal, headless: false }, {
      ...dependencies.browser,
      createLpReader: (page, readerOptions) => (dependencies.browser?.createLpReader ?? createRankDistributionPageReader)(diagnostic.wrapPage(page, 'lp'), readerOptions),
      createMrReader: (page, readerOptions) => (dependencies.browser?.createMrReader ?? createMrDistributionPageReader)(diagnostic.wrapPage(page, 'mr'), readerOptions),
      onValidatedPage: async ({ target, snapshot, page, identitySalt }) => {
        if (closed || options.signal.aborted) throw new ParallelFetchReadError('cancelled')
        if (target !== readingTarget) throw new ParallelFetchReadError('invalid-request')
        diagnostic.mark('capture-start')
        const capture = await readPrivateRows(diagnostic.wrapPage(page as Page, target), target, identitySalt, readSignal)
        if (closed || options.signal.aborted) throw new ParallelFetchReadError('cancelled')
        pendingCapture = validatedPrivatePage(target, snapshot, capture, new Date(now()).toISOString())
        diagnostic.mark('capture-complete')
      },
    })
  } catch (error) { await recordFailure(error); throw safeError(error, options.signal) }
  const close = (): Promise<void> => {
    if (closing) return closing
    closed = true; pendingCapture = null
    shutdown.abort()
    options.signal.removeEventListener('abort', abort)
    const retained = pendingFailure; pendingFailure = null
    closing = (async () => {
      // The runner may stop before a second read because of its time/read/retry
      // budget. Preserve the original fixed evidence in that case as well.
      if (retained) await emitFailure(retained)
      await session.close().catch(() => {})
    })()
    return closing
  }
  const abort = (): void => { void close() }
  options.signal.addEventListener('abort', abort, { once: true })
  if (options.signal.aborted) { await close(); throw new SampleSurveyReadError('cancelled') }
  return {
    async readPage(target, pageNumber) {
      if (closed || options.signal.aborted) throw new SampleSurveyReadError('cancelled')
      if (!['lp', 'mr'].includes(target) || !Number.isSafeInteger(pageNumber) || pageNumber < 1 || readingTarget !== null) throw new SampleSurveyReadError('invalid-request')
      readingTarget = target; pendingCapture = null
      try {
        let reader = readers.get(target)
        if (!reader) {
          if (pageNumber !== 1) throw new SampleSurveyReadError('invalid-request')
          reader = await session.createReader(target === 'lp' ? 1 : 2, target, options.signal, 10000)
          readers.set(target, reader)
        }
        const summary = await reader.readPage(pageNumber, navigate => navigate())
        if (closed || options.signal.aborted) throw new SampleSurveyReadError('cancelled')
        const value = pendingCapture as SampleSurveyPage | null
        if (!value || value.target !== target || value.page !== pageNumber || value.totalCount !== summary.totalCount
          || value.totalPages !== summary.totalPages) throw new SampleSurveyReadError('read-failed')
        strictTargets.add(target)
        pendingFailure = null
        return value
      } catch (error) {
        pendingCapture = null
        const transient = !closed && !options.signal.aborted ? retryReadStatus(error, strictTargets.has(target)) : null
        if (transient !== null && error instanceof ParallelFetchReadError
          && (error.code === 'server-error' || error.code === 'authentication-unconfirmed')) {
          pendingFailure = diagnostic.failure(error)
          throw new SampleSurveyRetryableReadError(error.code, transient)
        }
        pendingFailure = null
        await recordFailure(error)
        await close()
        throw safeError(error, options.signal)
      } finally { readingTarget = null; pendingCapture = null }
    },
    close,
  }
}
