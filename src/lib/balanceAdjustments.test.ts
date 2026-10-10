import assert from 'node:assert/strict'
import test from 'node:test'
import {
  balanceAdjustmentShortDate,
  balanceAdjustmentsForMonth,
  loadBalanceAdjustmentCatalog,
  parseBalanceAdjustmentCatalog,
} from './balanceAdjustments.ts'
import type { BalanceAdjustment, BalanceAdjustmentCatalog } from '../types/balanceAdjustments.ts'

function event(overrides: Partial<BalanceAdjustment> = {}): BalanceAdjustment {
  return {
    id: '20260317-all', date: '2026-03-17', dateBasis: 'effective', kindLabel: '全キャラ・共通調整',
    title: 'バトル変更リスト',
    source: { url: 'https://www.streetfighter.com/6/buckler/ja-jp/battle_change/20260317', title: 'バトル変更リスト' },
    announcement: { url: 'https://www.streetfighter.com/6/buckler/ja-jp/information/detail/update20260317', title: 'アップデートのお知らせ' },
    ...overrides,
  }
}

function catalog(overrides: Partial<BalanceAdjustmentCatalog> = {}): BalanceAdjustmentCatalog {
  return {
    schemaVersion: 1, generatedAt: '2026-10-08T00:00:00.000Z', checkedAt: '2026-10-08T08:59:00+09:00',
    source: { url: 'https://www.streetfighter.com/6/buckler/ja-jp/information/battle_change/1', title: 'バトル変更一覧' },
    coverage: { fromMonth: '2025-09', toMonth: '2026-08' }, events: [event()], ...overrides,
  }
}

test('公式固定リンクと確認日・生成日・リスト日を保ち、入力を変更しない', () => {
  const input = catalog({ events: [event(), event({
    id: '20260415-common', date: '2026-04-15', dateBasis: 'list', announcement: null,
    source: { url: 'https://www.streetfighter.com/6/buckler/ja-jp/battle_change/20260415', title: 'バトル変更リスト' },
  })] })
  const before = structuredClone(input)
  const output = parseBalanceAdjustmentCatalog(input)
  assert.deepEqual(output, input)
  assert.notStrictEqual(output, input)
  assert.notStrictEqual(output.events[0], input.events[0])
  assert.deepEqual(input, before)
  assert.equal(output.events[1].dateBasis, 'list')
  assert.equal(output.events[1].announcement, null)
  assert.equal(balanceAdjustmentShortDate(output.events[0]), '3/17')
  assert.equal(balanceAdjustmentShortDate(output.events[1]), '4/15（リスト日）')
  assert.equal(parseBalanceAdjustmentCatalog(catalog({ events: [event({
    source: { url: 'https://www.streetfighter.com/6/buckler/ja-jp/battle_change/202506', title: '月版リスト' },
  })] })).events[0].source.url.endsWith('/202506'), true)
})

test('日本の暦日を月に対応させ、月境界と同月の複数調整を並べて入力順を保つ', () => {
  const input = catalog({ events: [
    event({ id: 'march-b', date: '2026-03-01' }), event({ id: 'april', date: '2026-04-01' }),
    event({ id: 'march-a', date: '2026-03-01' }), event({ id: 'february', date: '2026-02-28' }),
    event({ id: 'march-last', date: '2026-03-31' }),
  ] })
  const before = structuredClone(input)
  assert.deepEqual(balanceAdjustmentsForMonth(input, '2026-03').events.map(({ id }) => id), ['march-a', 'march-b', 'march-last'])
  assert.deepEqual(balanceAdjustmentsForMonth(input, '2026-04').events.map(({ date }) => date), ['2026-04-01'])
  assert.deepEqual(balanceAdjustmentsForMonth(input, '2026-02').events.map(({ date }) => date), ['2026-02-28'])
  assert.deepEqual(input, before)
})

test('確認済み範囲の変更なしを未確認の月と区別し、範囲の両端を含める', () => {
  const input = catalog()
  for (const month of ['2025-09', '2026-01', '2026-08']) {
    assert.deepEqual(balanceAdjustmentsForMonth(input, month), { month, status: 'ready', events: [] })
  }
  for (const month of ['2025-08', '2026-09']) {
    assert.deepEqual(balanceAdjustmentsForMonth(input, month), { month, status: 'unverified', events: [] })
  }
  for (const month of ['2026-00', '2026-13', '2026-1', '2026-01-01', ' 2026-01']) {
    assert.throws(() => balanceAdjustmentsForMonth(input, month), /month/)
  }
})

