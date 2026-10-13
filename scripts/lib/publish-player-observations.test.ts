import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { PLAYER_OBSERVATION_CONDITIONS, PLAYER_OBSERVATION_SOURCE } from '../../src/lib/playerObservations.ts'
import { publishPlayerObservationDataset, publishPlayerObservations } from '../publish-player-observations.ts'
import { validatePlayerObservationDirectory } from '../validate-player-observation-data.ts'
import { TEST_GENERATED_AT, testDirectory } from './player-observation-test-fixtures.ts'

function dataset() {
  return { schemaVersion: 1, definitionVersion: 1, seriesId: 'buckler-max-lp-v1', generatedAt: TEST_GENERATED_AT,
    source: structuredClone(PLAYER_OBSERVATION_SOURCE), conditions: { ...PLAYER_OBSERVATION_CONDITIONS },
    baseline: { status: 'preparing', completedAt: null }, runs: [] }
}

test('publishes only aggregate index JSON and rejects raw IDs before changing healthy output', async (t) => {
  const root = await testDirectory(t), directory = join(root, 'public')
  assert.deepEqual(await publishPlayerObservationDataset(dataset(), directory), { runs: 0 })
  assert.deepEqual(await validatePlayerObservationDirectory(directory), { runs: 0 })
  const before = await fs.readFile(join(directory, 'index.json'), 'utf8')
  const privateInput = { ...dataset(), firstSeenIds: ['9000000001'] }
  await assert.rejects(publishPlayerObservationDataset(privateInput, directory), /unknown field/)
  assert.equal(await fs.readFile(join(directory, 'index.json'), 'utf8'), before)
  assert.deepEqual(await fs.readdir(directory), ['index.json'])
})

test('rollback restores the previous publication when installation fails', async (t) => {
  const root = await testDirectory(t), directory = join(root, 'public'), work = join(root, 'work')
  await publishPlayerObservationDataset(dataset(), directory, work)
  const before = await fs.readFile(join(directory, 'index.json'), 'utf8')
  const rename = fs.rename
  t.mock.method(fs, 'rename', async (from, to) => {
    if (from === join(work, 'stage') && to === directory) throw new Error('injected install failure')
    return rename(from, to)
  })
  await assert.rejects(publishPlayerObservationDataset({ ...dataset(), generatedAt: '2026-10-13T00:00:00Z' }, directory, work), /injected install failure/)
  assert.equal(await fs.readFile(join(directory, 'index.json'), 'utf8'), before)
  await assert.rejects(fs.stat(work), { code: 'ENOENT' })
})

test('recovers an interrupted swap before publishing again', async (t) => {
  const root = await testDirectory(t), directory = join(root, 'public'), work = join(root, 'work')
  await publishPlayerObservationDataset(dataset(), directory, work)
  await fs.mkdir(work)
  await fs.rename(directory, join(work, 'backup'))
  await fs.mkdir(join(work, 'stage'))
  await fs.writeFile(join(work, 'stage', 'index.json'), '{}')
  await fs.writeFile(join(work, 'journal.json'), JSON.stringify({ version: 1, directory: resolve(directory), hadOriginal: true, phase: 'prepared' }))
  await fs.writeFile(join(work, 'lock'), JSON.stringify({ pid: 2147483647, token: 'interrupted' }))
  await publishPlayerObservationDataset(dataset(), directory, work)
  assert.deepEqual(await validatePlayerObservationDirectory(directory), { runs: 0 })
  await assert.rejects(fs.stat(work), { code: 'ENOENT' })
})

test('live publication lock and missing source history do not fabricate or overwrite data', async (t) => {
  const root = await testDirectory(t), directory = join(root, 'public'), work = join(root, 'work')
  await fs.mkdir(work)
  await fs.writeFile(join(work, 'lock'), JSON.stringify({ pid: process.pid, token: 'active' }))
  await assert.rejects(publishPlayerObservationDataset(dataset(), directory, work), /実行中/)
  await assert.rejects(fs.stat(directory), { code: 'ENOENT' })
  const missing = join(root, 'missing.sqlite')
  await assert.rejects(publishPlayerObservations(missing, directory), { code: 'ENOENT' })
  await assert.rejects(fs.stat(missing), { code: 'ENOENT' })
})

test('private database inside publication output or recovery directories is rejected before cleanup', async (t) => {
  const root = await testDirectory(t), directory = join(root, 'public')
  for (const database of [join(directory, 'history.sqlite'), join(root, '.public-publication', 'stage', 'history.sqlite')]) {
    await fs.mkdir(resolve(database, '..'), { recursive: true })
    await fs.writeFile(database, 'private history must survive')
    await assert.rejects(publishPlayerObservations(database, directory), /互いに含まれない/)
    assert.equal(await fs.readFile(database, 'utf8'), 'private history must survive')
  }
})
