import assert from 'node:assert/strict'
import test from 'node:test'
import { readSteamCollectionEvidence } from './steam-collection-history-evidence.ts'
import { STEAM_PLAYER_COUNT_GAMES } from '../../src/lib/steamPlayerCountGames.ts'

test('reconciliation reads a dispatcher that started the previous day and collects only approved evidence', async () => {
  const now = new Date('2026-11-07T01:00:00.123Z')
  const dispatcher = { databaseId: 100, attempt: 2, displayTitle: 'Steam cadence standard', headBranch: 'main',
    createdAt: '2026-11-06T00:00:00Z', updatedAt: '2026-11-06T06:00:00Z', status: 'completed', conclusion: 'failure' }
  const collector = { ...dispatcher, databaseId: 200, attempt: 3,
    displayTitle: 'Steam observation 2026-11-06T02:22:00.000Z', createdAt: '2026-11-06T02:22:01Z' }
  const results = STEAM_PLAYER_COUNT_GAMES.map(({ appId }, index) => index === 0
    ? { appId, status: 'succeeded', observedAt: '2026-11-06T02:22:03.500Z', playerCount: 100 }
    : { appId, status: 'failed', errorCode: 'backoff' })
  const logLine = (job: string, value: unknown) => `${job}\tUNKNOWN STEP\t2026-11-06T02:22:08.0000000Z ${JSON.stringify(value)}`
  const evidence = await readSteamCollectionEvidence(now, async args => {
    if (args[1] === 'list') {
      if (args.includes('steam-player-count-dispatch.yml')) {
        assert.ok(!args.includes('--created'))
        return JSON.stringify([dispatcher])
      }
      assert.ok(args.includes('>=2026-11-06T01:00:00Z'))
      return JSON.stringify([collector,
        { ...collector, databaseId: 201, displayTitle: 'Steam observation manual' },
        { ...collector, databaseId: 202, displayTitle: 'Steam observation 2026-11-06T02:23:00.000Z' },
      ])
    }
    if (args.includes('100')) {
      assert.ok(args.includes('--attempt') && args.includes('2'))
      return [
        logLine('dispatch', { event: 'slot-failed', scheduledAt: '2026-11-06T01:22:00.000Z',
          runId: '999', stage: 'collection-dispatch', httpStatus: 500, unexpected: 'private' }),
        logLine('dispatch', { event: 'slot-skipped', scheduledAt: '2026-11-06T01:37:00.000Z', reason: 'current-slot' }),
        logLine('dispatch', { event: 'slot-failed', scheduledAt: '2026-11-06T00:52:00.000Z' }),
      ].join('\n')
    }
    if (args[0] === 'api') return JSON.stringify({ total_count: 2, jobs: [
      { id: 300, run_id: 200, name: 'collect', conclusion: 'failure' },
      { id: 301, run_id: 200, name: 'save-history', conclusion: 'failure' },
    ] })
    assert.ok(args.includes('--job') && args.includes('300'))
    return logLine('collect', { successfulGames: 1, results })
  })
  assert.deepEqual(evidence.dispatch, [{ scheduledAt: '2026-11-06T01:22:00.000Z',
    runId: '100', attempt: 2, reason: 'failed', httpStatus: 500 }])
  assert.equal(evidence.collections.length, 1)
  assert.equal(evidence.collections[0].scheduledAt, '2026-11-06T02:22:00.000Z')
  assert.equal(evidence.collections[0].collectFailed, true)
  assert.equal(evidence.collections[0].saveFailed, true)
  assert.deepEqual(evidence.collections[0].games, results.map(({ playerCount: _, ...game }) => game))
})

test('unavailable evidence logs preserve a run while an unavailable run list fails the reconciliation', async () => {
  const run = { databaseId: 100, attempt: 1, displayTitle: 'Collect Steam player count', headBranch: 'main',
    createdAt: '2026-11-06T01:22:00Z', updatedAt: '2026-11-06T02:00:00Z', status: 'completed', conclusion: 'failure' }
  const now = new Date('2026-11-06T03:00:00Z')
  const evidence = await readSteamCollectionEvidence(now, async args => {
    if (args[1] === 'list') return JSON.stringify(args.includes('steam-player-count.yml') ? [run] : [])
    throw new Error('unavailable job metadata')
  })
  assert.deepEqual(evidence, { dispatch: [], collections: [{ runId: '100', attempt: 1,
    createdAt: '2026-11-06T01:22:00.000Z', completed: true, saveFailed: false, collectFailed: false, games: [] }] })
  await assert.rejects(readSteamCollectionEvidence(now, async () => { throw new Error('unavailable run list') }), /unavailable run list/)
})