test('存在する暦日と明示的な時差を要求し、日付の自動繰り上がりを拒否する', () => {
  const leap = catalog({ coverage: { fromMonth: '2024-02', toMonth: '2024-02' }, events: [event({ date: '2024-02-29' })] })
  assert.equal(parseBalanceAdjustmentCatalog(leap).events[0].date, '2024-02-29')
  for (const date of ['2026-02-29', '2026-04-31', '2026-13-01', '2026-01-00', '2026-3-17', '2026-03-17T00:00:00Z']) {
    assert.throws(() => parseBalanceAdjustmentCatalog(catalog({ events: [event({ date })] })), /date/)
  }
  for (const field of ['generatedAt', 'checkedAt'] as const) {
    for (const stamp of ['2026-02-30T00:00:00Z', '2026-10-08T00:00:00', '2026-10-08', '2026-10-08T24:00:00Z', '2026-10-08T00:00:00+24:00']) {
      assert.throws(() => parseBalanceAdjustmentCatalog(catalog({ [field]: stamp })), new RegExp(field))
    }
  }
  assert.equal(parseBalanceAdjustmentCatalog(catalog({ checkedAt: '2026-10-08T01:02:03.123456+09:00' })).checkedAt,
    '2026-10-08T01:02:03.123456+09:00')
})

test('不明な形式・確認範囲・重複ID・実施日未確認を確定データとして受け入れない', () => {
  for (const value of [null, [], { ...catalog(), schemaVersion: 2 }, { ...catalog(), events: null },
    catalog({ coverage: { fromMonth: '2026-13', toMonth: '2026-08' } }),
    catalog({ coverage: { fromMonth: '2026-09', toMonth: '2026-08' } }),
    catalog({ events: [event({ date: '2025-08-31' })] }),
    catalog({ events: [event({ date: '2026-09-01' })] }),
    catalog({ events: [event(), event()] }),
    catalog({ events: [event({ dateBasis: 'unknown' as never })] }),
    catalog({ events: [event({ announcement: null })] }),
    catalog({ events: [event({ id: '../patch' })] }),
  ]) assert.throws(() => parseBalanceAdjustmentCatalog(value), /形式/)
  for (const field of ['id', 'kindLabel', 'title'] as const) {
    for (const value of ['', ' ', ' 前後の空白 ']) {
      assert.throws(() => parseBalanceAdjustmentCatalog(catalog({ events: [event({ [field]: value })] })), new RegExp(field))
    }
  }
  const missingAnnouncement = event() as Partial<BalanceAdjustment>
  delete missingAnnouncement.announcement
  assert.throws(() => parseBalanceAdjustmentCatalog({ ...catalog(), events: [missingAnnouncement] }), /announcement/)
})

test('出典は日本語公式ページに限定し、可変の一覧を固定版の出典として扱わない', () => {
  for (const url of [
    'https://example.com/6/buckler/ja-jp/battle_change/20260317',
    'https://www.streetfighter.com.example.com/6/buckler/ja-jp/battle_change/20260317',
    'http://www.streetfighter.com/6/buckler/ja-jp/battle_change/20260317',
    'https://someone@www.streetfighter.com/6/buckler/ja-jp/battle_change/20260317',
    'https://www.streetfighter.com:1234/6/buckler/ja-jp/battle_change/20260317',
    'https://www.streetfighter.com/6/buckler/en/battle_change/20260317',
    'https://www.streetfighter.com/6/buckler/ja-jp/information/battle_change/1',
    'https://www.streetfighter.com/6/buckler/ja-jp/battle_change/20260317?preview=1',
    'https://www.streetfighter.com/6/buckler/ja-jp/battle_change/20260317#latest',
    'javascript:alert(1)',
  ]) assert.throws(() => parseBalanceAdjustmentCatalog(catalog({ events: [event({ source: { url, title: '出典' } })] })), /source.url/)
  assert.throws(() => parseBalanceAdjustmentCatalog(catalog({ events: [event({
    announcement: { url: event().source.url, title: '告知' },
  })] })), /announcement.url/)
  assert.throws(() => parseBalanceAdjustmentCatalog(catalog({ source: event().source })), /source.url/)
  assert.throws(() => parseBalanceAdjustmentCatalog(catalog({ source: { ...catalog().source, title: ' ' } })), /source.title/)
})

test('履歴取得は並行要求を共有し、通信・JSON・形式の失敗後に再読み込みできる', async (t) => {
  const requests: string[] = []
  const input = catalog()
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request) => {
    requests.push(String(url))
    if (requests.length === 1) throw new Error('network failure')
    if (requests.length === 2) return new Response(null, { status: 503 })
    if (requests.length === 3) return new Response('{', { status: 200 })
    if (requests.length === 4) return Response.json({ ...input, schemaVersion: 2 })
    return Response.json(input)
  })
  for (const error of [/network failure/, /読み込めません/, /JSON/, /schemaVersion/]) {
    const first = loadBalanceAdjustmentCatalog()
    const duplicate = loadBalanceAdjustmentCatalog()
    assert.strictEqual(first, duplicate)
    await assert.rejects(first, error)
    await assert.rejects(duplicate, error)
  }
  const first = loadBalanceAdjustmentCatalog()
  const duplicate = loadBalanceAdjustmentCatalog()
  assert.strictEqual(first, duplicate)
  const [firstResult, duplicateResult] = await Promise.all([first, duplicate])
  assert.strictEqual(firstResult, duplicateResult)
  assert.deepEqual(firstResult, input)
  assert.strictEqual(await loadBalanceAdjustmentCatalog(), firstResult)
  assert.deepEqual(requests, Array(5).fill('/data/balance-adjustments.json'))
})
