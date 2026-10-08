import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { join, resolve } from 'node:path'
import test from 'node:test'
import type { WinRateDataset } from '../../src/types/winRates.ts'
import { validateWinRateDirectory } from '../validate-win-rate-data.ts'
import { publishWinRateBatch } from './publish-win-rates.ts'

const generatedAt = '2026-10-08T00:00:00.000Z'
const source = { url: 'https://www.streetfighter.com/6/buckler/ja-jp/stats/dia', title: 'Buckler 対戦ダイアグラム' }
const leagues = ['ROOKIE', 'IRON', 'BRONZE', 'SILVER', 'GOLD', 'PLATINUM', 'DIAMOND', 'MASTER']

function batch(month = '2026-08', text = '5.000'): WinRateDataset[] {
  return leagues.flatMap((league) => (['combined', 'separate'] as const).map((operationMode) => {
    const fighters = operationMode === 'combined'
      ? [{ id: 'ryu', characterId: 'ryu', name: 'RYU', controlType: null }, { id: 'ken', characterId: 'ken', name: 'KEN', controlType: null }]
      : [{ id: 'ryu-c', characterId: 'ryu', name: 'RYU', controlType: 'classic' as const }, { id: 'ryu-m', characterId: 'ryu', name: 'RYU', controlType: 'modern' as const }]
    return {
      schemaVersion: 1, id: `${month}-${league.toLowerCase()}-${operationMode}`, month, league, operationMode,
      capturedAt: generatedAt, generatedAt,
      source: { ...source, population: 'ランクマッチ', metric: '公式表示値', notes: [] }, fighters,
      rows: fighters.map((fighter) => ({
        fighterId: fighter.id, total: { text, lowSample: false },
        cells: fighters.map(() => ({ text, lowSample: false })),
      })),
    }
  }))
}

function masterBatch(month = '2026-08', text = '5.000'): WinRateDataset[] {
  const template = batch(month, text).find((dataset) => dataset.operationMode === 'combined')!
  return ['MASTER', 'HIGH_MASTER', 'GRAND_MASTER', 'ULTIMATE_MASTER'].map((league) => ({
    ...structuredClone(template), edition: 'master', league,
    id: `${month}-master-edition-${league.toLowerCase()}-combined`,
    source: { ...template.source, url: `${source.url}_master`, title: 'Buckler マスター版 対戦ダイアグラム' },
  }))
}

