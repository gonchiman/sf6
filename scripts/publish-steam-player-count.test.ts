import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile, symlink, mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { publishSteamPlayerCount, seedSteamPlayerCountHistory, replaceSteamPlayerCountFile } from './publish-steam-player-count.ts'
import { steamSha256 } from './lib/steam-player-count-files.ts'

function observation(id = 'a', observedAt = '2026-10-31T10:07:12.000Z', playerCount = 10) {
  return { id, requestStartedAt: observedAt, observedAt, playerCount, runId: null, runAttempt: null }
}
const generatedAt = '2026-11-02T00:00:00.000Z'
async function fixture(t: TestContext) {
  // Keep publication fixtures within the already-writable project workspace.
  const temporary = resolve('.local/steam-player-count-tests')
  await mkdir(temporary, { recursive: true })
  const root = await mkdtemp(join(temporary, 'publish-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const input = join(root, 'observation.json'), output = join(root, 'public')
  return { root, input, output, save: async (value: unknown) => writeFile(input, JSON.stringify(value)),
    publish: () => publishSteamPlayerCount(input, output, generatedAt),
    manifest: async () => JSON.parse(await readFile(join(output, 'index.json'), 'utf8')),
    day: async (date: string) => JSON.parse(await readFile(join(output, 'days', `${date}.json`), 'utf8')) }
}

test('publishes validated UTC day shards with hashes and accepts late arrival without losing observations', async t => {
  const f = await fixture(t)
  await f.save(observation('late', '2026-11-01T00:00:00.000Z', 0))
  assert.deepEqual(await f.publish(), { changed: true, observations: 1, days: 1 })
  await f.save(observation('earlier'))
  assert.deepEqual(await f.publish(), { changed: true, observations: 2, days: 2 })
  await f.save(observation('middle', '2026-10-31T10:22:12.000Z', 20))
  assert.deepEqual(await f.publish(), { changed: true, observations: 3, days: 2 })
  const manifest = await f.manifest()
  assert.deepEqual(manifest.days.map((item: { date: string }) => item.date), ['2026-10-31', '2026-11-01'])
  for (const item of manifest.days) assert.equal(item.sha256, steamSha256(await readFile(join(f.output, item.path))))
  assert.deepEqual((await f.day('2026-10-31')).observations.map((item: { id: string }) => item.id), ['earlier', 'middle'])
  assert.equal((await f.day('2026-11-01')).observations[0].playerCount, 0)
})

test('replaying identical input is byte-for-byte idempotent even with a different publication clock', async t => {
  const f = await fixture(t)
  await f.save(observation())
  await f.publish()
  const before = await readFile(join(f.output, 'index.json'), 'utf8')
  assert.deepEqual(await publishSteamPlayerCount(f.input, f.output, '2026-11-03T00:00:00.000Z'), { changed: false, observations: 1, days: 1 })
  assert.equal(await readFile(join(f.output, 'index.json'), 'utf8'), before)
})

test('rejects changed identity across days or changed identity for a workflow attempt, retaining history', async t => {
  const f = await fixture(t)
  const initial = { ...observation(), runId: '123', runAttempt: 1 }
  await f.save(initial)
  await f.publish()
  const before = await readFile(join(f.output, 'index.json'), 'utf8')
  for (const conflict of [{ ...initial, playerCount: 11 }, { ...initial, observedAt: '2026-11-01T00:00:00.000Z' }, { ...initial, id: 'different' }]) {
    await f.save(conflict)
    await assert.rejects(f.publish(), /同じID/)
    assert.equal(await readFile(join(f.output, 'index.json'), 'utf8'), before)
  }
  assert.deepEqual(await readdir(f.root), ['observation.json', 'public'])
})

test('rejects corrupted, unlisted or unsafe history without publishing over it', async t => {
  const f = await fixture(t)
  await f.save(observation()); await f.publish()
  await f.save(observation('new'))
  const path = join(f.output, 'days/2026-10-31.json'), before = await readFile(path, 'utf8')
  await writeFile(path, before.replace('"playerCount": 10', '"playerCount": 99'))
  await assert.rejects(f.publish(), /ハッシュ/)
  await writeFile(path, before)
  await writeFile(join(f.output, 'unexpected.txt'), 'not a data shard')
  await assert.rejects(f.publish(), /未許可/)
})

test('rejects symlinked input/output and future observation before writing history', async t => {
  const f = await fixture(t)
  await f.save(observation('future', '2026-11-03T00:00:00.000Z'))
  await assert.rejects(f.publish(), /生成日時/)
  await f.save(observation())
  const outside = join(f.root, 'outside'), redirected = join(f.root, 'redirected')
  await mkdir(outside)
  try { await symlink(outside, redirected, 'junction') }
  catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'EPERM') return; throw error }
  await assert.rejects(publishSteamPlayerCount(f.input, join(redirected, 'public'), generatedAt), /保存先/)
  assert.deepEqual(await readdir(outside), [])
})

