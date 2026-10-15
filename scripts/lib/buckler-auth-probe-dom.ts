import type { Page } from 'playwright'
import { setTimeout as delay } from 'node:timers/promises'
import { rankBoundaryPageUrl } from './rank-distribution-boundaries.ts'
import { BUCKLER_AUTH_PROBE_URL, BucklerAuthProbeReadError, classifyBucklerAuthProbeObservation } from './buckler-auth-probe.ts'
import type { BucklerAuthProbeObservation } from './buckler-auth-probe.ts'

/** Reads rendered indicators only. Does not return text, links, IDs or browser storage. */
export function observeBucklerAuthDom(): Omit<BucklerAuthProbeObservation, 'pageConfirmed'> {
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
  const label = (element: Element): string => text(element) || element.getAttribute('aria-label') || ''
  const hasLogout = controls.some(element => /^(ログアウト|sign\s*out|log\s*out)$/i.test(label(element)))
  const hasLogin = controls.some(element => /^(ログイン(?:\s*\/\s*新規登録)?|log\s*in|sign\s*in)$/i.test(label(element)))
  // A profile link is public information and alone does not prove authentication.
  const signedIn = hasLogin && hasLogout ? null : hasLogout ? true : hasLogin ? false : null
  // Exclude the logged-in user's own card from the ranking row count.
  const lists = [...document.querySelectorAll('ul[class*="ranking_ranking_list"]:not([class*="ranking__my__list"])')].filter(visible)
  const links = lists.flatMap(list => [...list.querySelectorAll('a[href*="/profile/"]')].filter(visible))
  const validRows = links.every(link => /^\d+位$/.test(text(link.querySelector('dt') ?? link))
    && /^\d+LP$/.test(text(link.querySelector('dd') ?? link)))
  const rankingRows = lists.length === 1 && validRows ? links.length : null
  const counterTexts = [...new Set([...document.querySelectorAll('p')].filter(visible).map(text)
    .filter(value => /^\d+\s*-\s*\d+\s*\/\s*\d+$/.test(value)))]
  const match = counterTexts.length === 1 ? counterTexts[0].match(/^(\d+)\s*-\s*(\d+)\s*\/\s*(\d+)$/) : null
  const visibleCounters = match ? { from: Number(match[1]), to: Number(match[2]), total: Number(match[3]) } : null
  const selects = [...document.querySelectorAll('select')].filter(visible) as HTMLSelectElement[]
  const controlMatches = selects.length >= 5
    ? selects.slice(0, 4).map(select => select.value).join(',') === '0,2,0,1'
      && selects.slice(4).every(select => select.value === '1')
    : null
  const loginRequired = signedIn !== true && headings.some(element => /ログインが必要|ログインしてください|login required|sign in required/i.test(text(element)))
  return { maintenance, loginRequired, signedIn, rankingRows, visibleCounters, controlMatches }
}

export function isBucklerAuthProbePage(url: string): boolean {
  try {
    const current = new URL(url)
    return current.searchParams.getAll('page').length === 1 && current.searchParams.get('page') === '1'
      && rankBoundaryPageUrl(url, 1) === BUCKLER_AUTH_PROBE_URL
  } catch { return false }
}

/** DOM polling performs no reloads or background HTTP requests of its own. */
export async function readBucklerAuthProbePage(page: Page, navigate = true, expectSignedIn = false): Promise<BucklerAuthProbeObservation> {
  try {
    if (navigate) await page.goto(BUCKLER_AUTH_PROBE_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    const deadline = Date.now() + 10_000
    let observation: BucklerAuthProbeObservation
    do {
      observation = { ...await page.evaluate(observeBucklerAuthDom), pageConfirmed: isBucklerAuthProbePage(page.url()) }
      const status = classifyBucklerAuthProbeObservation(observation).status
      // Authentication controls can hydrate after the ranking. Wait within the same
      // deadline when authentication is expected, retaining the last actual state.
      if (status === 'maintenance' || status === 'login-required' || status === 'signed-in-readable'
        || !expectSignedIn && (status === 'anonymous-readable' || status === 'auth-unconfirmed-readable')) return observation
      await delay(250)
    } while (Date.now() < deadline)
    return observation
  } catch (error) {
    const timeout = error instanceof Error && error.name === 'TimeoutError'
    throw new BucklerAuthProbeReadError(timeout ? 'timeout' : 'read-failed')
  }
}