async function fixture(t: test.TestContext) {
  const temporaryRoot = resolve('.cache', 'publication-tests')
  await fs.mkdir(temporaryRoot, { recursive: true })
  const root = await fs.mkdtemp(join(temporaryRoot, 'sf6-publication-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  return { root, directory: join(root, 'public'), transactionDirectory: join(root, 'work'), generatedAt }
}

async function snapshot(directory: string): Promise<Record<string, string>> {
  return Object.fromEntries(await Promise.all((await fs.readdir(directory)).sort().map(async (name) => [name, await fs.readFile(join(directory, name), 'utf8')])))
}

test('publishes a complete batch into an absent or empty directory', async (t) => {
  for (const empty of [false, true]) {
    const options = await fixture(t)
    if (empty) await fs.mkdir(options.directory)
    assert.deepEqual(await publishWinRateBatch({ ...options, datasets: batch(), months: ['2026-08'] }), { datasets: 16, cells: 96 })
    assert.deepEqual(await validateWinRateDirectory(options.directory), { datasets: 16, cells: 96 })
    await assert.rejects(fs.stat(options.transactionDirectory), { code: 'ENOENT' })
  }
})

test('replaces only selected months and preserves the other month files byte for byte', async (t) => {
  const options = await fixture(t)
  await publishWinRateBatch({ ...options, datasets: [...batch('2026-07'), ...batch()], months: ['2026-07', '2026-08'] })
  const before = await snapshot(options.directory)
  const changed = batch('2026-08', '5.058')
  changed.forEach((dataset) => { dataset.capturedAt = '2026-10-08T01:00:00.000Z' })
  assert.deepEqual(await publishWinRateBatch({ ...options, datasets: changed, months: ['2026-08'] }), { datasets: 32, cells: 192 })
  const after = await snapshot(options.directory)
  for (const path of Object.keys(before).filter((name) => name.startsWith('2026-07-'))) assert.equal(after[path], before[path])
  assert.equal(JSON.parse(after['2026-08-master-combined.json']).rows[0].total.text, '5.058')
  const manifest = JSON.parse(after['index.json'])
  assert.equal(manifest.datasets.find((item: { id: string }) => item.id === '2026-08-master-combined').capturedAt, changed[0].capturedAt)
})

test('同月の別版をbyte単位で保持し、総合版とマスター版を相互に更新できる', async (t) => {
  const options = await fixture(t)
  await publishWinRateBatch({ ...options, datasets: batch(), months: ['2026-08'] })
  const generalBefore = await snapshot(options.directory)
  await publishWinRateBatch({ ...options, edition: 'master', datasets: [...masterBatch('2026-07'), ...masterBatch()], months: ['2026-07', '2026-08'] })
  const both = await snapshot(options.directory)
  for (const path of Object.keys(generalBefore).filter((path) => path !== 'index.json')) assert.equal(both[path], generalBefore[path])
  const result = await publishWinRateBatch({ ...options, datasets: batch('2026-08', '6.000'), months: ['2026-08'] })
  assert.equal(result.datasets, 24)
  const generalUpdated = await snapshot(options.directory)
  for (const path of Object.keys(both).filter((path) => path.includes('-master-edition-'))) assert.equal(generalUpdated[path], both[path])
  await publishWinRateBatch({ ...options, edition: 'master', datasets: masterBatch('2026-08', '4.000'), months: ['2026-08'] })
  const masterUpdated = await snapshot(options.directory)
  for (const path of Object.keys(generalUpdated).filter((path) => path !== 'index.json' && (!path.includes('-master-edition-') || path.startsWith('2026-07-')))) {
    assert.equal(masterUpdated[path], generalUpdated[path])
  }
  const manifest = JSON.parse(masterUpdated['index.json'])
  assert.equal(manifest.datasets.filter((item: { edition?: string }) => item.edition === 'master').length, 8)
  assert.equal(manifest.source.url, source.url)
  assert.equal(JSON.parse(masterUpdated['2026-08-master-edition-master-combined.json']).rows[0].total.text, '4.000')
})

test('マスター版だけの初回公開と4条件不足・別版混入の拒否', async (t) => {
  const options = await fixture(t)
  assert.deepEqual(await publishWinRateBatch({ ...options, edition: 'master', datasets: masterBatch(), months: ['2026-08'] }), { datasets: 4, cells: 24 })
  const before = await snapshot(options.directory)
  assert.equal(JSON.parse(before['index.json']).source.url, source.url)
  const mixed = masterBatch()
  mixed[0] = batch().find((dataset) => dataset.league === 'MASTER' && dataset.operationMode === 'combined')!
  for (const datasets of [masterBatch().slice(1), [...masterBatch(), masterBatch()[0]], mixed]) {
    await assert.rejects(publishWinRateBatch({ ...options, edition: 'master', datasets, months: ['2026-08'] }))
    assert.deepEqual(await snapshot(options.directory), before)
  }
  await assert.rejects(publishWinRateBatch({ ...options, datasets: masterBatch(), months: ['2026-08'] }))
  await assert.rejects(publishWinRateBatch({ ...options, edition: 'master', datasets: masterBatch('2025-01'), months: ['2025-01'] }), /公開開始前/)
  assert.deepEqual(await snapshot(options.directory), before)
})

test('rejects missing, duplicate, extra-month and invalid records without altering existing data', async (t) => {
  const options = await fixture(t)
  await publishWinRateBatch({ ...options, datasets: batch(), months: ['2026-08'] })
  const before = await snapshot(options.directory)
  const invalid = batch()
  invalid[0].rows[0].cells.pop()
  const unknownLeague = batch()
  unknownLeague[0].league = 'LEGEND'
  const cases = [batch().slice(1), [...batch(), batch()[0]], batch('2026-07'), invalid, unknownLeague]
  for (const datasets of cases) {
    await assert.rejects(publishWinRateBatch({ ...options, datasets, months: ['2026-08'] }))
    assert.deepEqual(await snapshot(options.directory), before)
  }
  await assert.rejects(publishWinRateBatch({ ...options, datasets: batch(), months: ['2026-08', '2026-09'] }), /16条件/)
  await assert.rejects(publishWinRateBatch({ ...options, datasets: batch(), months: ['2026-08', '2026-08'] }), /対象月/)
  await assert.rejects(publishWinRateBatch({ ...options, datasets: batch(), months: ['2026-08'], generatedAt: 'invalid' }), /generatedAt/)
  assert.deepEqual(await snapshot(options.directory), before)
})

test('validates the entire staged directory before replacing a healthy directory', async (t) => {
  const options = await fixture(t)
  await publishWinRateBatch({ ...options, datasets: batch(), months: ['2026-08'] })
  const before = await snapshot(options.directory)
  const mismatchedSource = batch('2026-09')
  mismatchedSource[0].source.url = 'https://www.streetfighter.com/6/buckler/en/stats/dia'
  await assert.rejects(publishWinRateBatch({ ...options, datasets: mismatchedSource, months: ['2026-09'] }), /出典URL/)
  assert.deepEqual(await snapshot(options.directory), before)
  await assert.rejects(fs.stat(options.transactionDirectory), { code: 'ENOENT' })
})

test('does not replace an invalid existing directory', async (t) => {
  const options = await fixture(t)
  await fs.mkdir(options.directory)
  await fs.writeFile(join(options.directory, 'unregistered.json'), '{"keep":true}\n')
  const before = await snapshot(options.directory)
  await assert.rejects(publishWinRateBatch({ ...options, datasets: batch(), months: ['2026-08'] }))
  assert.deepEqual(await snapshot(options.directory), before)
})

test('rolls back when installation fails after the original directory was backed up', async (t) => {
  const options = await fixture(t)
  await publishWinRateBatch({ ...options, datasets: batch(), months: ['2026-08'] })
  const before = await snapshot(options.directory)
  const rename = fs.rename
  let failed = false
  t.mock.method(fs, 'rename', async (from, to) => {
    if (!failed && from === join(options.transactionDirectory, 'stage') && to === options.directory) {
      failed = true
      throw new Error('injected install failure')
    }
    return rename(from, to)
  })
  await assert.rejects(publishWinRateBatch({ ...options, datasets: batch('2026-08', '5.058'), months: ['2026-08'] }), /injected install failure/)
  assert.equal(failed, true)
  assert.deepEqual(await snapshot(options.directory), before)
  await assert.rejects(fs.stat(options.transactionDirectory), { code: 'ENOENT' })
})

test('recovers an interrupted swap and keeps its existing months during the next publication', async (t) => {
  const options = await fixture(t)
  await publishWinRateBatch({ ...options, datasets: batch('2026-07'), months: ['2026-07'] })
  const before = await snapshot(options.directory)
  await fs.mkdir(options.transactionDirectory)
  await fs.rename(options.directory, join(options.transactionDirectory, 'backup'))
  await fs.mkdir(join(options.transactionDirectory, 'stage'))
  await fs.writeFile(join(options.transactionDirectory, 'stage', 'partial.json'), '{}')
  await fs.writeFile(join(options.transactionDirectory, 'journal.json'), JSON.stringify({ version: 1, directory: resolve(options.directory), phase: 'prepared', hadOriginal: true }))
  await fs.writeFile(join(options.transactionDirectory, 'lock'), JSON.stringify({ pid: 2147483647, token: 'interrupted' }))
  assert.deepEqual(await publishWinRateBatch({ ...options, datasets: batch(), months: ['2026-08'] }), { datasets: 32, cells: 192 })
  const after = await snapshot(options.directory)
  for (const path of Object.keys(before).filter((name) => name !== 'index.json')) assert.equal(after[path], before[path])
  await assert.rejects(fs.stat(options.transactionDirectory), { code: 'ENOENT' })
})

test('rejects a live lock without touching the in-progress transaction', async (t) => {
  const options = await fixture(t)
  await fs.mkdir(options.transactionDirectory)
  const lock = JSON.stringify({ pid: process.pid, token: 'active' })
  await fs.writeFile(join(options.transactionDirectory, 'lock'), lock)
  await fs.mkdir(join(options.transactionDirectory, 'stage'))
  await fs.writeFile(join(options.transactionDirectory, 'stage', 'in-progress'), 'keep')
  await assert.rejects(publishWinRateBatch({ ...options, datasets: batch(), months: ['2026-08'] }), /実行中/)
  assert.equal(await fs.readFile(join(options.transactionDirectory, 'lock'), 'utf8'), lock)
  assert.equal(await fs.readFile(join(options.transactionDirectory, 'stage', 'in-progress'), 'utf8'), 'keep')
  await assert.rejects(fs.stat(options.directory), { code: 'ENOENT' })
})

test('does not delete a new live lock installed after a stale owner was observed', async (t) => {
  const options = await fixture(t)
  await fs.mkdir(options.transactionDirectory)
  const lockPath = join(options.transactionDirectory, 'lock')
  const reclaimPath = join(options.transactionDirectory, 'reclaim')
  await fs.writeFile(lockPath, JSON.stringify({ pid: 2147483647, token: 'stale' }))
  const replacement = JSON.stringify({ pid: process.pid, token: 'other-contender' })
  const mkdir = fs.mkdir
  let replaced = false
  t.mock.method(fs, 'mkdir', async (path, ...rest) => {
    const result = await mkdir(path, ...rest)
    if (path === reclaimPath) {
      replaced = true
      await fs.writeFile(lockPath, replacement)
    }
    return result
  })
  await assert.rejects(publishWinRateBatch({ ...options, datasets: batch(), months: ['2026-08'] }), /実行中/)
  assert.equal(replaced, true)
  assert.equal(await fs.readFile(lockPath, 'utf8'), replacement)
  await assert.rejects(fs.stat(reclaimPath), { code: 'ENOENT' })
  await assert.rejects(fs.stat(options.directory), { code: 'ENOENT' })
})

test('preserves an existing reclaim directory and refuses to guess whether it is stale', async (t) => {
  for (const hasLock of [false, true]) {
    const options = await fixture(t)
    const reclaimPath = join(options.transactionDirectory, 'reclaim')
    await fs.mkdir(reclaimPath, { recursive: true })
    await fs.writeFile(join(reclaimPath, 'marker'), 'keep')
    const lockPath = join(options.transactionDirectory, 'lock')
    const lock = JSON.stringify({ pid: 2147483647, token: 'stale' })
    if (hasLock) await fs.writeFile(lockPath, lock)
    await assert.rejects(publishWinRateBatch({ ...options, datasets: batch(), months: ['2026-08'] }), /復旧処理/)
    assert.equal(await fs.readFile(join(reclaimPath, 'marker'), 'utf8'), 'keep')
    if (hasLock) assert.equal(await fs.readFile(lockPath, 'utf8'), lock)
    else await assert.rejects(fs.stat(lockPath), { code: 'ENOENT' })
    await assert.rejects(fs.stat(options.directory), { code: 'ENOENT' })
  }
})

test('rejects overlapping paths, traversal IDs, and output reported as a symbolic link', async (t) => {
  const options = await fixture(t)
  for (const transactionDirectory of [options.directory, join(options.directory, 'work'), options.root]) {
    await assert.rejects(publishWinRateBatch({ ...options, transactionDirectory, datasets: batch(), months: ['2026-08'] }), /互いに含まれない/)
  }
  const invalid = batch()
  invalid[0].id = '../outside'
  await assert.rejects(publishWinRateBatch({ ...options, datasets: invalid, months: ['2026-08'] }), /id/)
  await fs.mkdir(options.directory)
  await fs.writeFile(join(options.directory, 'marker'), 'keep')
  const lstat = fs.lstat
  t.mock.method(fs, 'lstat', async (path, ...rest) => {
    const stat = await lstat(path, ...rest)
    return path === options.directory ? Object.create(stat, { isSymbolicLink: { value: () => true } }) : stat
  })
  await assert.rejects(publishWinRateBatch({ ...options, datasets: batch(), months: ['2026-08'] }), /保存先/)
  assert.equal(await fs.readFile(join(options.directory, 'marker'), 'utf8'), 'keep')
})

test('retains recovery files if rollback fails, then recovers on the next run', async (t) => {
  const options = await fixture(t)
  await publishWinRateBatch({ ...options, datasets: batch('2026-07'), months: ['2026-07'] })
  const before = await snapshot(options.directory)
  const rename = fs.rename
  const mockedRename = t.mock.method(fs, 'rename', async (from, to) => {
    if (to === options.directory) throw new Error('injected directory lock')
    return rename(from, to)
  })
  await assert.rejects(publishWinRateBatch({ ...options, datasets: batch(), months: ['2026-08'] }), /復旧用のファイルを保持/)
  assert.deepEqual(await snapshot(join(options.transactionDirectory, 'backup')), before)
  await fs.stat(join(options.transactionDirectory, 'journal.json'))
  mockedRename.mock.restore()
  assert.deepEqual(await publishWinRateBatch({ ...options, datasets: batch(), months: ['2026-08'] }), { datasets: 32, cells: 192 })
  const after = await snapshot(options.directory)
  for (const path of Object.keys(before).filter((name) => name !== 'index.json')) assert.equal(after[path], before[path])
})

test('rolls back even after installation when the commit record cannot be written', async (t) => {
  const options = await fixture(t)
  await publishWinRateBatch({ ...options, datasets: batch(), months: ['2026-08'] })
  const before = await snapshot(options.directory)
  const rename = fs.rename
  let journalWrites = 0
  t.mock.method(fs, 'rename', async (from, to) => {
    if (to === join(options.transactionDirectory, 'journal.json') && ++journalWrites === 2) throw new Error('injected commit failure')
    return rename(from, to)
  })
  await assert.rejects(publishWinRateBatch({ ...options, datasets: batch('2026-08', '5.058'), months: ['2026-08'] }), /injected commit failure/)
  assert.deepEqual(await snapshot(options.directory), before)
  await assert.rejects(fs.stat(options.transactionDirectory), { code: 'ENOENT' })
})

test('a cleanup failure after commit keeps the valid new data and is cleaned on the next run', async (t) => {
  const options = await fixture(t)
  await publishWinRateBatch({ ...options, datasets: batch(), months: ['2026-08'] })
  const rm = fs.rm
  const mockedRm = t.mock.method(fs, 'rm', async (path, ...rest) => {
    if (path === join(options.transactionDirectory, 'backup')) throw new Error('injected cleanup failure')
    return rm(path, ...rest)
  })
  const warning = t.mock.method(console, 'warn', () => {})
  assert.deepEqual(await publishWinRateBatch({ ...options, datasets: batch('2026-08', '5.058'), months: ['2026-08'] }), { datasets: 16, cells: 96 })
  assert.equal(warning.mock.callCount(), 1)
  assert.equal(JSON.parse(await fs.readFile(join(options.directory, '2026-08-master-combined.json'), 'utf8')).rows[0].total.text, '5.058')
  await fs.stat(join(options.transactionDirectory, 'journal.json'))
  mockedRm.mock.restore()
  await publishWinRateBatch({ ...options, datasets: batch('2026-09'), months: ['2026-09'] })
  assert.equal(JSON.parse(await fs.readFile(join(options.directory, '2026-08-master-combined.json'), 'utf8')).rows[0].total.text, '5.058')
  await assert.rejects(fs.stat(options.transactionDirectory), { code: 'ENOENT' })
})
