import { randomBytes } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { Page, Request } from 'playwright'
import { LEGEND_ANALYSIS_SOURCE } from '../../src/lib/legendAnalysis.ts'
import type { LegendAnalysisConditions } from '../../src/types/legendAnalysis.ts'
import type { LegendAnalysisEntry, LegendAnalysisPage } from './legend-analysis-collector.ts'
import { emptyDistributionHumanVerification, observeDistributionHumanVerification, readDistributionHumanVerificationResponse } from './distribution-human-verification.ts'
import { matchesLegendRankedMatchRequest, observeLegendPlayerProfile, settleLegendPlayerRender, type LegendPlayerProfileObservation } from './legend-player-profile-dom.ts'

export const LEGEND_ANALYSIS_CONDITIONS: LegendAnalysisConditions = { region: 'all', platform: 'all', characters: 'all', users: 'source-default' }
const FILTERS = { character_filter: '1', character_id: 'luke', platform: '1', home_filter: '1', home_category_id: '0', home_id: '0', season_type: '1' } as const
export function legendAnalysisPageUrl(page: number): string {
  if (!Number.isSafeInteger(page) || page < 1) throw new LegendAnalysisDomError('invalid-request')
  const url = new URL(LEGEND_ANALYSIS_SOURCE.url)
  for (const [key, value] of Object.entries(FILTERS)) url.searchParams.set(key, value)
  url.searchParams.set('page', String(page)); url.searchParams.sort()
  return url.href
}
/** Query order may differ after an ordinary UI transition; keys, values and multiplicities may not. */
export function legendAnalysisPageUrlMatches(value: string, page: number): boolean {
  try {
    const actual = new URL(value), expected = new URL(legendAnalysisPageUrl(page))
    if (actual.origin !== expected.origin || actual.pathname !== expected.pathname || actual.username || actual.password || actual.hash) return false
    actual.searchParams.sort()
    return actual.search === expected.search
  } catch { return false }
}
export type LegendAnalysisDomErrorCode = 'invalid-request' | 'request-limit' | 'cancelled' | 'concurrent-read' | 'http-denied'
  | 'http-error' | 'server-error' | 'maintenance' | 'authentication-required' | 'unsupported-dom' | 'condition-mismatch'
  | 'act-unconfirmed' | 'act-changed' | 'read-failed'
export class LegendAnalysisDomError extends Error {
  readonly code: LegendAnalysisDomErrorCode
  constructor(code: LegendAnalysisDomErrorCode) { super(`レジェンド分析の画面取得を中止しました (${code})。`); this.name = 'LegendAnalysisDomError'; this.code = code }
}

export interface LegendAnalysisDomObservation {
  /** Captured in the same synchronous pass as the rows; never copied to diagnostics or public data. */
  observedUrl: string
  maintenance: boolean
  accessChallenge?: boolean
  signedIn: boolean
  authenticationEvidence: 'logout-control' | 'login-control' | 'conflicting-controls' | 'no-control'
  loginRequired: boolean
  conditionsConfirmed: boolean
  currentActConfirmed: boolean
  selectedPage: number | null
  range: { from: number; to: number; total: number } | null
  /** Used in memory solely to verify Act; never included in diagnostics or saved output. */
  firstPlayUrl: string | null
  entries: LegendAnalysisEntry[] | null
}

