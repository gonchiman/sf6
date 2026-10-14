import assert from 'node:assert/strict'
import test from 'node:test'
import {
  balanceAdjustmentCharacters, balanceAdjustmentMonthOptions, filterBalanceAdjustmentList,
  initialBalanceAdjustmentListFilters, selectBalanceAdjustmentEvent, updateBalanceAdjustmentPeriod,
} from './balanceAdjustmentList.ts'
import type { BalanceAdjustment, BalanceAdjustmentCatalog } from '../types/balanceAdjustments.ts'
import type { BalanceAdjustmentDetailsCatalog, BalanceAdjustmentListFilters } from '../types/balanceAdjustmentDetails.ts'

function event(id: string, date: string): BalanceAdjustment {
  return {
    id, date, dateBasis: 'list', kindLabel: '調整', title: 'バトル変更リスト', announcement: null,
    source: { url: `https://www.streetfighter.com/6/buckler/ja-jp/battle_change/${date.replaceAll('-', '')}`, title: '出典' },
  }
}

const events = [event('past', '2025-12-16'), event('august', '2026-08-03'), event('march', '2026-03-17')]
const catalog: BalanceAdjustmentCatalog = {
  schemaVersion: 1, generatedAt: '2026-10-08T00:00:00Z', checkedAt: '2026-10-08T00:00:00Z',
  source: { url: 'https://www.streetfighter.com/6/buckler/ja-jp/information/battle_change/1', title: '公式一覧' },
  coverage: { fromMonth: '2025-12', toMonth: '2026-08' }, events,
}
const details: BalanceAdjustmentDetailsCatalog = {
  schemaVersion: 1, generatedAt: '2026-10-14T00:00:00Z',
  patches: [1, 2].map((index) => ({
    adjustmentId: events[index].id, date: events[index].date, source: events[index].source,
    capturedAt: '2026-10-14T00:00:00Z', common: { policy: '', changes: [] },
    characters: [
      { characterId: 'ken', name: 'ケン', status: 'ready', source: { url: `${events[index].source.url}/ken`, title: 'ケン' }, policy: '', changes: [] },
      { characterId: 'ryu', name: 'リュウ', status: 'ready', source: { url: `${events[index].source.url}/ryu`, title: 'リュウ' }, policy: '調整方針',
        changes: [{ id: '1', target: '波動拳', categoryLabel: '調整', description: '調整しました。' }] },
      { characterId: 'yasmine', name: 'ヤスミン', status: 'unlisted', source: null, policy: '', changes: [] },
    ],
  })),
}
const filters: BalanceAdjustmentListFilters = { characterId: 'all', fromMonth: '2025-12', toMonth: '2026-08' }

test('全確認月を昇順の選択肢にし、変更のない月も省略せず両端から初期期間を設定する', () => {
  assert.deepEqual(balanceAdjustmentMonthOptions(catalog), ['2025-12', '2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08'])
  assert.deepEqual(initialBalanceAdjustmentListFilters(catalog), filters)
  assert.deepEqual(balanceAdjustmentMonthOptions({ ...catalog, coverage: { fromMonth: '2026-08', toMonth: '2026-08' } }), ['2026-08'])
})

test('期間逆転では変更した端を優先し、キャラ条件と元オブジェクトを維持する', () => {
  const source = { ...filters, characterId: 'ryu' }
  const before = structuredClone(source)
  assert.deepEqual(updateBalanceAdjustmentPeriod(source, 'fromMonth', '2026-09'), { characterId: 'ryu', fromMonth: '2026-09', toMonth: '2026-09' })
  assert.deepEqual(updateBalanceAdjustmentPeriod(source, 'toMonth', '2025-11'), { characterId: 'ryu', fromMonth: '2025-11', toMonth: '2025-11' })
  assert.deepEqual(updateBalanceAdjustmentPeriod(source, 'fromMonth', '2026-03'), { ...source, fromMonth: '2026-03' })
  assert.deepEqual(updateBalanceAdjustmentPeriod(source, 'toMonth', '2026-03'), { ...source, toMonth: '2026-03' })
  assert.deepEqual(source, before)
})

