import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { join, resolve } from 'node:path'
import test from 'node:test'
import type { WinRateDataset } from '../../src/types/winRates.ts'
import { parseUpdateArguments, updateWinRates, type UpdateOptions } from './update-win-rates.ts'

const now = new Date('2026-10-08T00:00:00.000Z')
const capturedAt = '2026-10-01T00:00:00.000Z'
const leagues = ['ROOKIE', 'IRON', 'BRONZE', 'SILVER', 'GOLD', 'PLATINUM', 'DIAMOND', 'MASTER']
const fixtureDatasets: WinRateDataset[] = await Promise.all(['combined', 'separate'].map(async (mode) =>
  JSON.parse(await fs.readFile(new URL(`../../public/data/win-rates/2026-08-master-${mode}.json`, import.meta.url), 'utf8'))),
)

function monthSnapshot(month: string, totalText = '5.058') {
  // 保存済みの公式表から2キャラを選び、入力形式と行列の対応を維持したテスト用の小表にする。
  const characterIds = new Set(fixtureDatasets[0].fighters.slice(0, 2).map((fighter) => fighter.characterId))
  const snapshots = leagues.flatMap((league) => fixtureDatasets.map((dataset) => {
    const indexes = dataset.fighters.flatMap((fighter, index) => characterIds.has(fighter.characterId) ? [index] : [])
    const fighters = indexes.map((index) => dataset.fighters[index])
    return {
      snapshotVersion: 1, month, league, operationMode: dataset.operationMode, order: 'character',
      readyCharacterCount: fighters.length, sourceUrl: dataset.source.url, capturedAt,
      columns: fighters.map(({ characterId, controlType }) => ({ characterId, controlType })),
      rows: fighters.map((fighter) => {
        const row = dataset.rows.find((row) => row.fighterId === fighter.id)!
        return {
          characterId: fighter.characterId, name: fighter.name, controlType: fighter.controlType,
          total: { text: totalText, lowSample: false }, cells: indexes.map((index) => ({ ...row.cells[index] })),
        }
      }),
    }
  }))
  return { snapshotVersion: 1, month, snapshots }
}

function options(args: string[], cwd: string): UpdateOptions {
  const parsed = parseUpdateArguments(args, { cwd, now })
  assert.equal(parsed.help, false)
  if (parsed.help) throw new Error('更新条件が必要です。')
  return parsed
}

