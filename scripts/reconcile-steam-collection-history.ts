import { mkdir, rename, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import {
  isSteamCollectionScheduledAt, parseSteamCollectionHistoryDay, steamCollectionScheduleForObservation,
  STEAM_COLLECTION_ERROR_CODES, STEAM_COLLECTION_HISTORY_GRACE_MS,
  type SteamCollectionHistoryDay, type SteamCollectionHistoryDispatch, type SteamCollectionHistoryGame, type SteamCollectionHistorySlot,
} from '../src/lib/steamCollectionHistory.ts'
import { parseSteamPlayerCountDay, STEAM_PLAYER_COUNT_SLOT_MS } from '../src/lib/steamPlayerCount.ts'
import { STEAM_PLAYER_COUNT_GAMES } from '../src/lib/steamPlayerCountGames.ts'
import type { SteamPlayerCountAppId, SteamPlayerCountObservation } from '../src/types/steamPlayerCount.ts'
import { readSteamCollectionEvidence, type SteamCollectorEvidence, type SteamDispatchEvidence } from './lib/steam-collection-history-evidence.ts'
import { checkSteamParents, parseSteamJson, readSteamBytes, steamFileInfo, steamJson } from './lib/steam-player-count-files.ts'
import { isAllowedSteamCollectionHistoryWorkflow, publishSteamCollectionHistory } from './publish-steam-player-count-history.ts'

const LOOKBACK_MS = 24 * 60 * 60_000

type Observation = SteamPlayerCountObservation & { appId: SteamPlayerCountAppId }
type Evidence = { dispatch: SteamDispatchEvidence[]; collections: SteamCollectorEvidence[] }

function slotForCollection(run: SteamCollectorEvidence): string | undefined {
  if (run.scheduledAt !== undefined) return isSteamCollectionScheduledAt(run.scheduledAt) ? run.scheduledAt : undefined
  const created = Date.parse(run.createdAt)
  const slot = steamCollectionScheduleForObservation(created)
  // Legacy runs have no input metadata. Only associate runs created during the dispatch window.
  if (created >= slot && created < slot + 60_000) return new Date(slot).toISOString()
}

function collectionResult(appId: SteamPlayerCountAppId, scheduledAt: string, runs: SteamCollectorEvidence[],
  observations: Observation[], previous: SteamCollectionHistoryGame | undefined, checkedAt: string): SteamCollectionHistoryGame {
  if (previous?.status === 'published') return previous
  const inSlot = (observedAt: string) => observedAt >= scheduledAt && observedAt <= checkedAt
    && steamCollectionScheduleForObservation(Date.parse(observedAt)) === Date.parse(scheduledAt)
  const belongsToSlot = (observation: Observation) => runs.some(run => observation.runId === run.runId)
  const published = observations.find(observation => observation.appId === appId && belongsToSlot(observation)
    && observation.runId !== null && observation.runAttempt !== null && inSlot(observation.observedAt))
  if (published?.runId && published.runAttempt) {
    return { appId, status: 'published', runId: published.runId, attempt: published.runAttempt, observedAt: published.observedAt }
  }
  const run = runs.find(run => run.scheduledAt === scheduledAt)
  if (!run) return previous && previous.status !== 'pending' ? previous : { appId, status: 'unknown' }
  const identity = { appId, runId: run.runId, attempt: run.attempt }
  const game = run.games.find(result => result.appId === appId)
  if (!run.completed) return { ...identity, status: 'pending' }
  if (game?.status === 'failed') {
    const errorCode = STEAM_COLLECTION_ERROR_CODES.find(code => code === game.errorCode)
    return { ...identity, status: 'collect-failed', ...(errorCode ? { errorCode } : {}) }
  }
  const observedAt = game?.observedAt ?? observations.find(observation =>
    observation.appId === appId && observation.runId === run.runId && observation.runAttempt === run.attempt)?.observedAt
  if (observedAt && observedAt > scheduledAt && observedAt <= checkedAt && !inSlot(observedAt)) {
    return { ...identity, status: 'unknown', observedAt }
  }
  if (run.saveFailed && (game?.status === 'succeeded' || !run.collectFailed)) {
    return { ...identity, status: 'save-failed', ...(observedAt && inSlot(observedAt) ? { observedAt } : {}) }
  }
  if (previous && ['collect-failed', 'save-failed'].includes(previous.status) && previous.runId === run.runId) return previous
  if (run.collectFailed && !game) return { ...identity, status: 'collect-failed', errorCode: 'job' }
  return { ...identity, status: 'unknown' }
}

export function reconcileSteamCollectionDays(now: Date, evidence: Evidence, observations: Observation[],
  existing: SteamCollectionHistoryDay[]): SteamCollectionHistoryDay[] {
  const checkedAt = now.toISOString()
  const days = new Map(existing.map(day => [day.date, day]))
  const slotsByDay = new Map(existing.map(day => [day.date, new Map(day.slots.map(slot => [slot.scheduledAt, slot]))]))
  const collections = new Map<string, SteamCollectorEvidence[]>()
  for (const run of evidence.collections) {
    const slot = slotForCollection(run)
    if (slot) collections.set(slot, [...(collections.get(slot) ?? []), run])
  }
  for (const runs of collections.values()) {
    runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.attempt - a.attempt)
  }
  const dispatches = new Map<string, SteamCollectionHistoryDispatch>()
  for (const { scheduledAt, ...dispatch } of evidence.dispatch) {
    const earlier = dispatches.get(scheduledAt)
    if (isSteamCollectionScheduledAt(scheduledAt) && (!earlier || (earlier.reason === 'skipped' && dispatch.reason === 'failed'))) {
      dispatches.set(scheduledAt, dispatch)
    }
  }
  const cutoff = now.getTime() - LOOKBACK_MS
  const firstSlot = steamCollectionScheduleForObservation(cutoff)
  for (let time = firstSlot < cutoff ? firstSlot + STEAM_PLAYER_COUNT_SLOT_MS : firstSlot;
    time <= now.getTime(); time += STEAM_PLAYER_COUNT_SLOT_MS) {
    const scheduledAt = new Date(time).toISOString(), date = scheduledAt.slice(0, 10)
    if ((days.get(date)?.checkedAt ?? '') > checkedAt) continue
    const slots = slotsByDay.get(date) ?? new Map<string, SteamCollectionHistorySlot>()
    const previous = slots.get(scheduledAt)
    const runs = collections.get(scheduledAt) ?? []
    const dispatch = dispatches.get(scheduledAt) ?? previous?.dispatch
    const games = STEAM_PLAYER_COUNT_GAMES.map(({ appId }) => {
      const prior = previous?.games.find(game => game.appId === appId)
      const result = collectionResult(appId, scheduledAt, runs, observations, prior, checkedAt)
      return result.status === 'unknown' && !result.runId && !dispatch && time + STEAM_COLLECTION_HISTORY_GRACE_MS > now.getTime()
        ? { appId, status: 'pending' as const } : result
    })
    const dispatched = runs.some(run => run.scheduledAt === scheduledAt) || games.some(game => game.status === 'published')
    slots.set(scheduledAt, { scheduledAt, games, ...(!dispatched && dispatch ? { dispatch } : {}) })
    slotsByDay.set(date, slots)
  }
  return [...slotsByDay].map(([date, slots]) => {
    const previous = days.get(date)
    const next = [...slots.values()].sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt))
    if (previous && JSON.stringify(previous.slots) === JSON.stringify(next)) return previous
    return parseSteamCollectionHistoryDay({ schemaVersion: 1, date, checkedAt, slots: next }, date)
  })
}

