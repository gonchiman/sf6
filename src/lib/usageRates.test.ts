import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { UsageRateDataset, UsageRateDatasetDescriptor, UsageRateManifest } from '../types/usageRates.ts'
import {
  initialUsageRateSelection, loadUsageRateDataset, loadUsageRateHistory, loadUsageRateManifest,
  parseUsageRateDataset, parseUsageRateManifest, usageRateCalendarMonths, usageRatePercentThousandths,
  usageRateSelectedMonths, USAGE_RATE_SOURCE,
} from './usageRates.ts'

const capturedAt = '2026-10-09T05:00:00.000Z'
const generatedAt = '2026-10-09T05:01:00.000Z'

function descriptor(overrides: Partial<UsageRateDatasetDescriptor> = {}): UsageRateDatasetDescriptor {
  return { id: '2026-09-master', month: '2026-09', league: 'MASTER', path: '2026-09-master.json', capturedAt, ...overrides }
}

function dataset(overrides: Partial<UsageRateDataset> = {}): UsageRateDataset {
  const selected = descriptor(overrides)
  return {
    schemaVersion: 1, id: selected.id, month: selected.month, league: selected.league, capturedAt, generatedAt,
    source: { ...USAGE_RATE_SOURCE, population: 'ランクマッチ', metric: 'キャラクター使用率', unit: '集計単位の詳細は非公表', notes: ['人数や試合数は非公開'] },
    distributions: (['all', 'classic', 'modern'] as const).map((controlType) => ({
      controlType, month: selected.month, league: selected.league,
      entries: [
        { characterId: 'ryu', name: 'リュウ', text: '0.000', percentThousandths: 0 },
        { characterId: 'ken', name: 'ケン', text: '100.000%', percentThousandths: 100000 },
      ],
    })),
    ...overrides,
  }
}

function manifest(datasets = [descriptor()]): UsageRateManifest {
  return { schemaVersion: 1, generatedAt, source: USAGE_RATE_SOURCE, datasets }
}

test('published text, thousandths, zero, 100% and missing remain distinct', () => {
  const input = dataset()
  input.distributions[1].entries[0] = { ...input.distributions[1].entries[0], text: '-', percentThousandths: null }
  input.distributions[2].entries[0] = { ...input.distributions[2].entries[0], text: '-.---', percentThousandths: null }
  assert.deepEqual(parseUsageRateDataset(input, descriptor()), input)
  assert.equal(usageRatePercentThousandths('9.566'), 9566)
  assert.equal(usageRatePercentThousandths('0.000%'), 0)
  assert.equal(usageRatePercentThousandths('-'), null)
  for (const text of ['9.56', '9.5666', '100.001', '-1.000', 'NaN', '01.000']) {
    assert.throws(() => usageRatePercentThousandths(text), /entry.text/)
  }
  const inconsistent = dataset()
  inconsistent.distributions[0].entries[0].percentThousandths = null
  assert.throws(() => parseUsageRateDataset(inconsistent), /text mismatch/)
})

test('requires exactly three complete, unique ID sets but accepts different display orders', () => {
  const reordered = dataset()
  reordered.distributions[2].entries.reverse()
  assert.deepEqual(parseUsageRateDataset(reordered), reordered)
  assert.throws(() => parseUsageRateDataset({ ...dataset(), distributions: dataset().distributions.slice(0, 2) }), /required/)
  const duplicateMode = dataset()
  duplicateMode.distributions[2].controlType = 'all'
  assert.throws(() => parseUsageRateDataset(duplicateMode), /duplicate/)
  const differentSet = dataset()
  differentSet.distributions[2].entries[0].characterId = 'chunli'
  assert.throws(() => parseUsageRateDataset(differentSet), /characterIds/)
  const missingCharacter = dataset()
  missingCharacter.distributions[0].entries.shift()
  assert.throws(() => parseUsageRateDataset(missingCharacter), /characterIds/)
  const duplicateCharacter = dataset()
  duplicateCharacter.distributions[0].entries[1].characterId = 'ryu'
  assert.throws(() => parseUsageRateDataset(duplicateCharacter), /characterId: duplicate/)
})

