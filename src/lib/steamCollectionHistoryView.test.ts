import assert from 'node:assert/strict'
import test from 'node:test'
import { STEAM_COLLECTION_HISTORY_BASE_URL, type SteamCollectionHistoryDay } from './steamCollectionHistory.ts'
import { buildSteamHistoryRows, readSteamHistoryDays, type SteamHistoryDayRead } from './steamCollectionHistoryView.ts'
import type { SteamPlayerCountComparisonEntry } from './steamPlayerCountComparisonFeed.ts'
import { getSteamPlayerCountGame } from './steamPlayerCountGames.ts'
import type { SteamPlayerCountAppId, SteamPlayerCountObservation } from '../types/steamPlayerCount.ts'

const date = '2026-11-05'
const scheduledAt = `${date}T23:22:00.000Z`
const checkedAt = '2026-11-06T00:15:00.000Z'
const now = new Date(checkedAt)
const time = Date.parse(scheduledAt)
const bounds = { start: time, end: time }
const sf6 = 1364780
const tekken = 1778820
const noDiagnostics: SteamHistoryDayRead = { date, live: null, bundled: null, failed: false }

function observation(runId: string, runAttempt = 1): SteamPlayerCountObservation {
  return {
    id: `steam-${runId}-${runAttempt}`, runId, runAttempt,
    requestStartedAt: `${date}T23:22:02.000Z`, observedAt: `${date}T23:22:03.000Z`, playerCount: 1,
  }
}

function entry(appId: SteamPlayerCountAppId, observations: SteamPlayerCountObservation[] = []): SteamPlayerCountComparisonEntry {
  const game = getSteamPlayerCountGame(appId)
  const firstObservedAt = `${date}T23:07:00.000Z`
  return { game, observations, publication: { source: 'history', baseUrl: '', manifest: {
    schemaVersion: 1, appId, sourceUrl: game.sourceUrl, generatedAt: checkedAt,
    days: [{ date, path: `days/${date}.json`, sha256: '0'.repeat(64), observationCount: 1, firstObservedAt, lastObservedAt: firstObservedAt }],
  } } }
}

function day(slots: SteamCollectionHistoryDay['slots']): SteamCollectionHistoryDay {
  return { schemaVersion: 1, date, checkedAt, slots }
}

test('the verified dispatch failure stays visible when the live day also has records', () => {
  const live = day([{ scheduledAt, games: [{ appId: sf6, status: 'unknown' }] }])
  const bundled = day([{ scheduledAt, games: [], dispatch: { runId: '42', attempt: 1, reason: 'failed', httpStatus: 500 } }])
  const rows = buildSteamHistoryRows(bounds, now, 'weekday', [sf6, tekken], [{ ...noDiagnostics, live, bundled }], [entry(sf6, [observation('60')])])
  assert.deepEqual(rows, [{
    scheduledAt, result: '欠測', successCount: 0, reasons: [{ label: '起動失敗（HTTP 500）' }],
    logs: [{ kind: '起動役', runId: '42', attempt: 1 }],
  }])
})

test('an unbound first-attempt observation fills an unknown game without attributing another run to its slot', () => {
  const live = day([
    { scheduledAt: `${date}T23:07:00.000Z`, games: [{ appId: tekken, status: 'unknown', runId: '52', attempt: 1 }] },
    { scheduledAt, games: [{ appId: sf6, status: 'pending' }, { appId: tekken, status: 'unknown' }] },
  ])
  const rows = buildSteamHistoryRows(bounds, now, 'all', [sf6, tekken], [{ ...noDiagnostics, live }], [
    entry(sf6, [observation('51')]), entry(tekken, [observation('52'), observation('53', 2)]),
  ])
  assert.equal(rows[0].result, '一部取得')
  assert.equal(rows[0].successCount, 1)
  assert.deepEqual(rows[0].reasons, [{ appId: tekken, label: '原因不明' }])
  assert.deepEqual(rows[0].logs, [{ kind: '取得', runId: '51', attempt: 1 }])
  const pending = day([{ scheduledAt, games: [{ appId: sf6, status: 'pending', runId: '51', attempt: 1 }] }])
  const updated = buildSteamHistoryRows(bounds, now, 'all', [sf6], [{ ...noDiagnostics, live: pending }], [entry(sf6, [observation('51')])])
  assert.equal(updated[0].result, '取得済み')
})

test('read failure and grace do not become confirmed gaps', () => {
  assert.equal(buildSteamHistoryRows(bounds, now, 'all', [sf6], [noDiagnostics], [entry(sf6)])[0].result, '欠測')
  assert.equal(buildSteamHistoryRows(bounds, now, 'all', [sf6], [{ ...noDiagnostics, failed: true }], [entry(sf6)])[0].result, '確認中')
  assert.equal(buildSteamHistoryRows(bounds, new Date(time + 15 * 60_000), 'all', [sf6], [noDiagnostics], [entry(sf6)])[0].result, '確認中')
  assert.deepEqual(buildSteamHistoryRows(bounds, now, 'all', [sf6], [noDiagnostics], []), [])
})

test('404 uses the bundled verified day and does not request diagnostics before rollout', async context => {
  const bundledBase = 'https://example.test/data/'
  const archived = day([{ scheduledAt, games: [], dispatch: { runId: '42', attempt: 1, reason: 'failed', httpStatus: 500 } }])
  const requested: string[] = []
  context.mock.method(globalThis, 'fetch', async (url: string) => {
    requested.push(url)
    return url.startsWith(bundledBase) ? Response.json(archived) : new Response(null, { status: 404 })
  })
  const dates = ['2026-11-01', date]
  const reads = await readSteamHistoryDays(dates, bundledBase, new AbortController().signal, new Map())
  assert.deepEqual(requested.sort(), [`${STEAM_COLLECTION_HISTORY_BASE_URL}days/${date}.json`, `${bundledBase}days/${date}.json`].sort())
  assert.deepEqual(reads, [{ date: dates[0], live: null, bundled: null, failed: false }, { ...noDiagnostics, bundled: archived }])
})
