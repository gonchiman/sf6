import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { parseSteamCollectionHistoryDay } from '../src/lib/steamCollectionHistory.ts'
import { reconcileSteamCollectionDays } from './reconcile-steam-collection-history.ts'
import type { SteamCollectorEvidence } from './lib/steam-collection-history-evidence.ts'

const date = '2026-11-06'
const scheduledAt = `${date}T08:07:00.000Z`
const observedAt = `${date}T08:07:15.000Z`
const later = new Date(`${date}T08:44:00.000Z`)
const run: SteamCollectorEvidence = {
  runId: '12345', attempt: 1, scheduledAt, createdAt: `${date}T08:07:01.000Z`,
  completed: true, collectFailed: false, saveFailed: false, games: [],
}
const observation = {
  appId: 1364780 as const, id: 'steam-12345-1', runId: '12345', runAttempt: 1,
  requestStartedAt: observedAt, observedAt, playerCount: 0,
}
const findSlot = (days: ReturnType<typeof reconcileSteamCollectionDays>, slot = scheduledAt) =>
  days.find(day => day.date === slot.slice(0, 10))?.slots.find(row => row.scheduledAt === slot)

test('a verified published zero counts as a success and a partial failure keeps its reason', () => {
  const days = reconcileSteamCollectionDays(later, { dispatch: [], collections: [{
    ...run, collectFailed: true,
    games: [{ appId: 1364780, status: 'succeeded', observedAt }, { appId: 1778820, status: 'failed', errorCode: 'http' }],
  }] }, [observation], [])
  assert.deepEqual(findSlot(days)?.games.slice(0, 2).map(game => [game.status, game.errorCode]), [
    ['published', undefined], ['collect-failed', 'http'],
  ])
})

test('an explicit dispatch failure survives a replay, with unknown and pending kept distinct', () => {
  const dispatch = { runId: '9876', attempt: 1, reason: 'failed' as const, httpStatus: 500 }
  const evidence = { dispatch: [{ scheduledAt, ...dispatch }], collections: [] }
  const days = reconcileSteamCollectionDays(later, evidence, [], [])
  assert.deepEqual(findSlot(days)?.dispatch, dispatch)
  assert.equal(findSlot(days, `${date}T08:22:00.000Z`)?.games[0].status, 'unknown')
  assert.equal(findSlot(days, `${date}T08:37:00.000Z`)?.games[0].status, 'pending')
  assert.deepEqual(reconcileSteamCollectionDays(later, { dispatch: [], collections: [] }, [], days), days)
})

test('a saved retry resolves the publication failure without a duplicate row or loss of evidence', () => {
  const failed = reconcileSteamCollectionDays(later, { dispatch: [], collections: [{ ...run, saveFailed: true }] }, [], [])
  assert.equal(findSlot(failed)?.games[0].status, 'save-failed')
  const retry = reconcileSteamCollectionDays(later, { dispatch: [], collections: [{ ...run, attempt: 2 }] }, [observation], failed)
  assert.equal(findSlot(retry)?.games[0].status, 'published')
  assert.equal(findSlot(retry)?.games[0].attempt, 1)
  assert.equal(retry.flatMap(day => day.slots).filter(slot => slot.scheduledAt === scheduledAt).length, 1)
  const lostLog = reconcileSteamCollectionDays(later, { dispatch: [], collections: [] }, [], retry)
  assert.equal(findSlot(lostLog)?.games[0].status, 'published')
})

test('a late retry never fills the neighboring slot and a legacy failure stays unclassified', () => {
  const late = `${date}T08:22:03.000Z`
  const legacy = { ...run, scheduledAt: undefined, createdAt: `${date}T08:37:01.000Z`, collectFailed: true,
    games: [{ appId: 1364780, status: 'failed' as const, errorCode: 'network' }] }
  const days = reconcileSteamCollectionDays(later, { dispatch: [], collections: [legacy, {
    ...run, attempt: 2,
  }] }, [{ ...observation, observedAt: late, runAttempt: 2 }], [])
  assert.equal(findSlot(days)?.games[0].status, 'unknown')
  assert.equal(findSlot(days)?.games[0].observedAt, late)
  assert.equal(findSlot(days, `${date}T08:22:00.000Z`)?.games[0].status, 'unknown')
  assert.equal(findSlot(days, `${date}T08:37:00.000Z`)?.games[0].errorCode, undefined)
})

test('the historical HTTP 500 seed is valid and unsafe or duplicate records are rejected', async () => {
  const seed = JSON.parse(await readFile(new URL('../public/data/steam-collection-history/days/2026-11-05.json', import.meta.url), 'utf8'))
  const day = parseSteamCollectionHistoryDay(seed, '2026-11-05')
  assert.equal(day.slots[0].dispatch?.httpStatus, 500)
  assert.throws(() => parseSteamCollectionHistoryDay({ ...day, slots: [...day.slots, ...day.slots] }, day.date))
  assert.throws(() => parseSteamCollectionHistoryDay({ ...day, slots: [{ ...day.slots[0],
    dispatch: { ...day.slots[0].dispatch, runId: '../secret' } }] }, day.date))
})