test('detects partial distributions without renormalizing totals inside the rounding tolerance', () => {
  const partial = dataset()
  for (const mode of partial.distributions) {
    mode.entries = [{ characterId: 'ryu', name: 'リュウ', text: '10.000', percentThousandths: 10000 }]
  }
  assert.throws(() => parseUsageRateDataset(partial), /distribution.total/)
  const rounded = dataset()
  for (const mode of rounded.distributions) {
    mode.entries = [
      { characterId: 'ryu', name: 'リュウ', text: '33.333', percentThousandths: 33333 },
      { characterId: 'ken', name: 'ケン', text: '33.333', percentThousandths: 33333 },
      { characterId: 'chunli', name: '春麗', text: '33.333', percentThousandths: 33333 },
    ]
  }
  assert.equal(parseUsageRateDataset(rounded).distributions[0].entries[0].percentThousandths, 33333)
  rounded.distributions[0].entries[0] = { ...rounded.distributions[0].entries[0], text: '33.330', percentThousandths: 33330 }
  assert.throws(() => parseUsageRateDataset(rounded), /distribution.total/)
})

test('matching source edition and conditions are required for every distribution and descriptor', () => {
  for (const changed of ['month', 'league'] as const) {
    const input = dataset()
    input.distributions[1][changed] = changed === 'month' ? '2026-08' : 'ALL'
    assert.throws(() => parseUsageRateDataset(input), /conditions/)
  }
  for (const url of [
    'https://www.streetfighter.com/6/buckler/ja-jp/stats/usagerate_master',
    'https://example.com/6/buckler/ja-jp/stats/usagerate',
    'http://www.streetfighter.com/6/buckler/ja-jp/stats/usagerate',
    'https://user:secret@www.streetfighter.com/6/buckler/ja-jp/stats/usagerate',
  ]) assert.throws(() => parseUsageRateDataset(dataset({ source: { ...dataset().source, url } })), /source.url/)
  assert.throws(() => parseUsageRateDataset(dataset(), descriptor({ league: 'ALL' })), /一致しません/)
  assert.throws(() => parseUsageRateDataset(dataset(), descriptor({ month: '2026-08' })), /一致しません/)
  assert.throws(() => parseUsageRateDataset(dataset(), descriptor({ capturedAt: '2026-10-08T05:00:00Z' })), /一致しません/)
  assert.throws(() => parseUsageRateDataset(dataset({ capturedAt: '2026-02-30T00:00:00Z' })), /capturedAt/)
})

test('manifest blocks duplicate conditions, unsafe paths, invalid leagues and invalid calendar months', () => {
  assert.deepEqual(parseUsageRateManifest(manifest()), manifest())
  assert.throws(() => parseUsageRateManifest(manifest([descriptor(), descriptor({ id: 'other', path: 'other.json' })])), /conditions/)
  for (const path of ['../data.json', '/data.json', 'foo\\data.json', 'https://example.com/data.json', 'index.json', 'nested/../data.json']) {
    assert.throws(() => parseUsageRateManifest(manifest([descriptor({ path })])), /path/)
  }
  assert.throws(() => parseUsageRateManifest(manifest([descriptor({ month: '2026-13' })])), /month/)
  assert.throws(() => parseUsageRateManifest(manifest([descriptor({ league: 'ULTIMATE_MASTER' })])), /league/)
})

test('default selects latest registered MASTER months and calendars include registration gaps', () => {
  const registered = [
    descriptor({ id: 'july', month: '2026-07', path: 'july.json' }), descriptor(),
    descriptor({ id: 'all-september', league: 'ALL', path: 'all-september.json' }),
  ]
  const input = manifest(registered)
  assert.deepEqual(initialUsageRateSelection(input), { league: 'MASTER', fromMonth: '2026-07', toMonth: '2026-09' })
  assert.deepEqual(usageRateCalendarMonths(input), ['2026-07', '2026-08', '2026-09'])
  assert.deepEqual(usageRateSelectedMonths({ league: 'MASTER', fromMonth: '2025-12', toMonth: '2026-02' }), ['2025-12', '2026-01', '2026-02'])
  assert.throws(() => usageRateSelectedMonths({ league: 'MASTER', fromMonth: '2026-09', toMonth: '2026-07' }), /開始月/)
  const many = Array.from({ length: 14 }, (_, index) => {
    const year = index < 12 ? 2025 : 2026
    const number = index % 12 + 1
    const month = `${year}-${String(number).padStart(2, '0')}`
    return descriptor({ id: month, month, path: `${month}.json` })
  })
  assert.equal(initialUsageRateSelection(manifest(many)).fromMonth, '2025-03')
})