async function fixture(t: test.TestContext) {
  const parent = resolve('.cache/update-tests')
  await fs.mkdir(parent, { recursive: true })
  const root = await fs.mkdtemp(join(parent, 'sf6-update-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const input = join(root, '.cache/win-rates/snapshots')
  await fs.mkdir(input, { recursive: true })
  return { root, input, output: join(root, 'public/data/win-rates') }
}

async function writeMonth(input: string, month: string, totalText?: string) {
  await fs.writeFile(join(input, `${month}.json`), JSON.stringify(monthSnapshot(month, totalText)))
}

async function contents(directory: string) {
  return Object.fromEntries(await Promise.all((await fs.readdir(directory)).sort().map(async (name) => [name, await fs.readFile(join(directory, name), 'utf8')])))
}

test('単月・年をまたぐ期間・保存済み全月とパスを解釈する', () => {
  const cwd = resolve('.cache/argument-tests')
  const single = options(['--month', '2023-06'], cwd)
  assert.deepEqual(single.months, ['2023-06'])
  assert.equal(single.inputDirectory, join(cwd, '.cache/win-rates/snapshots'))
  assert.equal(single.outputDirectory, join(cwd, 'public/data/win-rates'))
  assert.equal(single.transactionDirectory.startsWith(join(cwd, '.cache/win-rates/publication')), true)
  assert.deepEqual(options(['--from', '2023-11', '--to', '2024-02'], cwd).months, ['2023-11', '2023-12', '2024-01', '2024-02'])
  const all = options(['--all', '--input-dir', 'exported', '--cache-dir', 'saved', '--output-dir', 'result'], cwd)
  assert.equal(all.months, null)
  assert.equal(all.inputDirectory, join(cwd, 'exported'))
  assert.equal(all.cacheDirectory, join(cwd, 'saved'))
  assert.equal(all.outputDirectory, join(cwd, 'result'))
  assert.notEqual(all.transactionDirectory, single.transactionDirectory)
  assert.equal(options(['--all', '--cache-dir', 'saved'], cwd).inputDirectory, join(cwd, 'saved'))
  assert.deepEqual(parseUpdateArguments(['--help']), { help: true })
})

test('未対応・混在・重複した引数、不正・開始前・未来の月を拒否する', () => {
  for (const args of [
    [], ['--unknown'], ['--month'], ['--month', '--all'], ['--month', '2026-08', '--all'],
    ['--all', '--from', '2026-08', '--to', '2026-09'], ['--from', '2026-08'], ['--to', '2026-09'],
    ['--all', '--all'], ['--month', '2026-08', '--month', '2026-09'], ['--all', '--input-dir', ''],
    ['--from', '2026-09', '--to', '2026-08'], ['--month', '2023-05'], ['--month', '2026-11'],
    ['--month', '2026-00'], ['--month', '2026-13'], ['--month', '202608'], ['--month', '2026-8'],
    ['--help', '--all'], ['--month', '../2026-08'],
  ]) assert.throws(() => parseUpdateArguments(args, { now }), args.join(' '))
  assert.equal(parseUpdateArguments(['--month', '2026-10'], { now: new Date('2026-09-30T15:00:00.000Z') }).help, false)
  assert.throws(() => parseUpdateArguments(['--month', '2026-10'], { now: new Date('2026-09-30T14:59:59.999Z') }), /未来/)
})

test('--all は実在する月別JSONだけを昇順で更新し、全履歴や途中月を推測しない', async (t) => {
  const { root, input, output } = await fixture(t)
  await writeMonth(input, '2026-09')
  await writeMonth(input, '2026-07')
  await fs.writeFile(join(input, 'sample-2026-08.json'), '{}')
  await fs.writeFile(join(input, 'README.txt'), '説明')
  const result = await updateWinRates(options(['--all'], root), now)
  assert.deepEqual(result.months, ['2026-07', '2026-09'])
  assert.equal(result.updatedDatasets, 32)
  const manifest = JSON.parse(await fs.readFile(join(output, 'index.json'), 'utf8'))
  assert.equal(manifest.generatedAt, now.toISOString())
  assert.deepEqual([...new Set(manifest.datasets.map((dataset: WinRateDataset) => dataset.month))], ['2026-09', '2026-07'])
  for (const descriptor of manifest.datasets) {
    const dataset = JSON.parse(await fs.readFile(join(output, descriptor.path), 'utf8'))
    assert.equal(dataset.generatedAt, now.toISOString())
    assert.equal(dataset.capturedAt, capturedAt)
    assert.equal(descriptor.capturedAt, capturedAt)
  }
})

test('期間の途中月がなければ公開先を変更せず、必要な公式書出しを知らせる', async (t) => {
  const { root, input, output } = await fixture(t)
  await writeMonth(input, '2026-07')
  await updateWinRates(options(['--month', '2026-07'], root), now)
  const before = await contents(output)
  await writeMonth(input, '2026-08')
  const update = options(['--from', '2026-08', '--to', '2026-09'], root)
  await assert.rejects(updateWinRates(update, now), /2026-09\.json[\s\S]*公式/)
  assert.deepEqual(await contents(output), before)
  await assert.rejects(fs.stat(update.transactionDirectory), { code: 'ENOENT' })
})

test('全対象を正規化してから反映し、別月・不足条件・破損JSONでは一部も反映しない', async (t) => {
  const { root, input, output } = await fixture(t)
  await writeMonth(input, '2026-07')
  await updateWinRates(options(['--month', '2026-07'], root), now)
  const before = await contents(output)
  await writeMonth(input, '2026-08')
  const mismatched = monthSnapshot('2026-09')
  mismatched.snapshots[0].month = '2026-08'
  const duplicate = monthSnapshot('2026-09')
  duplicate.snapshots[1] = duplicate.snapshots[0]
  const incomplete = monthSnapshot('2026-09')
  incomplete.snapshots.pop()
  const invalidMatrix = monthSnapshot('2026-09')
  invalidMatrix.snapshots[0].rows[0].cells.pop()
  for (const body of [JSON.stringify(mismatched), JSON.stringify(duplicate), JSON.stringify(incomplete), JSON.stringify(invalidMatrix), '{']) {
    await fs.writeFile(join(input, '2026-09.json'), body)
    await assert.rejects(updateWinRates(options(['--from', '2026-08', '--to', '2026-09'], root), now))
    assert.deepEqual(await contents(output), before)
  }
})

test('同月の各リーグと操作タイプ別は合算と同じキャラ集合でなければ更新しない', async (t) => {
  const { root, input, output } = await fixture(t)
  await writeMonth(input, '2026-07')
  await updateWinRates(options(['--month', '2026-07'], root), now)
  const before = await contents(output)
  const fewerCharacters = monthSnapshot('2026-08')
  const reduced = fewerCharacters.snapshots[0]
  reduced.columns.pop()
  reduced.rows.pop()
  reduced.rows.forEach((row) => row.cells.pop())
  reduced.readyCharacterCount = reduced.columns.length
  const differentControlsRoster = monthSnapshot('2026-08')
  const separate = differentControlsRoster.snapshots[1]
  const replacedId = separate.columns[0].characterId
  for (const identity of [...separate.columns, ...separate.rows]) {
    if (identity.characterId === replacedId) identity.characterId = 'different-character'
  }
  for (const snapshot of [fewerCharacters, differentControlsRoster]) {
    await fs.writeFile(join(input, '2026-08.json'), JSON.stringify(snapshot))
    await assert.rejects(updateWinRates(options(['--month', '2026-08'], root), now), /月内のキャラクター構成/)
    assert.deepEqual(await contents(output), before)
  }
})

test('単月更新は別月のJSONを保持し、input-dirを直接読んで入力やcacheを書き換えない', async (t) => {
  const { root, input, output } = await fixture(t)
  await writeMonth(input, '2026-07')
  await writeMonth(input, '2026-08')
  await updateWinRates(options(['--all'], root), now)
  const before = await contents(output)
  const cacheBefore = await contents(input)
  const exported = join(root, 'exported')
  await fs.mkdir(exported)
  await writeMonth(exported, '2026-08', '4.928')
  const exportBefore = await contents(exported)
  const result = await updateWinRates(options(['--month', '2026-08', '--input-dir', exported], root), now)
  assert.equal(result.updatedDatasets, 16)
  assert.equal(result.datasets, 32)
  const after = await contents(output)
  for (const path of Object.keys(before).filter((path) => path.startsWith('2026-07-'))) assert.equal(after[path], before[path])
  assert.equal(JSON.parse(after['2026-08-master-combined.json']).rows[0].total.text, '4.928')
  assert.deepEqual(await contents(input), cacheBefore)
  assert.deepEqual(await contents(exported), exportBefore)
})

test('空の入力先・未来の保存月・単月ファイル不足では公開先を作らない', async (t) => {
  const { root, input, output } = await fixture(t)
  await assert.rejects(updateWinRates(options(['--all'], root), now), /月別JSON/)
  await assert.rejects(updateWinRates(options(['--month', '2026-08'], root), now), /入力ファイルがありません/)
  await writeMonth(input, '2026-11')
  await assert.rejects(updateWinRates(options(['--all'], root), now), /未来/)
  await assert.rejects(fs.stat(output), { code: 'ENOENT' })
})