/** Rendered ranking controls and row assets only; account IDs are hashed with one capture-wide salt. */
export async function observeLegendAnalysisDom(input: { salt: string; characterIds: string[]; includePlayers?: boolean }): Promise<LegendAnalysisDomObservation> {
  window.scrollTo?.({ top: 0, left: 0, behavior: 'instant' })
  const visible = (element: Element): boolean => {
    const rect = element.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return false
    for (let parent: Element | null = element; parent; parent = parent.parentElement) {
      const style = window.getComputedStyle(parent)
      if (parent.hasAttribute('hidden') || style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false
    }
    return true
  }
  const text = (element: Element): string => (element as HTMLElement).innerText?.trim() ?? ''
  // Ordinary scrolling prepares lazy assets before taking a new, synchronous snapshot.
  // These nodes are deliberately discarded: React may replace them during an await.
  const preparationLists = [...document.querySelectorAll('ul[class*="ranking_ranking_list"]:not([class*="ranking__my__list"])')].filter(visible)
  if (preparationLists.length === 1) for (const row of [...preparationLists[0].querySelectorAll('a[href*="/profile/"]')].filter(visible)) {
    row.scrollIntoView({ block: 'center', inline: 'nearest' })
    await new Promise<void>(resolve => setTimeout(resolve, 20))
  }
  // Scrolling can hide the ordinary header controls; restore them before freezing auth and ranking together.
  window.scrollTo?.({ top: 0, left: 0, behavior: 'instant' })
  await new Promise<void>(resolve => setTimeout(resolve, 30))
  // No DOM reads or awaits may be interleaved between this point and the completed raw-row snapshot.
  const observedUrl = location.href
  const controls = [...document.querySelectorAll('a,button')].filter(visible)
    .filter(element => !element.closest('a[href*="/profile/"]'))
  const hasLogout = controls.some(element => /^(ログアウト|sign\s*out|log\s*out)$/i.test(text(element)))
  const hasLogin = controls.some(element => /^(ログイン(?:\s*\/\s*新規登録)?|log\s*in|sign\s*in)$/i.test(text(element)))
  const headings = [...document.querySelectorAll('h1,h2')].filter(visible).map(text)
  const maintenance = headings.some(value => /ただいま、システムメンテナンス中|^Maintenance\b/i.test(value))
  const accessChallenge = headings.some(value => /verify (?:that )?you are human|checking your browser|attention required|access denied|ロボットではない|セキュリティチェック|アクセスが拒否/i.test(value))
  const loginRequired = headings.some(value => /ログインが必要|ログインしてください|login required|sign in required/i.test(value))
  const selects = [...document.querySelectorAll('select')].filter(visible) as HTMLSelectElement[]
  const label = (element: HTMLSelectElement): string => element.selectedOptions.length === 1 ? element.selectedOptions[0].textContent?.trim() ?? '' : ''
  const filterSelects = selects.filter(element => element.options.length > 0 && !element.closest('[class*="pagination"]'))
  const conditionsConfirmed = filterSelects.length >= 3 && filterSelects.slice(0, 3).map(element => element.value).join(',') === '1,0,1'
    && filterSelects.slice(0, 3).map(label).join(',') === '総合,すべて,すべて'
  const actItems = [...document.querySelectorAll('aside[class*="ranking_act_nav"] li[class*="active"]')].filter(visible)
  const currentActConfirmed = actItems.length === 1 && /今Act/.test(text(actItems[0]))
  const counters = [...new Set([...document.querySelectorAll('p[class*="ranking_ranking_now"]')].filter(visible).map(text)
    .filter(value => /^\d+\s*-\s*\d+\s*\/\s*\d+$/.test(value)))]
  const match = counters.length === 1 ? /^(\d+)\s*-\s*(\d+)\s*\/\s*(\d+)$/.exec(counters[0]) : null
  const range = match ? { from: Number(match[1]), to: Number(match[2]), total: Number(match[3]) } : null
  const pageSelects = selects.slice(3).filter(element => /^[1-9]\d*$/.test(element.value))
  const selectedPage = pageSelects.length > 0 && pageSelects.every(element => element.value === pageSelects[0].value)
    ? Number(pageSelects[0].value) : null
  const authenticationEvidence: LegendAnalysisDomObservation['authenticationEvidence'] = hasLogout && hasLogin ? 'conflicting-controls' : hasLogout ? 'logout-control' : hasLogin ? 'login-control' : 'no-control'
  const base = Object.freeze({ observedUrl, maintenance, accessChallenge, signedIn: hasLogout && !hasLogin, authenticationEvidence, loginRequired, conditionsConfirmed, currentActConfirmed, selectedPage, range: range && Object.freeze(range) })
  if (maintenance || loginRequired) return { ...base, firstPlayUrl: null, entries: null }
  const lists = [...document.querySelectorAll('ul[class*="ranking_ranking_list"]:not([class*="ranking__my__list"])')].filter(visible)
  if (lists.length !== 1) return { ...base, firstPlayUrl: null, entries: null }
  const rows = [...lists[0].querySelectorAll('a[href*="/profile/"]')].filter(visible)
  const rawEntries: Readonly<{ profilePath: string; characterId: string; rank: number; masterRating: number; isLegend: boolean;
    playerName?: string; playerId?: string; region?: string; platform?: string }>[] = []
  let firstPlayUrl: string | null = null
  // Next.js images may still have a GIF placeholder: its DOM noscript fallback is restricted to official assets.
  const assetPath = (container: Element): string | null => {
    const loaded = [...container.querySelectorAll('img')].filter(visible) as HTMLImageElement[]
    const candidates = loaded.filter(image => image.complete && image.naturalWidth > 0 && image.currentSrc && !image.currentSrc.startsWith('data:') && !/\.gif(?:\?|$)/i.test(image.currentSrc)).map(image => image.currentSrc)
    if (!candidates.length) for (const node of container.querySelectorAll('noscript')) {
      const parsed = new DOMParser().parseFromString(node.textContent || node.innerHTML || '', 'text/html')
      const images = [...node.querySelectorAll('img'), ...parsed.querySelectorAll('img')]
      if (images.length === 1 && images[0].getAttribute('src')) candidates.push(images[0].getAttribute('src')!)
    }
    const uniqueCandidates = [...new Set(candidates)]
    if (uniqueCandidates.length !== 1) return null
    try {
      let url = new URL(uniqueCandidates[0], location.origin)
      if (url.origin !== 'https://www.streetfighter.com' || url.username || url.password || url.hash) return null
      if (url.pathname === '/_next/image' || url.pathname === '/6/buckler/_next/image') {
        if (url.searchParams.getAll('url').length !== 1 || [...url.searchParams.keys()].some(key => !['url', 'w', 'q'].includes(key))) return null
        url = new URL(url.searchParams.get('url')!, location.origin)
      }
      return url.origin === 'https://www.streetfighter.com' && !url.search && !url.hash && !url.username && !url.password ? url.pathname : null
    } catch { return null }
  }
  for (const row of rows) {
    const data = row.querySelectorAll('div[class*="ranking_page_data"]')
    const times = row.querySelectorAll('[class*="ranking_time"]')
    const ranks = times.length === 1 ? times[0].querySelectorAll('dl dt') : []
    const ratings = times.length === 1 ? times[0].querySelectorAll('dl dd') : []
    const characters = row.querySelectorAll('div[class*="ranking_character"]')
    const badges = row.querySelectorAll('div[class*="ranking_league_rank_icon"] p[class*="ranking_master_rating_icon"]')
    if (data.length !== 1 || ranks.length !== 1 || ratings.length !== 1 || characters.length !== 1 || badges.length !== 1) return { ...base, firstPlayUrl: null, entries: null }
    const rankText = text(ranks[0]), mrText = text(ratings[0]), href = row.getAttribute('href') ?? ''
    if (!/^\d+位$/.test(rankText) || !/^\d+MR$/.test(mrText)) return { ...base, firstPlayUrl: null, entries: null }
    const character = assetPath(characters[0])?.match(/^\/6\/buckler\/assets\/images\/material\/character\/character_([a-z0-9]+)_l\.png$/)?.[1]
    const badge = assetPath(badges[0])?.match(/^\/6\/buckler\/assets\/images\/material\/rank\/rank(\d+)_l\.png$/)?.[1]
    if (!character || input.characterIds.length > 0 && !input.characterIds.includes(character) || !badge || !['37', '38', '39', '40', '41', '42'].includes(badge)) return { ...base, firstPlayUrl: null, entries: null }
    // Confirmed visible ranking fighter label; the adjacent ranking_comment title is not a player name.
    const nameNodes = input.includePlayers ? [...row.querySelectorAll('p[class*="ranking_fighter__"] span[class*="ranking_name__"]')].filter(visible) : []
    const playerName = nameNodes.length === 1 ? text(nameNodes[0]) : null
    // Confirmed ranking image labels are source settings, not inferred nationality or hardware.
    const imageLabel = (selector: string): string | null => {
      if (!input.includePlayers) return null
      const images = [...row.querySelectorAll(selector)].filter(image => visible(image) && !image.closest('noscript')
        && (image.getAttribute('alt') ?? '').trim())
      const label = images.length === 1 ? images[0].getAttribute('alt')!.trim() : null
      return label && label.length <= 64 && !/\p{Cc}/u.test(label) ? label : null
    }
    const region = imageLabel('[class*="ranking_frag__"] img[alt]')
    const platform = imageLabel('[class*="ranking_platform__"] img[alt]')
    if (input.includePlayers && badge === '37' && (!playerName || playerName.length > 128 || /\p{Cc}/u.test(playerName) || !region || !platform)) {
      return { ...base, firstPlayUrl: null, entries: null }
    }
    try {
      const profile = new URL(href, location.origin)
      if (profile.origin !== 'https://www.streetfighter.com' || profile.username || profile.password || profile.search || profile.hash
        || !/^\/6\/buckler\/ja-jp\/profile\/\d+$/.test(profile.pathname)) throw new Error()
      const playerId = profile.pathname.match(/\/(\d+)$/)![1]
      if (input.includePlayers && !/^\d{1,20}$/.test(playerId)) throw new Error()
      firstPlayUrl ??= `${profile.href}/play`
      rawEntries.push(Object.freeze({ profilePath: profile.pathname, characterId: character,
        rank: Number(rankText.slice(0, -1)), masterRating: Number(mrText.slice(0, -2)), isLegend: badge === '37',
        ...(input.includePlayers ? { playerId, ...(playerName ? { playerName } : {}), ...(region ? { region } : {}), ...(platform ? { platform } : {}) } : {}) }))
    } catch { return { ...base, firstPlayUrl: null, entries: null } }
  }
  Object.freeze(rawEntries)
  const entries: LegendAnalysisEntry[] = []
  // Hash only the frozen strings. Later hydration cannot alter an identity/value tuple.
  try {
    for (const raw of rawEntries) {
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${input.salt}:${raw.profilePath}`))
      entries.push({ accountKey: [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join(''),
        characterId: raw.characterId, rank: raw.rank, masterRating: raw.masterRating, isLegend: raw.isLegend,
        ...(raw.playerName === undefined ? {} : { playerName: raw.playerName }),
        ...(raw.playerId === undefined ? {} : { playerId: raw.playerId }),
        ...(raw.region === undefined ? {} : { region: raw.region }),
        ...(raw.platform === undefined ? {} : { platform: raw.platform }) })
    }
  } catch { return { ...base, firstPlayUrl: null, entries: null } }
  return { ...base, firstPlayUrl, entries }
}

/** Read only the visible PLAY Act options, never performance fields or application state. */
export function observeLegendAnalysisAct(): { id: string; label: string } | null {
  const candidates = [...document.querySelectorAll('select')].filter(element => element.getBoundingClientRect().width > 0)
    .filter(element => element.options.length > 0 && [...element.options].every(option => /^(?:Act\s*:\s*\d+|累計)$/.test(option.textContent?.trim() ?? '')))
  if (candidates.length !== 1) return null
  const options = [...candidates[0].options]
  const first = options[0], match = /^Act\s*:\s*(\d+)$/.exec(first.textContent?.trim() ?? '')
  if (!match || first.value !== match[1] || candidates[0].value !== first.value
    || !options.filter(option => /^Act/.test(option.textContent?.trim() ?? '')).every(option => /^\d+$/.test(option.value) && Number(option.value) <= Number(first.value))) return null
  return { id: `act-${first.value}`, label: `Act ${first.value}` }
}

/** Fixed filter values and counts only, for a bounded ordinary-UI hydration retry. */
export function observeLegendAnalysisRosterControl(): { characterFilter: '1' | '2' | '3' | '4' | null; visibleRosterButtonCount: number; rosterModalVisible: boolean } {
  const visible = (element: Element): boolean => {
    const rect = element.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return false
    for (let parent: Element | null = element; parent; parent = parent.parentElement) {
      const style = window.getComputedStyle(parent)
      if (parent.hasAttribute('hidden') || style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false
    }
    return true
  }
  const select = [...document.querySelectorAll('select')].filter(visible)[0]
  return { characterFilter: ['1', '2', '3', '4'].includes(select?.value ?? '') ? select.value as '1' | '2' | '3' | '4' : null,
    visibleRosterButtonCount: [...document.querySelectorAll('span[class*="ranking_search_character_btn"]')].filter(visible).length,
    rosterModalVisible: [...document.querySelectorAll('h3')].some(element => visible(element) && element.textContent?.trim() === 'キャラクターセレクト') }
}
export type LegendClickFailure = 'intercepts-pointer-events' | 'not-visible' | 'not-stable' | 'outside-viewport' | 'strict-mode' | 'other'
export type LegendClickHit = 'cookie-consent' | 'ranking-control' | 'header' | 'other'
export interface LegendClickObservation {
  hitKind: LegendClickHit | null
  hitTag: 'button' | 'span' | 'div' | 'p' | 'iframe' | 'other' | null
  parentParagraph: boolean
  pointerEventsNone: boolean
}
export function observeLegendAnalysisClickTarget(): LegendClickObservation {
  const target = [...document.querySelectorAll('span[class*="ranking_search_character_btn"]')]
    .find(element => element.getBoundingClientRect().width > 0 && window.getComputedStyle(element).display !== 'none')
  if (!target) return { hitKind: null, hitTag: null, parentParagraph: false, pointerEventsNone: false }
  const rect = target.getBoundingClientRect(), hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
  const tag = hit?.tagName.toLowerCase()
  const parentParagraph = target.parentElement?.tagName === 'P'
  const hitKind: LegendClickHit | null = !hit ? null : hit.closest('#onetrust-banner-sdk,#onetrust-consent-sdk,[id*="cookie"],[class*="cookie"],[class*="Cookie"],[id*="consent"],[class*="consent"]')
    ? 'cookie-consent' : hit === target || target.contains(hit) || parentParagraph && hit === target.parentElement ? 'ranking-control'
      : hit.closest('header') ? 'header' : 'other'
  return { hitKind, hitTag: !tag ? null : ['button', 'span', 'div', 'p', 'iframe'].includes(tag) ? tag as LegendClickObservation['hitTag'] : 'other',
    parentParagraph, pointerEventsNone: window.getComputedStyle(target).pointerEvents === 'none' }
}
export function classifyLegendClickFailure(error: unknown): LegendClickFailure {
  const message = error instanceof Error ? error.message : ''
  if (/intercepts pointer events/i.test(message)) return 'intercepts-pointer-events'
  if (/not visible|is not visible/i.test(message)) return 'not-visible'
  if (/not stable|is not stable/i.test(message)) return 'not-stable'
  if (/outside of the viewport|outside.*viewport/i.test(message)) return 'outside-viewport'
  if (/strict mode violation/i.test(message)) return 'strict-mode'
  return 'other'
}

export interface LegendRosterDiagnostics {
  h3Count: number
  liCount: number
  randomCount: number
  failedIndex: number | null
  reason: 'heading-count' | 'modal-container' | 'asset-invalid' | 'asset-count' | 'name-count' | 'duplicate-id' | 'random-count' | 'empty' | null
  items: Array<{ index: number; label: string | null; assetIds: string[]; otherAssetCount: number; namesCount: number; fallbackCount: number; imageCount: number }>
}
export function sanitizeLegendRosterDiagnostics(value: unknown): LegendRosterDiagnostics | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const input = value as Record<string, unknown>
  const count = (candidate: unknown): candidate is number => Number.isSafeInteger(candidate) && (candidate as number) >= 0 && (candidate as number) <= 1000
  if (!count(input.h3Count) || !count(input.liCount) || !count(input.randomCount)
    || input.failedIndex !== null && !count(input.failedIndex)
    || ![null, 'heading-count', 'modal-container', 'asset-invalid', 'asset-count', 'name-count', 'duplicate-id', 'random-count', 'empty'].includes(input.reason as null)
    || !Array.isArray(input.items) || input.items.length > 128) return null
  const items: LegendRosterDiagnostics['items'] = []
  for (const value of input.items) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const item = value as Record<string, unknown>
    if (!count(item.index) || !count(item.otherAssetCount) || !count(item.namesCount) || !count(item.fallbackCount) || !count(item.imageCount)
      || item.label !== null && (typeof item.label !== 'string' || item.label.length > 64 || !/^[\p{L}\p{M}\p{N} .・･'’ｰー()（）-]+$/u.test(item.label))
      || !Array.isArray(item.assetIds) || item.assetIds.length > 4 || !item.assetIds.every(id => typeof id === 'string' && /^[a-z][a-z0-9_]{0,39}$/.test(id))) return null
    items.push({ index: item.index, label: item.label as string | null, assetIds: item.assetIds as string[], otherAssetCount: item.otherAssetCount,
      namesCount: item.namesCount, fallbackCount: item.fallbackCount, imageCount: item.imageCount })
  }
  return { h3Count: input.h3Count, liCount: input.liCount, randomCount: input.randomCount, failedIndex: input.failedIndex as number | null,
    reason: input.reason as LegendRosterDiagnostics['reason'], items }
}
/** Called only after opening the ordinary character-select modal; diagnostics contain catalog data only. */
export async function observeLegendAnalysisRoster(): Promise<{ roster: Array<{ characterId: string; name: string }> | null; diagnostics: LegendRosterDiagnostics }> {
  const visible = (element: Element): boolean => {
    const rect = element.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return false
    for (let parent: Element | null = element; parent; parent = parent.parentElement) {
      const style = window.getComputedStyle(parent)
      if (parent.hasAttribute('hidden') || style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false
    }
    return true
  }
  const headings = [...document.querySelectorAll('h3')].filter(element => visible(element) && element.textContent?.trim() === 'キャラクターセレクト')
  const modal = headings.length === 1 ? headings[0].closest('div[class*="modal_modal__box"]') : null
  const diagnostics: LegendRosterDiagnostics = { h3Count: headings.length, liCount: 0, randomCount: 0, failedIndex: null,
    reason: headings.length !== 1 ? 'heading-count' : !modal ? 'modal-container' : null, items: [] }
  if (!modal) return { roster: null, diagnostics }
  const result: Array<{ characterId: string; name: string }> = []
  let randomCount = 0
  const items = [...modal.querySelectorAll('li')]
  diagnostics.liCount = items.length
  const fail = (index: number, reason: NonNullable<LegendRosterDiagnostics['reason']>): void => {
    if (diagnostics.reason === null) { diagnostics.failedIndex = index; diagnostics.reason = reason }
  }
  for (const [index, item] of items.entries()) {
    // Ordinary scrolling lets the modal's intersection observer load its lazy character portraits.
    item.scrollIntoView({ block: 'center', inline: 'nearest' })
    await new Promise<void>(resolve => setTimeout(resolve, 75))
    const label = (item.querySelector('dt')?.textContent ?? '').replace(/\s+/g, ' ').trim()
    const images = [...item.querySelectorAll('dd img')]
    const names = new Set(images.map(image => image.getAttribute('alt')?.trim()).filter((value): value is string => Boolean(value)))
    const candidates: string[] = []
    for (const image of images) {
      const rendered = image as HTMLImageElement
      const value = rendered.complete && rendered.naturalWidth > 0 ? rendered.currentSrc || image.getAttribute('src') : null
      if (value && !value.startsWith('data:') && !/\.gif(?:\?|$)/i.test(value)) candidates.push(value)
    }
    if (!candidates.length) for (const fallback of item.querySelectorAll('noscript')) {
      const parsed = new DOMParser().parseFromString(fallback.textContent || fallback.innerHTML || '', 'text/html')
      for (const image of [...fallback.querySelectorAll('img'), ...parsed.querySelectorAll('img')]) {
        const value = image.getAttribute('src'); if (value) candidates.push(value)
        const name = image.getAttribute('alt')?.trim(); if (name) names.add(name)
      }
    }
    const ids = new Set<string>()
    let otherAssetCount = 0
    for (const candidate of candidates) try {
      let url = new URL(candidate, location.origin)
      if (url.origin !== 'https://www.streetfighter.com' || url.username || url.password || url.hash) throw new Error()
      if (url.pathname === '/_next/image' || url.pathname === '/6/buckler/_next/image') {
        if (url.searchParams.getAll('url').length !== 1 || [...url.searchParams.keys()].some(key => !['url', 'w', 'q'].includes(key))) throw new Error()
        url = new URL(url.searchParams.get('url')!, location.origin)
      }
      const id = url.origin === 'https://www.streetfighter.com' && !url.search && !url.hash && !url.username && !url.password
        ? url.pathname.match(/^\/6\/buckler\/assets\/images\/material\/character\/character_([a-z][a-z0-9_]{0,39})_l\.png$/)?.[1] : null
      if (!id) throw new Error()
      ids.add(id)
    } catch { otherAssetCount++ }
    diagnostics.items.push({ index, label: label.length <= 64 && /^[\p{L}\p{M}\p{N} .・･'’ｰー()（）-]+$/u.test(label) ? label : null,
      assetIds: [...ids].slice(0, 4), otherAssetCount, namesCount: names.size, fallbackCount: item.querySelectorAll('noscript').length, imageCount: images.length })
    if (/^random$/i.test(label)) { randomCount++; continue }
    if (otherAssetCount) { fail(index, 'asset-invalid'); continue }
    if (ids.size !== 1) { fail(index, 'asset-count'); continue }
    if (names.size !== 1) { fail(index, 'name-count'); continue }
    result.push({ characterId: [...ids][0], name: [...names][0] })
  }
  diagnostics.randomCount = randomCount
  items[0]?.scrollIntoView({ block: 'start', inline: 'nearest' })
  if (!result.length) fail(0, 'empty')
  if (randomCount !== 1) fail(items.length, 'random-count')
  if (new Set(result.map(value => value.characterId)).size !== result.length) fail(items.length, 'duplicate-id')
  return { roster: diagnostics.reason === null ? result.sort((a, b) => a.characterId.localeCompare(b.characterId)) : null, diagnostics }
}

export interface LegendAnalysisPageReaderOptions {
  characterIds?: string[]
  includePlayers?: boolean
  signal?: AbortSignal
  minIntervalMs?: number
  maxRequests?: number
  now?: () => number
  wait?: (milliseconds: number) => Promise<void>
}
export type LegendAnalysisReaderStep = 'idle' | 'ranking-navigation' | 'ranking-observation' | 'act-navigation'
  | 'act-observation' | 'roster-condition' | 'roster-open' | 'roster-observation'
  | 'profile-navigation' | 'profile-filter' | 'profile-observation' | 'complete'
export function createLegendAnalysisPageReader(page: Page, options: LegendAnalysisPageReaderOptions) {
  const interval = options.minIntervalMs ?? 5000
  if (!Number.isSafeInteger(interval) || interval < 1000 || interval > 10000) throw new LegendAnalysisDomError('invalid-request')
  const maxRequests = options.maxRequests ?? 2000
  if (!Number.isSafeInteger(maxRequests) || maxRequests < 1 || maxRequests > 2000) throw new LegendAnalysisDomError('invalid-request')
  const salt = randomBytes(32).toString('hex'), now = options.now ?? Date.now
  const wait = options.wait ?? (async milliseconds => { await delay(milliseconds, undefined, { signal: options.signal }) })
  let lastNavigation: number | null = null, running = false, firstPlayUrl: string | null = null
  let act: { id: string; label: string } | null = null
  let characterIds = options.characterIds ? [...options.characterIds] : []
  let ready = false
  let requestCount = 0
  let lastStep: LegendAnalysisReaderStep = 'idle'
  let lastErrorCode: LegendAnalysisDomErrorCode | null = null
  let characterFilter: '1' | '2' | '3' | '4' | null = null, visibleRosterButtonCount: number | null = null
  let clickFailure: LegendClickFailure | null = null, clickObservation: LegendClickObservation | null = null
  let rosterDiagnostics: LegendRosterDiagnostics | null = null
  let signedInFirstPageConfirmed = false, readableWithoutSignInReadCount = 0
  let lastLoginRequired: boolean | null = null, lastSignedIn: boolean | null = null, lastRankingReadable: boolean | null = null
  let lastHttpStatus: number | null = null
  let humanVerification = emptyDistributionHumanVerification()
  let lastAttemptedPage: number | null = null, successfulReadCount = 0
  // In-memory identities only: never diagnostic/public values. Invalidate whenever leaving accepted listing state.
  let lastAccepted: { page: number; body: string } | null = null
  const bodySignature = (entries: LegendAnalysisEntry[]): string => entries.map(entry => `${entry.accountKey}:${entry.characterId}`).sort().join('|')
  const check = (): void => { if (options.signal?.aborted) throw new LegendAnalysisDomError('cancelled') }
  const beginNavigation = async (requestedPage: number | null): Promise<void> => {
    check()
    if (requestCount >= maxRequests) throw new LegendAnalysisDomError('request-limit')
    if (lastNavigation !== null) await wait(Math.max(0, interval - (now() - lastNavigation)))
    check(); lastNavigation = now(); requestCount++; lastAttemptedPage = requestedPage
    lastLoginRequired = null; lastSignedIn = null; lastRankingReadable = null; lastHttpStatus = null
    humanVerification = emptyDistributionHumanVerification()
  }
  const challengeVisible = async (): Promise<boolean> => page.evaluate(() => [...document.querySelectorAll('h1,h2')]
    .filter(element => element.getBoundingClientRect().width > 0)
    .some(element => /verify (?:that )?you are human|checking your browser|attention required|access denied|ロボットではない|セキュリティチェック|アクセスが拒否/i.test((element as HTMLElement).innerText ?? '')))
  const observeHumanVerification = async (): Promise<void> => {
    try {
      const detected = await page.evaluate(observeDistributionHumanVerification)
      humanVerification.domDetected = typeof detected === 'boolean' ? detected : null
    } catch { humanVerification.domDetected = null /* No raw DOM errors enter diagnostics. */ }
  }
  const navigate = async (url: string, requestedPage: number | null = null): Promise<void> => {
    for (let attempt = 0; attempt < 2; attempt++) {
      await beginNavigation(requestedPage)
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
      const status = response?.status()
      lastHttpStatus = Number.isSafeInteger(status) && status! >= 100 && status! <= 599 ? status! : null
      humanVerification = readDistributionHumanVerificationResponse(response)
      // A redirect is never treated as a retryable server fault.
      const matches = (actual: string): boolean => requestedPage === null ? actual === url : legendAnalysisPageUrlMatches(actual, requestedPage)
      if (!matches(page.url()) || response && !matches(response.url())) throw new LegendAnalysisDomError('condition-mismatch')
      if ((status ?? 0) >= 400 || humanVerification.wafAction) await observeHumanVerification()
      if (humanVerification.wafAction || humanVerification.domDetected === true) throw new LegendAnalysisDomError('http-denied')
      if ([401, 403, 429].includes(status ?? 0)) throw new LegendAnalysisDomError('http-denied')
      if (status !== undefined && status >= 500 && status <= 599) {
        // Keep the existing broader access-denial stop without labeling every denial as human verification.
        if (await challengeVisible()) throw new LegendAnalysisDomError('http-denied')
        if (attempt === 1) throw new LegendAnalysisDomError('server-error')
        await wait(Math.max(5000, interval)); check(); continue
      }
      if ((status ?? 0) >= 400) throw new LegendAnalysisDomError('http-error')
      return
    }
  }
  const observation = async (requestedPage = 1, previousBody: string | null = null): Promise<LegendAnalysisDomObservation> => {
    lastStep = 'ranking-observation'
    const deadline = now() + 10000
    while (true) {
      check()
      await observeHumanVerification()
      if (humanVerification.domDetected === true) throw new LegendAnalysisDomError('http-denied')
      const value = await page.evaluate(observeLegendAnalysisDom, { salt, characterIds, ...(options.includePlayers ? { includePlayers: true } : {}) })
      if (value.accessChallenge === true) throw new LegendAnalysisDomError('http-denied')
      if (value.maintenance) throw new LegendAnalysisDomError('maintenance')
      const range = value.range
      if (!legendAnalysisPageUrlMatches(page.url(), requestedPage)) throw new LegendAnalysisDomError('condition-mismatch')
      const keys = value.entries?.map(entry => `${entry.accountKey}:${entry.characterId}`) ?? []
      const readable = legendAnalysisPageUrlMatches(value.observedUrl, requestedPage)
        && value.conditionsConfirmed && value.currentActConfirmed && value.selectedPage === requestedPage
        && range !== null && Number.isSafeInteger(range.total) && range.total >= 1
        && range.from === (requestedPage - 1) * 20 + 1 && range.to === Math.min(requestedPage * 20, range.total)
        && range.to >= range.from && Array.isArray(value.entries) && value.entries.length === range.to - range.from + 1
        && new Set(keys).size === keys.length && (previousBody === null || bodySignature(value.entries) !== previousBody)
      lastLoginRequired = value.loginRequired === true; lastSignedIn = typeof value.signedIn === 'boolean' ? value.signedIn : null
      lastRankingReadable = readable
      const signedInReadable = value.signedIn && !value.loginRequired
      const readableAfterSignIn = signedInFirstPageConfirmed && now() >= deadline && value.signedIn === false
        && value.authenticationEvidence === 'login-control' && value.loginRequired === false
      if (readable && (signedInReadable || readableAfterSignIn)) {
        if (signedInReadable && requestedPage === 1) signedInFirstPageConfirmed = true
        if (readableAfterSignIn) readableWithoutSignInReadCount++
        // Count fully accepted ranking reads; PLAY Act pages are tracked by navigation count only.
        successfulReadCount++
        return value
      }
      if (now() >= deadline) throw new LegendAnalysisDomError(value.loginRequired || !value.signedIn ? 'authentication-required' : 'unsupported-dom')
      await wait(250)
    }
  }
  const readAct = async (): Promise<{ id: string; label: string }> => {
    if (!firstPlayUrl || !/^https:\/\/www\.streetfighter\.com\/6\/buckler\/ja-jp\/profile\/\d+\/play$/.test(firstPlayUrl)) throw new LegendAnalysisDomError('act-unconfirmed')
    lastAccepted = null
    lastStep = 'act-navigation'; await navigate(firstPlayUrl)
    lastStep = 'act-observation'
    const deadline = now() + 10000
    while (true) {
      check()
      const value = await page.evaluate(observeLegendAnalysisAct)
      if (value) return value
      if (now() >= deadline) throw new LegendAnalysisDomError('act-unconfirmed')
      await wait(250)
    }
  }
  const profileObservation = async (url: string, playerId: string, wantedCharacters: string[], mode: '1' | '2', stable: boolean): Promise<LegendPlayerProfileObservation> => {
    lastStep = 'profile-observation'
    const deadline = now() + 10000
    let signature: string | null = null, stableSince = now()
    while (true) {
      check(); await observeHumanVerification()
      if (humanVerification.domDetected === true) throw new LegendAnalysisDomError('http-denied')
      const value = await page.evaluate(observeLegendPlayerProfile, { characterIds: wantedCharacters })
      if (page.url() !== url || value.observedUrl !== url || value.playerId !== null && value.playerId !== playerId) throw new LegendAnalysisDomError('condition-mismatch')
      if (value.actId !== null && value.actId !== act!.id) throw new LegendAnalysisDomError('act-changed')
      if (value.errorVisible) throw new LegendAnalysisDomError('read-failed')
      if (value.playerId === playerId && value.actId === act!.id && value.controlsConfirmed && value.mode === mode && !value.loading && value.matches !== null) {
        const current = JSON.stringify(value.matches)
        if (!stable) return value
        if (signature !== current) { signature = current; stableSince = now() }
        else if (now() - stableSince >= 500) return value
      } else signature = null
      if (now() >= deadline) throw new LegendAnalysisDomError('unsupported-dom')
      await wait(250)
    }
  }
  return {
    async initialize() {
      if (running || act) throw new LegendAnalysisDomError('invalid-request')
      running = true
      try {
        lastStep = 'ranking-navigation'; await navigate(legendAnalysisPageUrl(1), 1); firstPlayUrl = (await observation()).firstPlayUrl; act = await readAct()
        lastStep = 'ranking-navigation'; await navigate(legendAnalysisPageUrl(1), 1)
        await observation()
        // Server-rendered controls may appear before React has attached onChange.
        // Re-select through the ordinary UI, at most three times, without modifying DOM or reading app state.
        let rosterModalVisible = false
        for (let attempt = 0; attempt < 3; attempt++) {
          check(); lastStep = 'roster-condition'
          const select = page.locator('select:visible').first()
          await select.selectOption('1')
          await wait(500)
          await select.selectOption('4')
          await wait(1000)
          const control = await page.evaluate(observeLegendAnalysisRosterControl)
          characterFilter = ['1', '2', '3', '4'].includes(control.characterFilter ?? '') ? control.characterFilter : null
          visibleRosterButtonCount = Number.isSafeInteger(control.visibleRosterButtonCount) && control.visibleRosterButtonCount >= 0 && control.visibleRosterButtonCount <= 20 ? control.visibleRosterButtonCount : null
          rosterModalVisible = control.rosterModalVisible === true
          if (characterFilter === '4' && (rosterModalVisible || visibleRosterButtonCount && visibleRosterButtonCount > 0)) break
          if (attempt === 2) throw new LegendAnalysisDomError('unsupported-dom')
        }
        if (!rosterModalVisible) {
          lastStep = 'roster-open'
          clickObservation = await page.evaluate(observeLegendAnalysisClickTarget)
          const target = clickObservation?.pointerEventsNone && clickObservation.parentParagraph
            ? page.locator('p:has(> span[class*="ranking_search_character_btn"]):visible').first()
            : page.locator('span[class*="ranking_search_character_btn"]:visible').first()
          try { await target.click({ timeout: 10000 }) }
          catch (error) {
            clickFailure = classifyLegendClickFailure(error)
            // Selecting character mode may itself have opened the modal during the click wait.
            rosterModalVisible = (await page.evaluate(observeLegendAnalysisRosterControl)).rosterModalVisible === true
            if (!rosterModalVisible) {
              clickObservation = await page.evaluate(observeLegendAnalysisClickTarget)
              const rejection = page.locator('button#onetrust-reject-all-handler:visible')
              if (clickObservation?.hitKind !== 'cookie-consent' || await rejection.count() !== 1) throw new LegendAnalysisDomError('read-failed')
              await rejection.click({ timeout: 10000 })
              await wait(1000)
              await target.click({ timeout: 10000 })
            }
          }
        }
        lastStep = 'roster-observation'
        const deadline = now() + 10000
        let roster: Awaited<ReturnType<typeof observeLegendAnalysisRoster>>['roster'] = null
        while (true) {
          check(); const observation = await page.evaluate(observeLegendAnalysisRoster)
          roster = observation.roster; rosterDiagnostics = observation.diagnostics
          if (roster || now() >= deadline) break
          await wait(250)
        }
        if (!roster || options.characterIds && JSON.stringify(roster.map(value => value.characterId)) !== JSON.stringify([...options.characterIds].sort())) throw new LegendAnalysisDomError('condition-mismatch')
        characterIds = roster.map(value => value.characterId)
        lastAccepted = null // Roster mode leaves different controls/modal state: the first fetch must use fixed goto.
        ready = true
        lastStep = 'complete'
        return { act: { ...act }, characterIds: [...characterIds], characterNames: Object.fromEntries(roster.map(value => [value.characterId, value.name])) }
      }
      catch (error) { lastErrorCode = error instanceof LegendAnalysisDomError ? error.code : 'read-failed'; throw new LegendAnalysisDomError(lastErrorCode) }
      finally { running = false }
    },
    async confirmAct() {
      if (running || !act || !ready) throw new LegendAnalysisDomError('invalid-request')
      running = true
      try { if (JSON.stringify(await readAct()) !== JSON.stringify(act)) throw new LegendAnalysisDomError('act-changed') }
      catch (error) { lastErrorCode = error instanceof LegendAnalysisDomError ? error.code : 'read-failed'; throw new LegendAnalysisDomError(lastErrorCode) }
      finally { running = false }
    },
    async fetchPage(pageNumber: number, url: string): Promise<LegendAnalysisPage> {
      if (running) throw new LegendAnalysisDomError('concurrent-read')
      if (!act || !ready || !legendAnalysisPageUrlMatches(url, pageNumber)) throw new LegendAnalysisDomError('invalid-request')
      running = true
      try {
        const previous = lastAccepted
        const previousBody = previous !== null && pageNumber === previous.page + 1 ? previous.body : null
        lastAccepted = null
        lastStep = 'ranking-navigation'; await navigate(legendAnalysisPageUrl(pageNumber), pageNumber)
        const value = await observation(pageNumber, previousBody)
        const range = value.range!
        if (value.selectedPage !== pageNumber) throw new LegendAnalysisDomError('condition-mismatch')
        lastAccepted = { page: pageNumber, body: bodySignature(value.entries!) }
        return { sourceUrl: legendAnalysisPageUrl(pageNumber), page: pageNumber, pageSize: 20, totalCount: range.total, from: range.from, to: range.to,
          nextPage: range.to < range.total ? pageNumber + 1 : null, actId: act.id, conditions: { ...LEGEND_ANALYSIS_CONDITIONS },
          conditionsConfirmed: true, actConfirmed: true, rosterConfirmed: true, entries: value.entries! }
      } catch (error) { lastErrorCode = error instanceof LegendAnalysisDomError ? error.code : 'read-failed'; throw new LegendAnalysisDomError(lastErrorCode) }
      finally { running = false }
    },
    async fetchPlayerRankedMatches(playerId: string, requestedCharacters: readonly string[]): Promise<Record<string, number>> {
      if (running) throw new LegendAnalysisDomError('concurrent-read')
      if (!options.includePlayers || !ready || !act || !/^\d{1,20}$/.test(playerId) || !requestedCharacters.length
        || new Set(requestedCharacters).size !== requestedCharacters.length || requestedCharacters.some(id => !characterIds.includes(id))) throw new LegendAnalysisDomError('invalid-request')
      running = true
      const wantedCharacters = [...requestedCharacters], url = `https://www.streetfighter.com/6/buckler/ja-jp/profile/${playerId}/play`
      try {
        lastAccepted = null
        lastStep = 'profile-navigation'; await navigate(url)
        // A fresh PLAY document defaults to all modes. Its visible Act must still be the captured Act.
        await profileObservation(url, playerId, wantedCharacters, '1', false)
        lastStep = 'profile-filter'; await beginNavigation(null)
        const requests = new Set<Request>()
        const onRequest = (request: Request): void => { if (matchesLegendRankedMatchRequest(request, playerId, act!.id)) requests.add(request) }
        page.on('request', onRequest)
        // Observe only the request created by the ordinary select change, never an earlier response.
        const completion = page.waitForResponse(response => requests.has(response.request()), { timeout: 30000 }).catch(() => null)
        try {
          await page.locator('select:visible').nth(1).selectOption('2', { timeout: 10000 })
          const response = await completion
          check()
          if (!response || requests.size !== 1) throw new LegendAnalysisDomError('unsupported-dom')
          const status = response.status()
          lastHttpStatus = Number.isSafeInteger(status) && status >= 100 && status <= 599 ? status : null
          humanVerification = readDistributionHumanVerificationResponse(response)
          await observeHumanVerification()
          if (humanVerification.wafAction || humanVerification.domDetected === true || [401, 403, 429].includes(status)) throw new LegendAnalysisDomError('http-denied')
          if (status >= 500) throw new LegendAnalysisDomError('server-error')
          if (status < 200 || status >= 300) throw new LegendAnalysisDomError('http-error')
          if (await response.finished()) throw new LegendAnalysisDomError('read-failed')
          await page.evaluate(settleLegendPlayerRender)
          const value = await profileObservation(url, playerId, wantedCharacters, '2', true)
          if (requests.size !== 1) throw new LegendAnalysisDomError('unsupported-dom')
          lastStep = 'complete'
          return { ...value.matches! }
        } finally { page.off('request', onRequest) }
      } catch (error) { lastErrorCode = error instanceof LegendAnalysisDomError ? error.code : 'read-failed'; throw new LegendAnalysisDomError(lastErrorCode) }
      finally { running = false }
    },
    getDiagnostics: () => ({ requestCount, lastStep, lastErrorCode, characterFilter, visibleRosterButtonCount,
      clickFailure, clickHitKind: clickObservation?.hitKind ?? null, clickHitTag: clickObservation?.hitTag ?? null,
      parentParagraph: clickObservation?.parentParagraph === true, pointerEventsNone: clickObservation?.pointerEventsNone === true,
      rosterDiagnostics: ready && rosterDiagnostics ? { ...rosterDiagnostics, items: [] } : rosterDiagnostics,
      lastLoginRequired, lastSignedIn, lastRankingReadable, readableWithoutSignInReadCount, lastHttpStatus,
      lastAttemptedPage, successfulReadCount, humanVerification: { ...humanVerification } }),
  }
}