test('history distinguishes unregistered, load error, condition mismatch, and ready months', async () => {
  const july = descriptor({ id: 'july', month: '2026-07', path: 'july.json' })
  const august = descriptor({ id: 'august', month: '2026-08', path: 'august.json' })
  const input = manifest([july, august, descriptor()])
  const results = await loadUsageRateHistory(input, { league: 'MASTER', fromMonth: '2026-06', toMonth: '2026-09' }, async (item) => {
    if (item.month === '2026-07') throw new Error('network')
    if (item.month === '2026-08') return dataset() // Wrong month and ID must not become a ready result.
    return dataset()
  })
  assert.deepEqual(results.map((result) => [result.month, result.status]), [
    ['2026-06', 'missing'], ['2026-07', 'error'], ['2026-08', 'error'], ['2026-09', 'ready'],
  ])
})

test('manifest failures are evicted from the request cache so retry succeeds', async (t) => {
  let count = 0
  t.mock.method(globalThis, 'fetch', async () => {
    count += 1
    return count === 1 ? new Response('', { status: 503 }) : Response.json(manifest())
  })
  await assert.rejects(loadUsageRateManifest(), /読み込めません/)
  assert.deepEqual(await loadUsageRateManifest(), manifest())
  assert.equal(count, 2)
})

test('dataset cache shares successful requests and evicts malformed or mismatched responses', async (t) => {
  let count = 0
  const selected = descriptor({ path: 'cache-test.json' })
  t.mock.method(globalThis, 'fetch', async () => {
    count += 1
    return Response.json(count === 1 ? { ...dataset(), distributions: [] } : dataset())
  })
  await assert.rejects(loadUsageRateDataset(selected), /distributions/)
  const [left, right] = await Promise.all([loadUsageRateDataset(selected), loadUsageRateDataset(selected)])
  assert.strictEqual(left, right)
  assert.equal(count, 2)
  await assert.rejects(loadUsageRateDataset({ ...selected, league: 'ALL' }), /一致しません/)
  await loadUsageRateDataset(selected)
  assert.equal(count, 3)
})

test('a new publication reads corrected values even when capture time and path are unchanged', async (t) => {
  const selected = descriptor({ path: 'publication-correction.json' })
  const initial = manifest([selected])
  const newer = { ...initial, generatedAt: '2026-10-09T06:00:00.000Z' }
  const selection = { league: 'MASTER', fromMonth: selected.month, toMonth: selected.month }
  let published = dataset()
  const requests: string[] = []
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    requests.push(String(input))
    return Response.json(published)
  })
  const before = await loadUsageRateHistory(initial, selection)
  published = dataset()
  published.distributions[0].entries[0] = { ...published.distributions[0].entries[0], text: '1.234', percentThousandths: 1234 }
  published.distributions[0].entries[1] = { ...published.distributions[0].entries[1], text: '98.766', percentThousandths: 98766 }
  const after = await loadUsageRateHistory(newer, selection)
  const again = await loadUsageRateHistory(newer, selection)
  assert.equal(before[0].status, 'ready')
  assert.equal(after[0].status, 'ready')
  if (before[0].status !== 'ready' || after[0].status !== 'ready' || again[0].status !== 'ready') assert.fail('Expected ready datasets')
  assert.equal(before[0].dataset.distributions[0].entries[0].percentThousandths, 0)
  assert.equal(after[0].dataset.distributions[0].entries[0].percentThousandths, 1234)
  assert.equal(after[0].dataset.capturedAt, before[0].dataset.capturedAt)
  assert.strictEqual(again[0].dataset.distributions[0].entries[0].percentThousandths, 1234)
  assert.equal(requests.length, 2)
  assert.notEqual(requests[0], requests[1])
  assert.ok(requests[0].includes(`published=${encodeURIComponent(initial.generatedAt)}`))
  assert.ok(requests[1].includes(`published=${encodeURIComponent(newer.generatedAt)}`))
})
