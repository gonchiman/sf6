import type { SteamPlayerCountAppId, SteamPlayerCountDateRange, SteamPlayerCountGame, SteamPlayerCountObservation, SteamPlayerCountRangeSelection } from '../types/steamPlayerCount.ts'
import { getSteamPlayerCountJstDate, parseSteamPlayerCountRangeSelection, resolveSteamPlayerCountRange } from './steamPlayerCount.ts'
import { createSteamPlayerCountFeed, shouldAcceptSteamPlayerCountPublication, type SteamPlayerCountFeed, type SteamPlayerCountPublication } from './steamPlayerCountFeed.ts'
import { getSteamPlayerCountGame, STEAM_PLAYER_COUNT_GAMES } from './steamPlayerCountGames.ts'

export interface SteamPlayerCountComparisonEntry {
  game: SteamPlayerCountGame
  publication: SteamPlayerCountPublication
  observations: SteamPlayerCountObservation[]
}

export interface SteamPlayerCountComparisonState {
  status: 'loading' | 'ready' | 'error'
  range: SteamPlayerCountDateRange
  dataRange: SteamPlayerCountDateRange | null
  comparisonRange: SteamPlayerCountDateRange | null
  entries: readonly SteamPlayerCountComparisonEntry[]
  refreshError: boolean
  failedAppIds: readonly SteamPlayerCountAppId[]
  now: Date
}

type PublicationEntry = Pick<SteamPlayerCountComparisonEntry, 'game' | 'publication'>
type ControllerOptions = {
  now?: () => Date
  createFeed?: (appId: SteamPlayerCountAppId) => SteamPlayerCountFeed
}

const feeds = new Map<SteamPlayerCountAppId, SteamPlayerCountFeed>()
function sharedFeed(appId: SteamPlayerCountAppId): SteamPlayerCountFeed {
  let feed = feeds.get(appId)
  if (!feed) { feed = createSteamPlayerCountFeed({ appId }); feeds.set(appId, feed) }
  return feed
}
const sameRange = (a: SteamPlayerCountDateRange | null, b: SteamPlayerCountDateRange | null) => a?.from === b?.from && a?.to === b?.to
const selectionKey = (selection: SteamPlayerCountRangeSelection) => typeof selection === 'string' ? selection : JSON.stringify([selection.from, selection.to])

export function steamPlayerCountComparisonAppIds(appIds: readonly SteamPlayerCountAppId[]): SteamPlayerCountAppId[] {
  if (!appIds.length) throw new Error('比較するゲームを1件以上選択してください。')
  appIds.forEach(getSteamPlayerCountGame)
  const selected = new Set(appIds)
  return STEAM_PLAYER_COUNT_GAMES.filter(game => selected.has(game.appId)).map(game => game.appId)
}

/** All titles use the same dates; the "all" preset follows their observed-date intersection. */
function ranges(selection: SteamPlayerCountRangeSelection, publications: readonly PublicationEntry[], now: Date) {
  let dataRange: SteamPlayerCountDateRange | null = null
  if (publications.length && publications.every(entry => entry.publication.manifest.days.length)) {
    const bounds = publications.map(({ publication }) => ({
      from: publication.manifest.days.map(day => getSteamPlayerCountJstDate(day.firstObservedAt)).sort()[0],
      to: publication.manifest.days.map(day => getSteamPlayerCountJstDate(day.lastObservedAt)).sort().at(-1)!,
    }))
    const from = bounds.map(bound => bound.from).sort().at(-1)!, to = bounds.map(bound => bound.to).sort()[0]
    if (from <= to) dataRange = { from, to }
  }
  const range = selection === 'all' && dataRange ? dataRange : resolveSteamPlayerCountRange(selection, null, now)
  const today = getSteamPlayerCountJstDate(now)
  const from = dataRange && dataRange.from > range.from ? dataRange.from : range.from
  const to = range.to < today ? range.to : today
  const comparisonRange = dataRange && from <= to ? { from, to } : null
  return { range, dataRange, comparisonRange }
}

export function initialSteamPlayerCountComparisonState(selection: SteamPlayerCountRangeSelection = '7d', now = new Date()): SteamPlayerCountComparisonState {
  return { status: 'loading', ...ranges(parseSteamPlayerCountRangeSelection(selection), [], now), entries: [], refreshError: false, failedAppIds: [], now }
}

