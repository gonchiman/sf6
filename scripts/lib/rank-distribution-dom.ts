import { randomBytes } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { Page } from 'playwright'
import { rankBoundaryPageUrl, RANK_BOUNDARY_SOURCE_URL } from './rank-distribution-boundaries.ts'
import type { RankBoundaryEntry, RankBoundaryPage } from './rank-distribution-boundaries.ts'

export type RankDistributionDomErrorCode = 'invalid-request' | 'concurrent-read' | 'first-page-required'
  | 'cancelled' | 'http-denied' | 'http-error' | 'server-error' | 'maintenance' | 'login-required'
  | 'authentication-unconfirmed' | 'condition-mismatch' | 'page-mismatch' | 'unsupported-rank-icon'
  | 'unsupported-dom' | 'total-count-changed' | 'timeout' | 'read-failed'

/** Messages contain fixed descriptions only, never browser errors or page text. */
export class RankDistributionDomError extends Error {
  readonly code: RankDistributionDomErrorCode
  constructor(code: RankDistributionDomErrorCode) {
    super(`ランク分布の画面取得を中止しました (${code})。`)
    this.name = 'RankDistributionDomError'
    this.code = code
  }
}

export interface RankDistributionDomObservation {
  maintenance: boolean
  loginRequired: boolean
  signedIn: boolean | null
  conditionsMatch: boolean | null
  leagueLabelsMatch: boolean | null
  selectedPage: number | null
  range: { from: number; to: number; total: number } | null
  rankIcons: 'ready' | 'pending' | 'unsupported'
  /** Salted keys are private, transient duplicate checks, never diagnostics. */
  entries: RankBoundaryEntry[] | null
}

/**
 * Reads rendered controls, counters, row LP and loaded rank images only. Normal
 * scrolling lets the site's lazy images load. No names, raw IDs, HTML, browser
 * storage, application state or network responses leave this observation.
 */