test('一覧を新しい順にし、対象月の境界を含めて選択し、入力順を変更しない', () => {
  const before = structuredClone(catalog)
  assert.deepEqual(filterBalanceAdjustmentList(catalog, details, filters).events.map(({ id }) => id), ['august', 'march', 'past'])
  assert.deepEqual(filterBalanceAdjustmentList(catalog, details, { ...filters, fromMonth: '2026-03', toMonth: '2026-08' }).events.map(({ id }) => id), ['august', 'march'])
  assert.deepEqual(filterBalanceAdjustmentList(catalog, details, { ...filters, fromMonth: '2026-03', toMonth: '2026-03' }).events.map(({ id }) => id), ['march'])
  assert.deepEqual(filterBalanceAdjustmentList(catalog, details, { ...filters, fromMonth: '2026-04', toMonth: '2026-04' }), { events: [], unknownCount: 0 })
  assert.deepEqual(catalog, before)
})

test('キャラ指定時は変更ありだけを表示し、未取込を対象キャラ不明として別件数にする', () => {
  assert.deepEqual(filterBalanceAdjustmentList(catalog, details, { ...filters, characterId: 'ryu' }).events.map(({ id }) => id), ['august', 'march'])
  assert.equal(filterBalanceAdjustmentList(catalog, details, { ...filters, characterId: 'ryu' }).unknownCount, 1)
  assert.deepEqual(filterBalanceAdjustmentList(catalog, details, { ...filters, characterId: 'ken' }), { events: [], unknownCount: 1 })
  assert.deepEqual(filterBalanceAdjustmentList(catalog, details, { ...filters, characterId: 'yasmine' }), { events: [], unknownCount: 1 })
  assert.deepEqual(filterBalanceAdjustmentList(catalog, details, { ...filters, characterId: 'ryu', fromMonth: '2026-03' }).unknownCount, 0)
  assert.deepEqual(filterBalanceAdjustmentList(catalog, null, { ...filters, characterId: 'ryu' }), { events: [], unknownCount: 3 })
  assert.equal(filterBalanceAdjustmentList(catalog, null, filters).events.length, 3)
  assert.equal(filterBalanceAdjustmentList(catalog, null, filters).unknownCount, 0)
})

test('同日イベントの順序をIDで安定させ、フィルター外の選択は最新へ戻す', () => {
  const input = { ...catalog, events: [event('same-b', '2026-08-03'), event('same-a', '2026-08-03'), events[0]] }
  const rows = filterBalanceAdjustmentList(input, null, filters).events
  assert.deepEqual(rows.map(({ id }) => id), ['same-a', 'same-b', 'past'])
  assert.strictEqual(selectBalanceAdjustmentEvent(rows, 'past'), rows[2])
  assert.strictEqual(selectBalanceAdjustmentEvent(rows, 'filtered-out'), rows[0])
  assert.strictEqual(selectBalanceAdjustmentEvent(rows, null), rows[0])
  assert.equal(selectBalanceAdjustmentEvent([], 'past'), null)
})

test('キャラ別一覧は元順で変更なし・未掲載も残し、絞り込みでも本文オブジェクトを保つ', () => {
  const patch = details.patches[0]
  const before = structuredClone(patch)
  assert.deepEqual(balanceAdjustmentCharacters(patch).map(({ characterId }) => characterId), ['ken', 'ryu', 'yasmine'])
  assert.deepEqual(balanceAdjustmentCharacters(patch, 'ken'), [patch.characters[0]])
  assert.strictEqual(balanceAdjustmentCharacters(patch, 'ryu')[0], patch.characters[1])
  assert.deepEqual(balanceAdjustmentCharacters(patch, 'unknown'), [])
  assert.deepEqual(patch, before)
})

test('詳細の日付・出典が別イベントのものなら本文未取込として扱う', () => {
  const altered = { ...details, patches: details.patches.map((patch) => ({ ...patch, date: '2026-08-04' })) }
  assert.deepEqual(filterBalanceAdjustmentList(catalog, altered, { ...filters, characterId: 'ryu' }), { events: [], unknownCount: 3 })
})

test('不正な月や逆転した期間を黙って表示しない', () => {
  for (const month of ['2026-0', '2026-00', '2026-13', ' 2026-08', '2026-08-03']) {
    assert.throws(() => updateBalanceAdjustmentPeriod(filters, 'fromMonth', month), /形式/)
    assert.throws(() => filterBalanceAdjustmentList(catalog, details, { ...filters, toMonth: month }), /形式/)
  }
  assert.throws(() => filterBalanceAdjustmentList(catalog, details, { ...filters, fromMonth: '2026-09' }), /順序/)
  assert.throws(() => balanceAdjustmentMonthOptions({ ...catalog, coverage: { fromMonth: '2026-09', toMonth: '2026-08' } }), /順序/)
})
