import type { SteamPlayerCountDateRange, SteamPlayerCountDay, SteamPlayerCountDayDescriptor, SteamPlayerCountManifest, SteamPlayerCountObservation } from '../types/steamPlayerCount.ts'
import { getDefaultSteamPlayerCountRange, getSteamPlayerCountJstDate, getSteamPlayerCountUtcDates,
  parseSteamPlayerCountDateRange, parseSteamPlayerCountDay, parseSteamPlayerCountDayDescriptor, parseSteamPlayerCountManifest } from './steamPlayerCount.ts'
import type { PublishedDataFeedOptions, PublishedDataPublication } from './publishedDataFeed.ts'

export type SteamPlayerCountPublication = PublishedDataPublication<SteamPlayerCountManifest>
export const STEAM_PLAYER_COUNT_HISTORY_BASE_URL = 'https://raw.githubusercontent.com/gonchiman/sf6/refs/heads/codex/steam-player-count-history/public/'
const trailingSlash = (value: string): string => value.endsWith('/') ? value : `${value}/`

export function createSteamPlayerCountFeed(options: PublishedDataFeedOptions = {}) {
  const fetchData = options.fetch ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args))
  const bases = {
    history: trailingSlash(options.historyBaseUrl ?? STEAM_PLAYER_COUNT_HISTORY_BASE_URL),
    bundled: trailingSlash(options.localBaseUrl ?? `${trailingSlash(import.meta.env?.BASE_URL ?? '/')}data/steam-player-count/`),
  }
  const timeoutMs = options.timeoutMs ?? 10_000
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) throw new Error('読込の制限時間が不正です。')
  let publicationRequest: Promise<SteamPlayerCountPublication> | null = null
  const dayRequests = new Map<string, Promise<SteamPlayerCountDay>>()

  async function readText(url: string, refresh = false): Promise<string> {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort()
        reject(new Error('Steam同時接続数の読込が時間内に完了しませんでした。'))
      }, timeoutMs)
    })
    try {
      return await Promise.race([(async () => {
        const response = await fetchData(url, { cache: refresh ? 'no-store' : 'default', credentials: 'omit', signal: controller.signal })
        if (!response.ok) throw new Error('Steam同時接続数を読み込めませんでした。')
        return response.text()
      })(), deadline])
    } finally { clearTimeout(timer) }
  }

  function validatePublication(publication: SteamPlayerCountPublication): SteamPlayerCountManifest {
    if (!['history', 'bundled'].includes(publication.source) || publication.baseUrl !== bases[publication.source]) throw new Error('Steam同時接続数の取得元が一致しません。')
    return parseSteamPlayerCountManifest(publication.manifest)
  }

  async function loadDay(publication: SteamPlayerCountPublication, descriptor: SteamPlayerCountDayDescriptor): Promise<SteamPlayerCountDay> {
    const manifest = validatePublication(publication), expected = parseSteamPlayerCountDayDescriptor(descriptor)
    const listed = manifest.days.find(day => day.date === expected.date)
    if (!listed || JSON.stringify(listed) !== JSON.stringify(expected)) throw new Error('Steam同時接続数の日別ファイルが一覧と一致しません。')
    const key = JSON.stringify([publication.source, publication.baseUrl, expected])
    const cached = dayRequests.get(key)
    if (cached) return cached
    const request = readText(`${publication.baseUrl}${expected.path}?sha256=${expected.sha256}`).then(async raw => {
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw))
      const sha256 = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
      if (sha256 !== expected.sha256) throw new Error('Steam同時接続数の日別ファイルのハッシュが一致しません。')
      return parseSteamPlayerCountDay(JSON.parse(raw) as unknown, expected)
    }).catch(error => {
      if (dayRequests.get(key) === request) dayRequests.delete(key)
      throw error
    })
    dayRequests.set(key, request)
    return request
  }

  async function readPublication(source: SteamPlayerCountPublication['source']): Promise<SteamPlayerCountPublication> {
    const baseUrl = bases[source]
    const manifest = parseSteamPlayerCountManifest(JSON.parse(await readText(`${baseUrl}index.json`, true)) as unknown)
    const publication = { manifest, source, baseUrl }
    const latest = [...manifest.days].sort((a, b) => b.date.localeCompare(a.date))[0]
    if (latest) await loadDay(publication, latest)
    return publication
  }

  function loadPublication(): Promise<SteamPlayerCountPublication> {
    if (publicationRequest) return publicationRequest
    const request = readPublication('history').catch(() => readPublication('bundled')).finally(() => {
      if (publicationRequest === request) publicationRequest = null
    })
    publicationRequest = request
    return request
  }

  async function loadRange(publication: SteamPlayerCountPublication, range: SteamPlayerCountDateRange): Promise<SteamPlayerCountObservation[]> {
    const manifest = validatePublication(publication), selection = parseSteamPlayerCountDateRange(range)
    const dates = new Set(getSteamPlayerCountUtcDates(selection))
    const descriptors = manifest.days.filter(day => dates.has(day.date))
    const days = await Promise.all(descriptors.map(day => loadDay(publication, day)))
    const all = days.flatMap(day => day.observations)
    if (new Set(all.map(item => item.id)).size !== all.length) throw new Error('Steam同時接続数の観測IDが日別ファイル間で重複しています。')
    return all.filter(item => {
      const date = getSteamPlayerCountJstDate(item.observedAt)
      return date >= selection.from && date <= selection.to
    }).sort((a, b) => a.observedAt.localeCompare(b.observedAt) || a.id.localeCompare(b.id))
  }

  return { loadPublication, loadDay, loadRange }
}

