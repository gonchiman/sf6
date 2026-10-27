import { randomBytes } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { Page } from 'playwright'
import { mrDistributionPageUrl } from './mr-distribution-collector.ts'
import type { MrDistributionEntry, MrDistributionPage } from './mr-distribution-collector.ts'
import { distributionPageObservationSnapshot } from './distribution-page-observation.ts'
import type { DistributionPageObservationSnapshot } from './distribution-page-observation.ts'
import { readWafAction } from './waf-action.ts'
import type { WafAction } from './waf-action.ts'

export type MrDistributionDomErrorCode = 'invalid-request' | 'concurrent-read' | 'first-page-required' | 'cancelled'
  | 'http-denied' | 'server-error' | 'http-error' | 'maintenance' | 'login-required' | 'authentication-unconfirmed'
  | 'human-verification' | 'condition-mismatch' | 'page-mismatch' | 'unsupported-dom' | 'timeout' | 'read-failed'
export class MrDistributionDomError extends Error {
  readonly code: MrDistributionDomErrorCode
  constructor(code: MrDistributionDomErrorCode) {
    super(`MRランキングの表示を確認できませんでした (${code})。`)
    this.name = 'MrDistributionDomError'
    this.code = code
  }
}
export type MrDistributionAuthenticationEvidence = 'logout-control' | 'login-control' | 'conflicting-controls' | 'no-control'
export interface MrDistributionDomObservation {
  maintenance: boolean
  /** A rendered challenge is a hard stop; it is never retried or operated. */
  humanVerificationRequired?: boolean
  loginRequiredHeading: boolean
  signedIn: boolean | null
  authenticationEvidence: MrDistributionAuthenticationEvidence
  conditionsMatch: boolean | null
  currentActMatch: boolean | null
  selectedPage: number | null
  range: { from: number; to: number; total: number } | null
  entries: MrDistributionEntry[] | null
}

