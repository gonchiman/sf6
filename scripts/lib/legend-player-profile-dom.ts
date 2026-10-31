import type { Request } from 'playwright'

/** Correlate the normal visible filter change; this endpoint is never requested directly. */
export function matchesLegendRankedMatchRequest(request: Pick<Request, 'url' | 'method' | 'postDataJSON'>, playerId: string, actId: string): boolean {
  try {
    if (request.method() !== 'POST' || request.url() !== 'https://www.streetfighter.com/6/buckler/api/profile/play/act/characterwinrate') return false
    const value: unknown = request.postDataJSON()
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const body = value as Record<string, unknown>
    return String(body.targetShortId) === playerId && String(body.targetSeasonId) === actId.replace(/^act-/, '') && String(body.targetModeId) === '2'
  } catch { return false }
}

export interface LegendPlayerProfileObservation {
  observedUrl: string
  playerId: string | null
  actId: string | null
  mode: '1' | '2' | null
  controlsConfirmed: boolean
  loading: boolean
  errorVisible: boolean
  matches: Record<string, number> | null
}

/** Only rendered PLAY controls, source user code, character assets and visible n勝/m戦 text. */
export function observeLegendPlayerProfile(input: { characterIds: string[] }): LegendPlayerProfileObservation {
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
  const selects = [...document.querySelectorAll('select')].filter(visible) as HTMLSelectElement[]
  const actSelect = selects[0], modeSelect = selects[1]
  const actOptions = actSelect ? [...actSelect.options] : []
  const first = actOptions[0], latest = /^Act\s*:\s*(\d+)$/.exec(first?.textContent?.trim() ?? '')
  const actId = latest && first?.value === latest[1] && actSelect?.value === first.value
    && actOptions.every(option => /^(?:Act\s*:\s*\d+|累計)$/.test(option.textContent?.trim() ?? ''))
    && actOptions.filter(option => /^Act/.test(option.textContent?.trim() ?? '')).every(option => /^\d+$/.test(option.value) && Number(option.value) <= Number(first.value))
    ? `act-${first.value}` : null
  const expectedModes = ['1:モード:すべて', '2:モード:ランクマッチ', '3:モード:カジュアルマッチ', '4:モード:ルームマッチ', '5:モード:バトルハブマッチ']
  const modesConfirmed = modeSelect && JSON.stringify([...modeSelect.options].map(option => `${option.value}:${option.textContent?.trim() ?? ''}`)) === JSON.stringify(expectedModes)
  const activeTabs = [...document.querySelectorAll('li[class*="play_nav_active__"]')].filter(visible)
  const controlsConfirmed = selects.length === 2 && !!actId && !!modesConfirmed && activeTabs.length === 1 && text(activeTabs[0]) === '勝率'
  const mode: '1' | '2' | null = controlsConfirmed && (modeSelect.value === '1' || modeSelect.value === '2') ? modeSelect.value as '1' | '2' : null
  const userCodes = [...document.querySelectorAll('li[class*="status_sid__"]')].filter(visible)
  const playerId = userCodes.length === 1 ? /^ユーザーコード\s*:\s*(\d{1,20})$/.exec(text(userCodes[0]))?.[1] ?? null : null
  const loading = [...document.querySelectorAll('[class*="play_loader__"]')].some(visible)
  const errorVisible = [...document.querySelectorAll('[class*="play_modal_error__"]')].some(visible)
  const base = { observedUrl: location.href, playerId, actId, mode, controlsConfirmed, loading, errorVisible }
  if (!controlsConfirmed || !playerId || loading || errorVisible) return { ...base, matches: null }
  const characterAsset = (container: Element): string | null => {
    const loaded = [...container.querySelectorAll('img')].filter(visible) as HTMLImageElement[]
    const candidates = loaded.filter(image => image.complete && image.naturalWidth > 0 && image.currentSrc && !image.currentSrc.startsWith('data:') && !/\.gif(?:\?|$)/i.test(image.currentSrc)).map(image => image.currentSrc)
    if (!candidates.length) for (const node of container.querySelectorAll('noscript')) {
      const parsed = new DOMParser().parseFromString(node.textContent || node.innerHTML || '', 'text/html')
      const images = [...node.querySelectorAll('img'), ...parsed.querySelectorAll('img')]
      if (images.length === 1 && images[0].getAttribute('src')) candidates.push(images[0].getAttribute('src')!)
    }
    const unique = [...new Set(candidates)]
    if (unique.length !== 1) return null
    try {
      let url = new URL(unique[0], location.origin)
      if (url.origin !== 'https://www.streetfighter.com' || url.username || url.password || url.hash) return null
      if (url.pathname === '/_next/image' || url.pathname === '/6/buckler/_next/image') {
        if (url.searchParams.getAll('url').length !== 1 || [...url.searchParams.keys()].some(key => !['url', 'w', 'q'].includes(key))) return null
        url = new URL(url.searchParams.get('url')!, location.origin)
      }
      return url.origin === 'https://www.streetfighter.com' && !url.search && !url.hash && !url.username && !url.password
        ? /^\/6\/buckler\/assets\/images\/material\/character\/character_([a-z0-9]+)_l\.png$/.exec(url.pathname)?.[1] ?? null : null
    } catch { return null }
  }
  const counts = new Map<string, number>()
  for (const name of [...document.querySelectorAll('p[class*="winning_rate_name__"]')].filter(visible)) {
    const row = name.closest('li')
    if (!row) return { ...base, matches: null }
    const images = row.querySelectorAll('div[class*="winning_rate_image__"]')
    const characterId = images.length === 1 ? characterAsset(images[0]) : null
    if (!characterId && /^ALL$/i.test(text(name))) continue
    const rates = [...row.querySelectorAll('p[class*="winning_rate_rate__"]')].filter(visible)
    const rate = rates.length === 1 ? /^(\d+)\s*勝\s*\/\s*(\d+)\s*戦$/.exec(text(rates[0])) : null
    const wins = rate ? Number(rate[1]) : NaN, matches = rate ? Number(rate[2]) : NaN
    if (!characterId || counts.has(characterId) || !Number.isSafeInteger(wins) || !Number.isSafeInteger(matches) || wins > matches) return { ...base, matches: null }
    counts.set(characterId, matches)
  }
  if (!input.characterIds.length || input.characterIds.some(id => !counts.has(id))) return { ...base, matches: null }
  return { ...base, matches: Object.fromEntries(input.characterIds.map(id => [id, counts.get(id)!])) }
}

/** Let the normal UI consume the completed response before checking its rendered values. */
export async function settleLegendPlayerRender(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('render-timeout')), 5000)
    requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(timeout); resolve() }))
  })
}
