import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { preparePlayerObservationInput } from '../prepare-player-observation-input.ts'

const privateRoot = resolve(fileURLToPath(new URL('../../.local/', import.meta.url)))
async function fixture(t: { after: (callback: () => Promise<void>) => void }) {
  await mkdir(privateRoot, { recursive: true })
  const directory = await mkdtemp(join(privateRoot, 'player-input-test-'))
  t.after(async () => {
    const child = relative(privateRoot, directory)
    assert.ok(child && !isAbsolute(child) && child !== '..' && !child.startsWith('..' + sep))
    await rm(directory, { recursive: true, force: true })
  })
  return directory
}
function capture(page: number, capturedAt: string) {
  const total = 42
  const from = (page - 1) * 20 + 1
  const to = Math.min(page * 20, total)
  return {
    page, capturedAt,
    url: 'https://www.streetfighter.com/6/buckler/ja-jp/ranking/league?character_filter=2&character_id=luke&platform=1&user_status=1&home_filter=1&home_category_id=0&home_id=0&league_rank=0&page=' + page,
    conditions: { league: 'all', character: 'max-lp', region: 'all', platform: 'all', users: 'all' },
    range: { from, to, total },
    rows: Array.from({ length: to - from + 1 }, (_, index) => ({ cfnId: String(from + index), lp: 0, rank: 1 })),
  }
}
async function save(directory: string, name: string, value: unknown) {
  await writeFile(join(directory, name), JSON.stringify({ schemaVersion: 1, capture: value }))
}

test('ファイル名順ではなく実際の取得時刻から観測区間を作り、末尾・同点・LP0を保持する', async t => {
  const directory = await fixture(t)
  await save(directory, 'a-late.json', capture(1, '2026-10-13T01:30:00.000Z'))
  await save(directory, 'z-early.json', capture(3, '2026-10-13T01:29:00.000Z'))
  const input = await preparePlayerObservationInput(directory, 'test-probe')
  assert.equal(input.run.startedAt, '2026-10-13T01:29:00.000Z')
  assert.equal(input.run.endedAt, '2026-10-13T01:30:00.000Z')
  assert.equal(input.run.scope, 'probe')
  assert.deepEqual(input.captures.map(value => value.page), [3, 1])
  assert.equal(input.captures[0].rows.length, 2)
  assert.equal(input.captures[0].rows[0].lp, 0)
})

test('Rookie条件の記録を全体最大LP系列に混ぜず、二重ページも黙って採用しない', async t => {
  const directory = await fixture(t)
  const invalid = capture(1, '2026-10-13T01:30:00.000Z')
  invalid.url = invalid.url.replace('league_rank=0', 'league_rank=1')
  await save(directory, 'page.json', invalid)
  await assert.rejects(preparePlayerObservationInput(directory, 'wrong-condition'), /取得条件|一致/)
  await save(directory, 'page.json', capture(1, '2026-10-13T01:30:00.000Z'))
  await save(directory, 'page-duplicate.json', capture(1, '2026-10-13T01:31:00.000Z'))
  await assert.rejects(preparePlayerObservationInput(directory, 'duplicate-page'), /同ページ|一つ/)
})

test('取得記録以外の入力・未対応scope・出力名へのパス指定を拒否する', async t => {
  const directory = await fixture(t)
  await save(directory, 'page.json', capture(1, '2026-10-13T01:30:00.000Z'))
  await assert.rejects(preparePlayerObservationInput(directory, '../public'), /観測回ID/)
  await assert.rejects(preparePlayerObservationInput(directory, 'test', 'unknown' as 'probe'), /取得範囲/)
  await writeFile(join(directory, 'private.json'), JSON.stringify({ schemaVersion: 1, capture: capture(2, '2026-10-13T01:30:00.000Z'), authorization: 'not-a-real-secret' }))
  await assert.rejects(preparePlayerObservationInput(directory, 'private-field'), /ページ取得記録/)
})