export const steamPlayerCountFeed = createSteamPlayerCountFeed()
export type SteamPlayerCountFeed = Pick<ReturnType<typeof createSteamPlayerCountFeed>, 'loadPublication' | 'loadRange'>

/** An older CDN response or bundled fallback must not erase successful observations. */
export function shouldAcceptSteamPlayerCountPublication(previous: SteamPlayerCountPublication | null, next: SteamPlayerCountPublication): boolean {
  if (!previous) return true
  if (previous.source === 'history' && next.source === 'bundled') return false
  if (previous.source === next.source && next.manifest.generatedAt < previous.manifest.generatedAt) return false
  const days = new Map(next.manifest.days.map(day => [day.date, day]))
  return previous.manifest.days.every(oldDay => {
    const day = days.get(oldDay.date)
    return !!day && day.observationCount >= oldDay.observationCount && day.firstObservedAt <= oldDay.firstObservedAt
      && day.lastObservedAt >= oldDay.lastObservedAt && (day.observationCount !== oldDay.observationCount || day.sha256 === oldDay.sha256)
  })
}

export interface SteamPlayerCountState {
  status: 'loading' | 'ready' | 'error'
  publication: SteamPlayerCountPublication | null
  range: SteamPlayerCountDateRange
  observations: SteamPlayerCountObservation[]
  refreshError: boolean
}

const sameRange = (a: SteamPlayerCountDateRange | null, b: SteamPlayerCountDateRange | null): boolean => a?.from === b?.from && a?.to === b?.to
export function initialSteamPlayerCountState(range: SteamPlayerCountDateRange | null = null, now = new Date()): SteamPlayerCountState {
  return { status: 'loading', publication: null, range: range ? parseSteamPlayerCountDateRange(range) : getDefaultSteamPlayerCountRange(null, now), observations: [], refreshError: false }
}

/** Keep a verified range intact if a later refresh is incomplete; selection changes load atomically. */
export function createSteamPlayerCountController(feed: SteamPlayerCountFeed, onChange: (state: SteamPlayerCountState) => void,
  initialRange: SteamPlayerCountDateRange | null = null, now: () => Date = () => new Date()) {
  let desiredRange = initialRange ? parseSteamPlayerCountDateRange(initialRange) : null
  let state = initialSteamPlayerCountState(desiredRange, now()), active = true
  let pending: Promise<void> | null = null
  let selectionVersion = 0
  function update(next: SteamPlayerCountState) {
    if (!active) return
    state = next
    onChange(state)
  }
  async function read(): Promise<void> {
    let attempted: { publication: SteamPlayerCountPublication; range: SteamPlayerCountDateRange } | null = null
    try {
      const next = await feed.loadPublication()
      if (!active) return
      const accepted = shouldAcceptSteamPlayerCountPublication(state.publication, next)
      const publication = accepted ? next : state.publication!
      for (;;) {
        const version = selectionVersion
        const range = desiredRange ?? getDefaultSteamPlayerCountRange(publication.manifest, now())
        attempted = { publication, range }
        let observations: SteamPlayerCountObservation[]
        try { observations = await feed.loadRange(publication, range) }
        catch (error) { if (version !== selectionVersion && active) continue; throw error }
        if (!active) return
        if (version !== selectionVersion) continue
        if (state.status === 'ready' && sameRange(state.range, range)) {
          const ids = new Map(observations.map(item => [item.id, item]))
          if (state.observations.some(item => JSON.stringify(ids.get(item.id)) !== JSON.stringify(item))) throw new Error('観測履歴が欠落または変更されています。')
        }
        update({ status: 'ready', publication, range, observations, refreshError: !accepted })
        break
      }
    } catch {
      if (active) update(state.status === 'ready' ? { ...state, refreshError: true } : {
        ...state, ...(attempted ?? {}), status: 'error', observations: [], refreshError: false,
      })
    }
  }
  function refresh(): Promise<void> {
    if (!active) return Promise.resolve()
    if (pending) return pending
    if (state.status === 'error') update({ ...state, status: 'loading' })
    const request = read().finally(() => { if (pending === request) pending = null })
    pending = request
    return request
  }
  return {
    getState: () => state,
    refresh,
    setRange(range: SteamPlayerCountDateRange | null) {
      const selection = range ? parseSteamPlayerCountDateRange(range) : null
      if (sameRange(selection, desiredRange)) return
      desiredRange = selection
      selectionVersion++
      update({ ...state, status: 'loading', range: selection ?? getDefaultSteamPlayerCountRange(state.publication?.manifest ?? null, now()), observations: [], refreshError: false })
      void refresh()
    },
    dispose() { active = false },
  }
}