/** Commit a whole comparison together, retaining its last verified snapshot on a partial refresh failure. */
export function createSteamPlayerCountComparisonController(appIds: readonly SteamPlayerCountAppId[],
  onChange: (state: SteamPlayerCountComparisonState) => void, initialSelection: SteamPlayerCountRangeSelection = '7d', options: ControllerOptions = {}) {
  const ids = steamPlayerCountComparisonAppIds(appIds)
  const sources = ids.map(appId => ({ game: getSteamPlayerCountGame(appId), feed: (options.createFeed ?? sharedFeed)(appId) }))
  const clock = options.now ?? (() => new Date())
  let selection = parseSteamPlayerCountRangeSelection(initialSelection), version = 0, active = true
  let state = initialSteamPlayerCountComparisonState(selection, clock())
  let verified: SteamPlayerCountComparisonState | null = null
  let knownPublications: readonly PublicationEntry[] = []
  let verifiedSelectionKey: string | null = null
  let pending: Promise<void> | null = null
  function update(next: SteamPlayerCountComparisonState) { if (active) { state = next; onChange(state) } }
  function align() {
    const now = clock(), resolved = ranges(selection, verified?.entries ?? knownPublications, now)
    if (!sameRange(state.range, resolved.range)) update({ ...state, ...resolved, status: 'loading', entries: [], refreshError: false, failedAppIds: [], now })
  }
  function fail(failedAppIds: readonly SteamPlayerCountAppId[]) {
    if (!active) return
    const now = clock(), resolved = ranges(selection, verified?.entries ?? knownPublications, now)
    if (verified && verifiedSelectionKey === selectionKey(selection) && sameRange(verified.range, resolved.range)) {
      update({ ...verified, refreshError: true, failedAppIds })
    }
    else update({ status: 'error', ...resolved, entries: [], refreshError: false, failedAppIds, now })
  }
  async function read() {
    const results = await Promise.allSettled(sources.map(source => source.feed.loadPublication()))
    if (!active) return
    const failedPublications = results.flatMap((result, index) => result.status === 'rejected' ? [sources[index].game.appId] : [])
    if (failedPublications.length) { fail(failedPublications); return }
    const staleIds: SteamPlayerCountAppId[] = []
    const publications = results.map((result, index): PublicationEntry => {
      const { game } = sources[index], next = (result as PromiseFulfilledResult<SteamPlayerCountPublication>).value
      const previous = verified?.entries.find(entry => entry.game.appId === game.appId)?.publication ?? null
      if (!shouldAcceptSteamPlayerCountPublication(previous, next)) {
        staleIds.push(game.appId)
        return { game, publication: previous! }
      }
      return { game, publication: next }
    })
    // A regression in one title must not combine the old title with newly refreshed peers.
    if (staleIds.length) { fail(staleIds); return }
    knownPublications = publications
    for (;;) {
      const readingVersion = version, startedAt = clock(), resolved = ranges(selection, publications, startedAt)
      if (!sameRange(state.range, resolved.range)) update({ ...state, ...resolved, status: 'loading', entries: [], refreshError: false, failedAppIds: [], now: startedAt })
      const loads = await Promise.allSettled(publications.map((entry, index) => sources[index].feed.loadRange(entry.publication, resolved.range)))
      if (!active) return
      const endedAt = clock(), latest = ranges(selection, publications, endedAt)
      if (version !== readingVersion || !sameRange(resolved.range, latest.range)) continue
      const failedIds = loads.flatMap((result, index) => result.status === 'rejected' ? [sources[index].game.appId] : [])
      if (failedIds.length) { fail(failedIds); return }
      const entries = publications.map((entry, index): SteamPlayerCountComparisonEntry => ({
        ...entry, observations: (loads[index] as PromiseFulfilledResult<SteamPlayerCountObservation[]>).value,
      }))
      // Reuse the single-title controller's immutable-overlap check after feed hash validation.
      const changedIds = entries.filter(entry => {
        const previous = verified?.entries.find(item => item.game.appId === entry.game.appId)
        if (!previous) return false
        const byId = new Map(entry.observations.map(item => [item.id, item]))
        return previous.observations.some(item => {
          const date = getSteamPlayerCountJstDate(item.observedAt)
          return date >= resolved.range.from && date <= resolved.range.to && JSON.stringify(byId.get(item.id)) !== JSON.stringify(item)
        })
      }).map(entry => entry.game.appId)
      if (changedIds.length) { fail(changedIds); return }
      verified = { status: 'ready', ...latest, entries, refreshError: staleIds.length > 0, failedAppIds: staleIds, now: endedAt }
      verifiedSelectionKey = selectionKey(selection)
      update(verified)
      return
    }
  }
  function refresh(): Promise<void> {
    if (!active) return Promise.resolve()
    align()
    if (pending) return pending
    if (state.status === 'error') update({ ...state, status: 'loading', failedAppIds: [] })
    const request = read().finally(() => { if (pending === request) pending = null })
    pending = request
    return request
  }
  return {
    getState: () => state,
    getSelection: () => selection,
    refresh,
    setRange(value: SteamPlayerCountRangeSelection) {
      const next = parseSteamPlayerCountRangeSelection(value)
      if (selectionKey(selection) === selectionKey(next)) return
      selection = next; version++
      const now = clock()
      update({ status: 'loading', ...ranges(selection, verified?.entries ?? knownPublications, now), entries: [], refreshError: false, failedAppIds: [], now })
      void refresh()
    },
    dispose() { active = false },
  }
}