export async function observeRankDistributionDom(input: { salt: string }): Promise<RankDistributionDomObservation> {
  // A previous image pass (or restored navigation scroll) can leave the page at
  // the bottom. Observe the ordinary header at a consistent scroll position.
  window.scrollTo?.({ top: 0, left: 0, behavior: 'instant' })
  await new Promise<void>(resolve => setTimeout(resolve, 30))
  const visible = (element: Element): boolean => {
    const rect = element.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return false
    for (let ancestor: Element | null = element; ancestor; ancestor = ancestor.parentElement) {
      const style = window.getComputedStyle(ancestor)
      if (ancestor.hasAttribute('hidden') || style.display === 'none'
        || style.visibility === 'hidden' || style.visibility === 'collapse' || Number(style.opacity) === 0) return false
    }
    return true
  }
  const text = (element: Element): string => (element as HTMLElement).innerText?.trim() ?? ''
  const headings = [...document.querySelectorAll('h1,h2')].filter(visible)
  const maintenance = headings.some(element => /ただいま、システムメンテナンス中|^Maintenance\b/i.test(text(element)))
  const controls = [...document.querySelectorAll('a,button')].filter(visible)
    .filter(element => !element.closest('a[href*="/profile/"],ul[class*="ranking_ranking_list"]'))
  const label = (element: Element): string => text(element) || element.getAttribute('aria-label') || ''
  const hasLogout = controls.some(element => /^(ログアウト|sign\s*out|log\s*out)$/i.test(label(element)))
  const hasLogin = controls.some(element => /^(ログイン(?:\s*\/\s*新規登録)?|log\s*in|sign\s*in)$/i.test(label(element)))
  const signedIn = hasLogout && hasLogin ? null : hasLogout ? true : hasLogin ? false : null
  const loginRequired = signedIn !== true && headings.some(element => /ログインが必要|ログインしてください|login required|sign in required/i.test(text(element)))
  const selects = [...document.querySelectorAll('select')].filter(visible) as HTMLSelectElement[]
  const selectedLabel = (select: HTMLSelectElement): string => select.selectedOptions.length === 1
    ? select.selectedOptions[0].textContent?.trim() ?? '' : ''
  const conditionsMatch = selects.length < 6 ? null
    : selects.length === 6 && selects.slice(0, 4).map(select => select.value).join(',') === '0,2,0,1'
      && selects.slice(0, 4).map(selectedLabel).join(',') === '総合,最大LP,すべて,すべて'
  const groups = ['Rookie', 'Iron', 'Bronze', 'Silver', 'Gold', 'Platinum', 'Diamond']
  const expectedLabels = ['総合', ...groups.flatMap(group => Array.from({ length: 5 }, (_, i) => `${group}${i + 1}`)), 'Master']
  const leagueOptions = selects[0] ? [...selects[0].options] : []
  const leagueLabelsMatch = selects.length === 0 ? null : leagueOptions.length === 37
    && leagueOptions.every((option, index) => option.value === String(index) && option.textContent?.trim() === expectedLabels[index])
  const pageValues = selects.slice(4).map(select => select.value)
  const selectedPage = pageValues.length === 2 && pageValues.every(value => /^[1-9]\d*$/.test(value) && value === pageValues[0])
    && Number.isSafeInteger(Number(pageValues[0])) ? Number(pageValues[0]) : null
  const counters = [...new Set([...document.querySelectorAll('p')].filter(visible).map(text)
    .filter(value => /^\d+\s*-\s*\d+\s*\/\s*\d+$/.test(value)))]
  const counter = counters.length === 1 ? counters[0].match(/^(\d+)\s*-\s*(\d+)\s*\/\s*(\d+)$/) : null
  const range = counter ? { from: Number(counter[1]), to: Number(counter[2]), total: Number(counter[3]) } : null
  const base = { maintenance, loginRequired, signedIn, conditionsMatch, leagueLabelsMatch, selectedPage, range }
  if (maintenance || loginRequired) return { ...base, rankIcons: 'pending', entries: null }
  const lists = [...document.querySelectorAll('ul[class*="ranking_ranking_list"]:not([class*="ranking__my__list"])')].filter(visible)
  if (lists.length !== 1) return { ...base, rankIcons: 'pending', entries: null }
  const links = [...lists[0].querySelectorAll('a[href*="/profile/"]')].filter(visible)
  const entries: RankBoundaryEntry[] = []
  let pending = false
  for (const link of links) {
    const ranks = [...link.querySelectorAll('dt')]
    const points = [...link.querySelectorAll('dd')]
    const icons = [...link.querySelectorAll('div[class*="ranking_league_rank_icon"]')].filter(visible)
    if (ranks.length !== 1 || points.length !== 1 || !/^\d+位$/.test(text(ranks[0]))
      || !/^\d+LP$/.test(text(points[0])) || icons.length !== 1) return { ...base, rankIcons: 'pending', entries: null }
    // This changes scroll position only; it does not change the image's attributes.
    icons[0].scrollIntoView({ block: 'center', inline: 'nearest' })
    await new Promise<void>(resolve => setTimeout(resolve, 20))
    const images = [...icons[0].querySelectorAll('img')].filter(visible) as HTMLImageElement[]
    if (images.length !== 1) return { ...base, rankIcons: 'unsupported', entries: null }
    const image = images[0]
    if (!image.complete || image.naturalWidth <= 0 || !image.currentSrc || image.currentSrc.startsWith('data:')) {
      pending = true
      continue
    }
    let rankId: number
    try {
      let asset = new URL(image.currentSrc, location.origin)
      if (asset.origin !== 'https://www.streetfighter.com' || asset.username || asset.password || asset.hash) throw new Error()
      if (asset.pathname === '/_next/image' || asset.pathname === '/6/buckler/_next/image') {
        if (asset.searchParams.getAll('url').length !== 1
          || [...asset.searchParams.keys()].some(key => !['url', 'w', 'q'].includes(key))) throw new Error()
        asset = new URL(asset.searchParams.get('url')!, location.origin)
      }
      if (asset.origin !== 'https://www.streetfighter.com' || asset.username || asset.password || asset.search || asset.hash) throw new Error()
      const match = asset.pathname.match(/^\/6\/buckler\/assets\/images\/material\/rank\/rank([1-9]|[12]\d|3[0-6])_l\.png$/)
      if (!match) throw new Error()
      rankId = Number(match[1])
    } catch { return { ...base, rankIcons: 'unsupported', entries: null } }
    let accountKey: string
    try {
      const profile = new URL(link.getAttribute('href') ?? '', location.origin)
      if (profile.origin !== 'https://www.streetfighter.com' || profile.username || profile.password || profile.search || profile.hash
        || !/^\/6\/buckler\/ja-jp\/profile\/\d+$/.test(profile.pathname)) throw new Error()
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${input.salt}:${profile.pathname}`))
      accountKey = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('')
    } catch { return { ...base, rankIcons: 'pending', entries: null } }
    entries.push({ rankId, leaguePoint: Number(text(points[0]).slice(0, -2)), accountKey })
  }
  return { ...base, rankIcons: pending ? 'pending' : 'ready', entries: pending ? null : entries }
}

export interface RankDistributionPageReaderDiagnostics {
  requestCount: number
  successfulReadCount: number
  pageSize: number | null
  totalCount: number | null
  lastPage: number | null
  /** Most recently validated page total, including a total that stopped collection. */
  lastObservedTotal?: number | null
  /** Page whose navigation was most recently started, including unsuccessful reads. */
  lastAttemptedPage?: number | null
  /** Numeric status of the most recent navigation response; no headers or body. */
  lastHttpStatus?: number | null
  minimumObservedTotal?: number | null
  maximumObservedTotal?: number | null
  rankMappingConfirmed: boolean
  observedRankIds: number[]
  tailRankIds: number[]
  leagueLabelsConfirmed: boolean
  displayedConditionsConfirmed: boolean
  /** user_status has no separately confirmed visible selector. */
  userStatusEvidence: 'fixed-url-only'
}

export interface RankDistributionPageReaderOptions {
  signal?: AbortSignal
  /** Recording a changing total is only for the explicitly labelled interval estimate. */
  totalCountPolicy?: 'stable' | 'record'
  /** Delay between navigations, not an automatic retry policy. */
  minIntervalMs?: number
  timeoutMs?: number
  now?: () => number
  wait?: (milliseconds: number) => Promise<void>
}

export function createRankDistributionPageReader(page: Page, options: RankDistributionPageReaderOptions = {}) {
  const minInterval = options.minIntervalMs ?? 500
  const timeout = options.timeoutMs ?? 10_000
  const totalCountPolicy = options.totalCountPolicy ?? 'stable'
  if (!Number.isSafeInteger(minInterval) || minInterval < 250 || minInterval > 10_000
    || !Number.isSafeInteger(timeout) || timeout < 1 || timeout > 10_000
    || !['stable', 'record'].includes(totalCountPolicy)) throw new RankDistributionDomError('invalid-request')
  const now = options.now ?? Date.now
  const wait = options.wait ?? (async (milliseconds: number) => { await delay(milliseconds, undefined, { signal: options.signal }) })
  const salt = randomBytes(32).toString('hex')
  const diagnostics: RankDistributionPageReaderDiagnostics = {
    requestCount: 0, successfulReadCount: 0, pageSize: null, totalCount: null, lastPage: null,
    lastObservedTotal: null, lastAttemptedPage: null, lastHttpStatus: null,
    minimumObservedTotal: null, maximumObservedTotal: null,
    rankMappingConfirmed: false, observedRankIds: [], tailRankIds: [],
    leagueLabelsConfirmed: false, displayedConditionsConfirmed: false, userStatusEvidence: 'fixed-url-only',
  }
  let running = false
  let lastNavigation: number | null = null
  function checkCancelled(): void { if (options.signal?.aborted) throw new RankDistributionDomError('cancelled') }
  function confirmedUrl(url: string, pageNumber: number): boolean {
    try {
      return new URL(url).searchParams.getAll('page').length === 1 && new URL(url).searchParams.get('page') === String(pageNumber)
        && rankBoundaryPageUrl(url, pageNumber) === rankBoundaryPageUrl(RANK_BOUNDARY_SOURCE_URL, pageNumber)
    } catch { return false }
  }
  async function fetchPage(pageNumber: number, url: string): Promise<RankBoundaryPage> {
    checkCancelled()
    if (!Number.isSafeInteger(pageNumber) || pageNumber < 1 || !confirmedUrl(url, pageNumber)) throw new RankDistributionDomError('invalid-request')
    if (running) throw new RankDistributionDomError('concurrent-read')
    if (diagnostics.pageSize === null && pageNumber !== 1) throw new RankDistributionDomError('first-page-required')
    running = true
    try {
      if (lastNavigation !== null) await wait(Math.max(0, minInterval - (now() - lastNavigation)))
      checkCancelled()
      lastNavigation = now()
      diagnostics.requestCount++
      diagnostics.lastAttemptedPage = pageNumber
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
      checkCancelled()
      const status = response?.status()
      diagnostics.lastHttpStatus = status !== undefined && Number.isSafeInteger(status) && status >= 0 && status <= 599 ? status : null
      if (status === 401 || status === 403 || status === 429) throw new RankDistributionDomError('http-denied')
      if (status !== undefined && status >= 500 && status <= 599) throw new RankDistributionDomError('server-error')
      if (status !== undefined && status >= 400) throw new RankDistributionDomError('http-error')
      const deadline = now() + timeout
      let latest: RankDistributionDomObservation | null = null
      do {
        checkCancelled()
        latest = await page.evaluate(observeRankDistributionDom, { salt })
        checkCancelled()
        if (latest.maintenance) throw new RankDistributionDomError('maintenance')
        if (latest.loginRequired) throw new RankDistributionDomError('login-required')
        if (!confirmedUrl(page.url(), pageNumber)) throw new RankDistributionDomError('page-mismatch')
        if (latest.conditionsMatch === false || latest.leagueLabelsMatch === false) throw new RankDistributionDomError('condition-mismatch')
        if (latest.rankIcons === 'unsupported') throw new RankDistributionDomError('unsupported-rank-icon')
        const { range, entries } = latest
        if (latest.signedIn === true && latest.conditionsMatch === true && latest.leagueLabelsMatch === true
          && latest.selectedPage === pageNumber && latest.rankIcons === 'ready' && range && entries) {
          const size = diagnostics.pageSize ?? (pageNumber === 1 && range.from === 1 && range.to === entries.length ? entries.length : 0)
          const validInteger = (value: unknown, minimum: number): value is number => Number.isSafeInteger(value) && (value as number) >= minimum
          const totalPages = size > 0 ? Math.ceil(range.total / size) : 0
          if (validInteger(size, 1) && size <= 20 && validInteger(range.total, 1)
            && validInteger(range.from, 1) && validInteger(range.to, 1)
            && range.from === (pageNumber - 1) * size + 1 && range.to === Math.min(pageNumber * size, range.total)
            && range.to >= range.from && entries.length === range.to - range.from + 1 && pageNumber <= totalPages
            && (pageNumber !== 1 || entries.length === Math.min(20, range.total))
            && entries.every(entry => validInteger(entry.leaguePoint, 0) && validInteger(entry.rankId, 1) && entry.rankId <= 36
              && typeof entry.accountKey === 'string' && /^[a-f0-9]{64}$/.test(entry.accountKey))
            && new Set(entries.map(entry => entry.accountKey)).size === entries.length) {
            diagnostics.lastObservedTotal = range.total
            diagnostics.minimumObservedTotal = Math.min(diagnostics.minimumObservedTotal ?? range.total, range.total)
            diagnostics.maximumObservedTotal = Math.max(diagnostics.maximumObservedTotal ?? range.total, range.total)
            if (totalCountPolicy === 'stable' && diagnostics.totalCount !== null && diagnostics.totalCount !== range.total) throw new RankDistributionDomError('total-count-changed')
            diagnostics.pageSize = size
            diagnostics.totalCount = range.total
            diagnostics.lastPage = latest.selectedPage
            diagnostics.rankMappingConfirmed = true
            diagnostics.successfulReadCount++
            diagnostics.displayedConditionsConfirmed = true
            diagnostics.leagueLabelsConfirmed = true
            diagnostics.observedRankIds = [...new Set([...diagnostics.observedRankIds, ...entries.map(entry => entry.rankId)])].sort((a, b) => a - b)
            if (pageNumber === totalPages) diagnostics.tailRankIds = [...new Set(entries.map(entry => entry.rankId))].sort((a, b) => a - b)
            return { sourceUrl: page.url(), page: latest.selectedPage, pageSize: size, totalCount: range.total, totalPages,
              entries: entries.map(entry => ({ leaguePoint: entry.leaguePoint, rankId: entry.rankId, accountKey: entry.accountKey })) }
          }
        }
        if (now() >= deadline) break
        await wait(250)
      } while (now() < deadline)
      if (latest?.signedIn !== true) throw new RankDistributionDomError(latest?.signedIn === false ? 'login-required' : 'authentication-unconfirmed')
      throw new RankDistributionDomError(latest?.selectedPage !== pageNumber ? 'page-mismatch' : 'unsupported-dom')
    } catch (error) {
      if (options.signal?.aborted) throw new RankDistributionDomError('cancelled')
      if (error instanceof RankDistributionDomError) throw error
      throw new RankDistributionDomError(error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'read-failed')
    } finally { running = false }
  }
  return {
    fetchPage,
    getDiagnostics: (): RankDistributionPageReaderDiagnostics => ({ ...diagnostics,
      observedRankIds: [...diagnostics.observedRankIds], tailRankIds: [...diagnostics.tailRankIds] }),
  }
}