test('publication lock rejects overlapping local writes instead of dropping either input', async t => {
  const f = await fixture(t)
  await f.save(observation())
  await writeFile(join(f.root, '.public-steam.lock'), 'another publisher')
  await assert.rejects(f.publish())
  assert.equal(await readFile(f.input, 'utf8'), JSON.stringify(observation()))
})

test('failed index publication restores the affected shard or removes a new shard, then replay succeeds', async t => {
  const f = await fixture(t)
  const failIndex = async (from: string, to: string) => {
    if (to.endsWith('index.json')) throw new Error('injected index write failure')
    await replaceSteamPlayerCountFile(from, to)
  }
  await f.save(observation())
  await assert.rejects(publishSteamPlayerCount(f.input, f.output, generatedAt, { replace: failIndex }), /injected/)
  assert.deepEqual(await readdir(f.root), ['observation.json'])
  await f.publish()
  const beforeIndex = await readFile(join(f.output, 'index.json'), 'utf8')
  const beforeDay = await readFile(join(f.output, 'days/2026-10-31.json'), 'utf8')
  for (const next of [observation('same-day', '2026-10-31T11:07:12.000Z'), observation('next-day', '2026-11-01T00:00:00.000Z')]) {
    await f.save(next)
    await assert.rejects(publishSteamPlayerCount(f.input, f.output, generatedAt, { replace: failIndex }), /injected/)
    assert.equal(await readFile(join(f.output, 'index.json'), 'utf8'), beforeIndex)
    assert.equal(await readFile(join(f.output, 'days/2026-10-31.json'), 'utf8'), beforeDay)
    assert.deepEqual(await readdir(join(f.output, 'days')), ['2026-10-31.json'])
  }
  assert.deepEqual(await f.publish(), { changed: true, observations: 2, days: 2 })
})

test('rollback failure preserves the recovery backup and lock instead of erasing evidence', async t => {
  const f = await fixture(t)
  await f.save(observation()); await f.publish()
  const before = await readFile(join(f.output, 'days/2026-10-31.json'), 'utf8')
  await f.save(observation('second'))
  let replacements = 0
  await assert.rejects(publishSteamPlayerCount(f.input, f.output, generatedAt, { replace: async (from, to) => {
    if (++replacements > 1) throw new Error('injected filesystem failure')
    await replaceSteamPlayerCountFile(from, to)
  } }), /復旧/)
  const files = await readdir(f.root)
  assert.ok(files.includes('.public-steam.lock'))
  const recovery = files.find(name => name.startsWith('.steam-publication-'))!
  assert.equal(await readFile(join(f.root, recovery, 'previous-day.json'), 'utf8'), before)
  await assert.rejects(f.publish())
})

test('new history preserves the validated bundled first sample before merging new observations', async t => {
  const f = await fixture(t)
  await f.save(observation('bundled')); await f.publish()
  const history = join(f.root, 'history/public')
  await seedSteamPlayerCountHistory(f.output, history)
  assert.equal(await readFile(join(history, 'index.json'), 'utf8'), await readFile(join(f.output, 'index.json'), 'utf8'))
  await f.save(observation('new', '2026-10-31T10:22:12.000Z'))
  await publishSteamPlayerCount(f.input, history, generatedAt)
  const day = JSON.parse(await readFile(join(history, 'days/2026-10-31.json'), 'utf8'))
  assert.deepEqual(day.observations.map((item: { id: string }) => item.id), ['bundled', 'new'])
  await assert.rejects(seedSteamPlayerCountHistory(f.output, history), /既存/)
})

test('bootstrap rejects a bundled hash mismatch before creating the new history', async t => {
  const f = await fixture(t)
  await f.save(observation()); await f.publish()
  await writeFile(join(f.output, 'days/2026-10-31.json'), '{}')
  await assert.rejects(seedSteamPlayerCountHistory(f.output, join(f.root, 'history/public')), /ハッシュ/)
  assert.ok(!(await readdir(f.root)).includes('history'))
})