async function updateHistory(historyRoot: string, now: Date, evidence: Evidence): Promise<void> {
  const dates = [...new Set([now.getTime() - LOOKBACK_MS, now.getTime()].map(time => new Date(time).toISOString().slice(0, 10)))]
  const historyDir = resolve(historyRoot, 'collection-history/days')
  const loadJson = async (path: string) => await steamFileInfo(path) ? parseSteamJson(await readSteamBytes(path)) : null
  const observations: Observation[] = []
  const existing: SteamCollectionHistoryDay[] = []
  await checkSteamParents(historyDir)
  for (const date of dates) {
    const path = resolve(historyDir, `${date}.json`)
    const raw = await loadJson(path)
    if (raw !== null) existing.push(parseSteamCollectionHistoryDay(raw, date))
    for (const { appId, historyPath } of STEAM_PLAYER_COUNT_GAMES) {
      const rawDay = await loadJson(resolve(historyRoot, historyPath, 'days', `${date}.json`))
      if (rawDay === null) continue
      const day = parseSteamPlayerCountDay(rawDay, undefined, appId)
      if (day.date !== date) throw new Error('観測ファイルの日付が一致しません。')
      observations.push(...day.observations.map(item => ({ ...item, appId })))
    }
  }
  await mkdir(historyDir, { recursive: true })
  for (const day of reconcileSteamCollectionDays(now, evidence, observations, existing)) {
    if (existing.some(previous => previous === day)) continue
    const path = resolve(historyDir, `${day.date}.json`), temporary = `${path}.${randomUUID()}.tmp`
    await writeFile(temporary, steamJson(day), { flag: 'wx' })
    await rename(temporary, path)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const now = new Date()
  if (!isAllowedSteamCollectionHistoryWorkflow(process.env) || !process.env.GH_TOKEN) {
    console.error('固定mainのSteam取得履歴workflowが必要です。')
    process.exitCode = 1
  } else {
    readSteamCollectionEvidence(now)
      .then(evidence => publishSteamCollectionHistory(historyRoot => updateHistory(historyRoot, now, evidence)))
      .then(() => console.log('Steam取得履歴を照合しました。'))
      .catch(() => { console.error('Steam取得履歴の照合または公開に失敗しました。'); process.exitCode = 1 })
  }
}