/** Rendered DOM only. No names, plain profile IDs, HTML, private storage or JS app state leave this function. */
export async function observeMrDistributionDom(input: { salt: string; readOnly?: boolean }): Promise<MrDistributionDomObservation> {
  if (!input.readOnly) {
    window.scrollTo?.({ top: 0, left: 0, behavior: 'instant' })
    await new Promise<void>(resolve => setTimeout(resolve, 30))
  }
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
  const headings = [...document.querySelectorAll('h1,h2')].filter(visible)
  const maintenance = headings.some(element => /ただいま、システムメンテナンス中|^Maintenance\b/i.test(text(element)))
  const humanVerificationRequired = headings.some(element => /^ユーザーが人間であることを確認する$|^Human Verification$|Verify.*human/i.test(text(element)))
    || [...document.querySelectorAll('#amzn-captcha-verify-button')].some(visible)
  const loginRequiredHeading = headings.some(element => /ログインが必要|ログインしてください|login required|sign in required/i.test(text(element)))
  const controls = [...document.querySelectorAll('a,button')].filter(visible)
    .filter(element => !element.closest('a[href*="/profile/"],ul[class*="ranking_ranking_list"]'))
  const label = (element: Element): string => text(element) || element.getAttribute('aria-label') || ''
  const logout = controls.some(element => /^(ログアウト|sign\s*out|log\s*out)$/i.test(label(element)))
  const login = controls.some(element => /^(ログイン(?:\s*\/\s*新規登録)?|log\s*in|sign\s*in)$/i.test(label(element)))
  const signedIn = logout && login ? null : logout ? true : login ? false : null
  const authenticationEvidence: MrDistributionAuthenticationEvidence = logout && login ? 'conflicting-controls'
    : logout ? 'logout-control' : login ? 'login-control' : 'no-control'
  const selects = [...document.querySelectorAll('select')].filter(visible) as HTMLSelectElement[]
  const selectedLabel = (select: HTMLSelectElement): string => select.selectedOptions.length === 1 ? select.selectedOptions[0].textContent?.trim() ?? '' : ''
  const conditionsMatch = selects.length < 5 ? null : selects.length === 5
    && selects.slice(0, 3).map(select => select.value).join(',') === '2,0,1'
    && selects.slice(0, 3).map(selectedLabel).join(',') === '最大MR,すべて,すべて'
  const pages = selects.slice(3).map(select => select.value)
  const selectedPage = pages.length === 2 && pages.every(value => /^[1-9]\d*$/.test(value) && value === pages[0])
    && Number.isSafeInteger(Number(pages[0])) ? Number(pages[0]) : null
  const navs = [...document.querySelectorAll('aside[class*="ranking_act_nav"]')].filter(visible)
  const active = navs.length === 1 ? [...navs[0].querySelectorAll('li[class*="ranking_act_nav_active"]')].filter(visible) : []
  const activeLinks = active.length === 1 ? [...active[0].querySelectorAll('a')].filter(visible) : []
  const currentActMatch = navs.length === 0 ? null : navs.length === 1 && active.length === 1 && activeLinks.length === 1 && text(activeLinks[0]) === '今Act'
  const counters = [...new Set([...document.querySelectorAll('p')].filter(visible).map(text).filter(value => /^\d+\s*-\s*\d+\s*\/\s*\d+$/.test(value)))]
  const counter = counters.length === 1 ? /^(\d+)\s*-\s*(\d+)\s*\/\s*(\d+)$/.exec(counters[0]) : null
  const range = counter ? { from: Number(counter[1]), to: Number(counter[2]), total: Number(counter[3]) } : null
  const base = { maintenance, humanVerificationRequired, loginRequiredHeading, signedIn, authenticationEvidence, conditionsMatch, currentActMatch, selectedPage, range }
  if (maintenance || humanVerificationRequired || loginRequiredHeading) return { ...base, entries: null }
  const lists = [...document.querySelectorAll('ul[class*="ranking_ranking_list"]:not([class*="ranking__my__list"])')].filter(visible)
  if (lists.length !== 1) return { ...base, entries: null }
  const links = [...lists[0].querySelectorAll('li > a[href*="/profile/"]')].filter(visible)
  const entries: MrDistributionEntry[] = []
  for (const link of links) {
    const ranks = [...link.querySelectorAll('dt')].filter(visible)
    const points = [...link.querySelectorAll('dd')].filter(visible)
    if (ranks.length !== 1 || points.length !== 1 || !/^\d+位$/.test(text(ranks[0])) || !/^\d+MR$/.test(text(points[0]))) return { ...base, entries: null }
    try {
      const profile = new URL(link.getAttribute('href') ?? '', location.origin)
      if (profile.origin !== 'https://www.streetfighter.com' || profile.username || profile.password || profile.search || profile.hash
        || !/^\/6\/buckler\/ja-jp\/profile\/\d+$/.test(profile.pathname)) throw new Error()
      const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${input.salt}:${profile.pathname}`))
      const accountKey = [...new Uint8Array(hash)].map(value => value.toString(16).padStart(2, '0')).join('')
      entries.push({ masterRating: Number(text(points[0]).slice(0, -2)), accountKey })
    } catch { return { ...base, entries: null } }
  }
  return { ...base, entries }
}

export interface MrDistributionHumanVerificationDiagnostics {
  wafHeaderChecked: boolean
  wafAction: WafAction | null
  domDetected: boolean | null
}
const emptyHumanVerification = (): MrDistributionHumanVerificationDiagnostics => ({ wafHeaderChecked: false, wafAction: null, domDetected: null })

export interface MrDistributionPageReaderDiagnostics {
  requestCount: number; successfulReadCount: number; pageSize: number | null; totalCount: number | null
  lastPage: number | null; lastAttemptedPage: number | null; lastHttpStatus: number | null
  displayedConditionsConfirmed: boolean; currentActConfirmed: boolean; initialSignInConfirmed: boolean
  lastAuthenticationEvidence: MrDistributionAuthenticationEvidence | null; lastLoginRequiredHeading: boolean | null
  lastRankingReadable: boolean | null; readableWithoutSignInReadCount: number
  humanVerification?: MrDistributionHumanVerificationDiagnostics
}
export interface MrDistributionPageReaderOptions {
  signal?: AbortSignal
  /** Receives safe evidence from each existing fetch poll; observer errors cannot change collection. */
  onObservation?: (snapshot: DistributionPageObservationSnapshot) => void
  minIntervalMs?: number
  /** A caller-owned gate starts the supplied navigation in the same stack as its pacing commit. */
  navigateWithPacing?: <T>(navigate: () => Promise<T>) => Promise<T>
  timeoutMs?: number
  allowReadablePagesAfterSignIn?: boolean
  now?: () => number
  wait?: (milliseconds: number) => Promise<void>
}
function layout(value: MrDistributionDomObservation, page: number, knownSize: number | null): Omit<MrDistributionPage, 'sourceUrl'> | null {
  if (value.conditionsMatch !== true || value.currentActMatch !== true || value.selectedPage !== page || !value.range || !value.entries) return null
  const { range, entries } = value
  const size = knownSize ?? (page === 1 && range.from === 1 && range.to === entries.length ? entries.length : 0)
  const integer = (candidate: unknown, minimum: number): candidate is number => Number.isSafeInteger(candidate) && (candidate as number) >= minimum
  const pages = size > 0 ? Math.ceil(range.total / size) : 0
  if (!integer(size, 1) || size > 20 || !integer(range.total, 1) || !integer(range.from, 1) || !integer(range.to, 1)
    || range.from !== (page - 1) * size + 1 || range.to !== Math.min(page * size, range.total)
    || range.to < range.from || page > pages || entries.length !== range.to - range.from + 1
    || page === 1 && entries.length !== Math.min(20, range.total)
    || !entries.every((entry, i) => entry && integer(entry.masterRating, 0) && typeof entry.accountKey === 'string'
      && /^[a-f0-9]{64}$/.test(entry.accountKey) && (i === 0 || entries[i - 1].masterRating >= entry.masterRating))
    || new Set(entries.map(entry => entry.accountKey)).size !== entries.length) return null
  return { page, pageSize: size, totalCount: range.total, totalPages: pages, entries: entries.map(entry => ({ ...entry })) }
}

export function createMrDistributionPageReader(page: Page, options: MrDistributionPageReaderOptions = {}) {
  const minInterval = options.minIntervalMs ?? 5000, timeout = options.timeoutMs ?? 10_000
  if (!Number.isSafeInteger(minInterval) || minInterval < 250 || minInterval > 10_000
    || options.navigateWithPacing !== undefined && typeof options.navigateWithPacing !== 'function'
    || !Number.isSafeInteger(timeout) || timeout < 1 || timeout > 10_000
    || options.allowReadablePagesAfterSignIn !== undefined && typeof options.allowReadablePagesAfterSignIn !== 'boolean') throw new MrDistributionDomError('invalid-request')
  const now = options.now ?? Date.now
  const wait = options.wait ?? (async (milliseconds: number) => { await delay(milliseconds, undefined, { signal: options.signal }) })
  const salt = randomBytes(32).toString('hex')
  const diagnostics: MrDistributionPageReaderDiagnostics = { requestCount: 0, successfulReadCount: 0, pageSize: null, totalCount: null,
    lastPage: null, lastAttemptedPage: null, lastHttpStatus: null, displayedConditionsConfirmed: false, currentActConfirmed: false,
    initialSignInConfirmed: false, lastAuthenticationEvidence: null, lastLoginRequiredHeading: null, lastRankingReadable: null, readableWithoutSignInReadCount: 0,
    humanVerification: emptyHumanVerification() }
  let running = false, lastNavigation: number | null = null
  const check = (): void => { if (options.signal?.aborted) throw new MrDistributionDomError('cancelled') }
  const urlMatches = (url: string, pageNumber: number): boolean => {
    try { const value = new URL(url); return value.searchParams.getAll('page').length === 1 && value.searchParams.get('page') === String(pageNumber)
      && mrDistributionPageUrl(pageNumber, url) === mrDistributionPageUrl(pageNumber) } catch { return false }
  }
  async function fetchPage(pageNumber: number, url = mrDistributionPageUrl(pageNumber)): Promise<MrDistributionPage> {
    check()
    if (!Number.isSafeInteger(pageNumber) || pageNumber < 1 || !urlMatches(url, pageNumber)) throw new MrDistributionDomError('invalid-request')
    if (running) throw new MrDistributionDomError('concurrent-read')
    if (!diagnostics.initialSignInConfirmed && pageNumber !== 1) throw new MrDistributionDomError('first-page-required')
    running = true
    try {
      if (!options.navigateWithPacing && lastNavigation !== null) await wait(Math.max(0, minInterval - (now() - lastNavigation)))
      const navigate = () => {
        check()
        lastNavigation = now()
        diagnostics.requestCount++
        diagnostics.lastAttemptedPage = pageNumber
        diagnostics.lastHttpStatus = null
        diagnostics.lastAuthenticationEvidence = null
        diagnostics.lastLoginRequiredHeading = null
        diagnostics.lastRankingReadable = null
        diagnostics.humanVerification = emptyHumanVerification()
        return page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
      }
      const response = await (options.navigateWithPacing ? options.navigateWithPacing(navigate) : navigate())
      check()
      const status = response?.status()
      diagnostics.lastHttpStatus = typeof status === 'number' && Number.isSafeInteger(status) && status >= 100 && status <= 599 ? status : null
      try {
        // Only the current main document from Buckler/CAPCOM can establish this evidence.
        // Subresource responses and third-party redirects are outside this diagnostic's scope.
        if (response && ['https://www.streetfighter.com', 'https://cid.capcom.com', 'https://auth.cid.capcom.com'].includes(new URL(response.url()).origin)) {
          const evidence = readWafAction(response)
          diagnostics.humanVerification = { wafHeaderChecked: evidence.checked, wafAction: evidence.action, domDetected: null }
        }
      } catch { /* Missing response evidence stays explicitly unchecked. */ }
      if (diagnostics.humanVerification?.wafAction) throw new MrDistributionDomError('human-verification')
      if (status === 401 || status === 403 || status === 429) throw new MrDistributionDomError('http-denied')
      if (status !== undefined && status >= 500 && status <= 599) throw new MrDistributionDomError('server-error')
      if (status !== undefined && status >= 400) throw new MrDistributionDomError('http-error')
      const deadline = now() + timeout
      let latest: MrDistributionDomObservation | null = null
      let finalObservation = false
      do {
        check()
        latest = await page.evaluate(observeMrDistributionDom, { salt, ...(finalObservation ? { readOnly: true } : {}) })
        check()
        const valid = layout(latest, pageNumber, diagnostics.pageSize)
        const snapshot = distributionPageObservationSnapshot(latest.authenticationEvidence, latest.loginRequiredHeading,
          urlMatches(page.url(), pageNumber) && valid !== null)
        diagnostics.lastAuthenticationEvidence = snapshot.authenticationEvidence
        diagnostics.lastLoginRequiredHeading = snapshot.loginRequiredHeading
        diagnostics.lastRankingReadable = snapshot.rankingReadable
        diagnostics.humanVerification!.domDetected = typeof latest.humanVerificationRequired === 'boolean' ? latest.humanVerificationRequired : null
        try { options.onObservation?.(snapshot) } catch { /* Diagnostics must not affect acceptance or stopping. */ }
        if (latest.maintenance) throw new MrDistributionDomError('maintenance')
        if (latest.humanVerificationRequired) throw new MrDistributionDomError('human-verification')
        if (!urlMatches(page.url(), pageNumber)) throw new MrDistributionDomError('page-mismatch')
        if (latest.conditionsMatch === false || latest.currentActMatch === false) throw new MrDistributionDomError('condition-mismatch')
        const authenticated = latest.signedIn === true && !latest.loginRequiredHeading
        const readableAfterWait = options.allowReadablePagesAfterSignIn === true && diagnostics.initialSignInConfirmed
          && now() >= deadline && latest.signedIn === false && latest.authenticationEvidence === 'login-control' && !latest.loginRequiredHeading
        if (valid && (authenticated || readableAfterWait)) {
          diagnostics.pageSize = valid.pageSize
          diagnostics.totalCount = valid.totalCount
          diagnostics.lastPage = pageNumber
          diagnostics.successfulReadCount++
          diagnostics.displayedConditionsConfirmed = true
          diagnostics.currentActConfirmed = true
          if (authenticated && pageNumber === 1) diagnostics.initialSignInConfirmed = true
          if (readableAfterWait) diagnostics.readableWithoutSignInReadCount++
          return { sourceUrl: page.url(), ...valid }
        }
        if (now() >= deadline) {
          // Async row observation can leave the initial header snapshot stale.
          // One passive refresh still goes through every normal acceptance check.
          if (finalObservation || latest.loginRequiredHeading) break
          finalObservation = true
          continue
        }
        await wait(250)
      } while (true)
      if (latest?.loginRequiredHeading) throw new MrDistributionDomError('login-required')
      if (latest?.signedIn !== true) throw new MrDistributionDomError('authentication-unconfirmed')
      if (latest.selectedPage !== pageNumber) throw new MrDistributionDomError('page-mismatch')
      if (latest.entries === null || latest.range === null || latest.conditionsMatch === null || latest.currentActMatch === null) throw new MrDistributionDomError('read-failed')
      throw new MrDistributionDomError('unsupported-dom')
    } catch (error) {
      if (options.signal?.aborted) throw new MrDistributionDomError('cancelled')
      if (error instanceof MrDistributionDomError) throw error
      throw new MrDistributionDomError(error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'read-failed')
    } finally { running = false }
  }
  /** One passive sample, including after this reader's collection signal was aborted. */
  async function observeCurrentPage(pageNumber: number): Promise<DistributionPageObservationSnapshot> {
    if (!Number.isSafeInteger(pageNumber) || pageNumber < 1) throw new MrDistributionDomError('invalid-request')
    if (running) throw new MrDistributionDomError('concurrent-read')
    running = true
    try {
      const value = await page.evaluate(observeMrDistributionDom, { salt, readOnly: true })
      if (value.humanVerificationRequired) throw new MrDistributionDomError('human-verification')
      return distributionPageObservationSnapshot(value.authenticationEvidence, value.loginRequiredHeading,
        urlMatches(page.url(), pageNumber) && layout(value, pageNumber, diagnostics.pageSize) !== null)
    } catch (error) {
      if (error instanceof MrDistributionDomError) throw error
      throw new MrDistributionDomError(error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'read-failed')
    } finally { running = false }
  }
  return { fetchPage, observeCurrentPage, getDiagnostics: (): MrDistributionPageReaderDiagnostics => ({ ...diagnostics,
    humanVerification: { ...diagnostics.humanVerification! } }) }
}
