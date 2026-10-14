import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { UsageRateDataset, UsageRateDatasetDescriptor, UsageRateManifest } from '../types/usageRates.ts'
import {
  initialUsageRateSelection, loadUsageRateDataset, loadUsageRateHistory, loadUsageRateManifest,
  parseUsageRateDataset, parseUsageRateManifest, usageRateCalendarMonths, usageRateMonths, usageRatePercentThousandths,
  usageRateSelectedMonths, usageRateEditionOf, USAGE_RATE_EDITION_LEAGUES, USAGE_RATE_EDITION_SOURCES, USAGE_RATE_SOURCE,
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

function masterDescriptor(overrides: Partial<UsageRateDatasetDescriptor> = {}): UsageRateDatasetDescriptor {
  return descriptor({ id: 'master-2026-09-master', path: 'master/2026-09-master.json', edition: 'master', ...overrides })
}

function masterDataset(overrides: Partial<UsageRateDataset> = {}): UsageRateDataset {
  const selected = masterDescriptor(overrides)
  const input = dataset({ id: selected.id, edition: 'master', month: selected.month, league: selected.league })
  return { ...input, source: { ...input.source, ...USAGE_RATE_EDITION_SOURCES.master }, distributions: input.distributions.slice(0, 1), ...overrides }
}

function recheckedTotalDataset(): UsageRateDataset {
  const input = dataset({ month: '2023-06' })
  input.distributions[0].entries[0] = { ...input.distributions[0].entries[0], text: '0.135', percentThousandths: 135 }
  input.distributions[0].totalMismatch = {
    observedPercentThousandths: 100135, verifiedAt: capturedAt,
    sourceUrl: `${USAGE_RATE_SOURCE.url}/202306`,
    reason: '公式ページを再確認したところ、公表値の合計が100.135%でした。値の補正はしていません。',
  }
  input.source.notes.push(input.distributions[0].totalMismatch.reason)
  return input
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

test('requires three unique distributions, preserves different published rosters, and rejects duplicate characters', () => {
  const reordered = dataset()
  reordered.distributions[2].entries.reverse()
  assert.deepEqual(parseUsageRateDataset(reordered), reordered)
  assert.throws(() => parseUsageRateDataset({ ...dataset(), distributions: dataset().distributions.slice(0, 2) }), /required/)
  const duplicateMode = dataset()
  duplicateMode.distributions[2].controlType = 'all'
  assert.throws(() => parseUsageRateDataset(duplicateMode), /duplicate/)
  const differentSet = dataset()
  differentSet.distributions[2].entries[0].characterId = 'chunli'
  assert.deepEqual(parseUsageRateDataset(differentSet), differentSet)
  const missingCharacter = dataset()
  missingCharacter.distributions[0].entries.shift()
  assert.deepEqual(parseUsageRateDataset(missingCharacter), missingCharacter)
  assert.equal(parseUsageRateDataset(missingCharacter).distributions[0].entries.length, 1)
  const duplicateCharacter = dataset()
  duplicateCharacter.distributions[0].entries[1].characterId = 'ryu'
  assert.throws(() => parseUsageRateDataset(duplicateCharacter), /characterId: duplicate/)
  const empty = dataset()
  empty.distributions[0].entries = []
  assert.throws(() => parseUsageRateDataset(empty), /entries: empty/)
})

test('legacy general JSON remains schema v1 and each master league accepts only the published ALL distribution', () => {
  assert.equal(usageRateEditionOf(dataset()), 'general')
  assert.deepEqual(parseUsageRateDataset(dataset({ edition: 'general' })), dataset({ edition: 'general' }))
  for (const league of USAGE_RATE_EDITION_LEAGUES.master) {
    const input = masterDataset({ league })
    assert.deepEqual(parseUsageRateDataset(input, masterDescriptor({ league })), input)
    assert.equal(parseUsageRateManifest(manifest([masterDescriptor({ league })])).datasets[0].edition, 'master')
  }
  const extra = masterDataset()
  extra.distributions.push({ ...extra.distributions[0], controlType: 'modern' })
  assert.throws(() => parseUsageRateDataset(extra), /MASTER ALL required/)
  assert.throws(() => parseUsageRateDataset(masterDataset({ distributions: [{ ...masterDataset().distributions[0], controlType: 'classic' }] })), /MASTER ALL required/)
  assert.throws(() => parseUsageRateDataset(masterDataset({ distributions: [] })), /MASTER ALL required/)
  assert.throws(() => parseUsageRateDataset(masterDataset({ league: 'ALL' })), /league/)
  assert.throws(() => parseUsageRateDataset({ ...dataset(), edition: 'other' }), /edition/)
})

test('master and general sources and descriptor editions cannot be interchanged', () => {
  assert.throws(() => parseUsageRateDataset(masterDataset({ source: dataset().source })), /source.url/)
  assert.throws(() => parseUsageRateDataset(dataset({ source: masterDataset().source })), /source.url/)
  assert.throws(() => parseUsageRateManifest({ ...manifest([masterDescriptor()]), source: USAGE_RATE_EDITION_SOURCES.master }), /source.url/)
  assert.throws(() => parseUsageRateDataset(masterDataset(), { ...masterDescriptor(), edition: undefined }), /一致しません.*edition/)
  assert.throws(() => parseUsageRateDataset(dataset(), { ...descriptor(), edition: 'master' }), /一致しません.*edition/)
  for (const suffix of ['?month=2026-09', '#MASTER']) {
    const input = masterDataset()
    input.source.url += suffix
    assert.throws(() => parseUsageRateDataset(input), /source.url/)
  }
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

test('an explicit official recheck preserves an exceptional total without normalizing published entries', () => {
  const input = recheckedTotalDataset()
  const before = structuredClone(input)
  const parsed = parseUsageRateDataset(input)
  assert.deepEqual(parsed, input)
  assert.deepEqual(input, before)
  assert.equal(parsed.distributions[0].entries[0].percentThousandths, 135)
  assert.equal(parsed.distributions[0].entries[1].percentThousandths, 100000)
  assert.equal(parsed.distributions[0].totalMismatch!.observedPercentThousandths, 100135)
  const unacknowledged = structuredClone(input)
  delete unacknowledged.distributions[0].totalMismatch
  assert.throws(() => parseUsageRateDataset(unacknowledged), /distribution.total/)
  const canonical = structuredClone(input)
  canonical.distributions[0].totalMismatch!.sourceUrl = USAGE_RATE_SOURCE.url
  assert.equal(parseUsageRateDataset(canonical).distributions[0].totalMismatch!.sourceUrl, USAGE_RATE_SOURCE.url)
})

test('total mismatch acknowledgements must match the actual sum, date, edition, period and official source', () => {
  for (const total of [100134, 100135.5, Number.NaN]) {
    const input = recheckedTotalDataset()
    input.distributions[0].totalMismatch!.observedPercentThousandths = total
    assert.throws(() => parseUsageRateDataset(input), /observedPercentThousandths/)
  }
  for (const sourceUrl of [
    'https://example.com/6/buckler/ja-jp/stats/usagerate/202306',
    `${USAGE_RATE_SOURCE.url}/202307`, USAGE_RATE_EDITION_SOURCES.master.url,
    'https://www.streetfighter.com/6/buckler/en-us/stats/usagerate/202306',
    `${USAGE_RATE_SOURCE.url}/202306?ignored=1`, `${USAGE_RATE_SOURCE.url}/202306#MASTER`,
    'https://user:password@www.streetfighter.com/6/buckler/ja-jp/stats/usagerate/202306',
  ]) {
    const input = recheckedTotalDataset()
    input.distributions[0].totalMismatch!.sourceUrl = sourceUrl
    assert.throws(() => parseUsageRateDataset(input), /totalMismatch.sourceUrl/)
  }
  for (const verifiedAt of ['2026-02-30T00:00:00Z', '2026-10-09T06:00:00Z', '2026-10-09']) {
    const input = recheckedTotalDataset()
    input.distributions[0].totalMismatch!.verifiedAt = verifiedAt
    assert.throws(() => parseUsageRateDataset(input), /totalMismatch.verifiedAt/)
  }
  const noReason = recheckedTotalDataset()
  noReason.distributions[0].totalMismatch!.reason = ''
  assert.throws(() => parseUsageRateDataset(noReason), /totalMismatch.reason/)
})

test('normal rounding totals and missing-value distributions cannot use exceptional-total acknowledgements', () => {
  const original = recheckedTotalDataset()
  const valid = dataset()
  valid.distributions[0].totalMismatch = original.distributions[0].totalMismatch
  assert.throws(() => parseUsageRateDataset(valid), /no complete out-of-tolerance total/)
  const missing = recheckedTotalDataset()
  missing.distributions[0].entries[0] = { ...missing.distributions[0].entries[0], text: '-', percentThousandths: null }
  assert.throws(() => parseUsageRateDataset(missing), /no complete out-of-tolerance total/)
  const rounded = dataset()
  rounded.distributions[0].entries = [
    { characterId: 'ryu', name: 'リュウ', text: '33.333', percentThousandths: 33333 },
    { characterId: 'ken', name: 'ケン', text: '33.333', percentThousandths: 33333 },
    { characterId: 'chunli', name: '春麗', text: '33.333', percentThousandths: 33333 },
  ]
  rounded.distributions[0].totalMismatch = { ...original.distributions[0].totalMismatch!, observedPercentThousandths: 99999 }
  assert.throws(() => parseUsageRateDataset(rounded), /no complete out-of-tolerance total/)
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

test('manifest allows a general and master MASTER publication in the same month but blocks implicit general duplicates', () => {
  const input = manifest([descriptor(), masterDescriptor()])
  assert.deepEqual(parseUsageRateManifest(input), input)
  assert.throws(() => parseUsageRateManifest(manifest([descriptor(), descriptor({ id: 'explicit-general', path: 'explicit-general.json', edition: 'general' })])), /conditions/)
  assert.throws(() => parseUsageRateManifest(manifest([masterDescriptor(), masterDescriptor({ id: 'duplicate-master', path: 'duplicate-master.json' })])), /conditions/)
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

test('months, calendars and initial selections keep editions separate even for the common MASTER league', () => {
  const input = manifest([
    descriptor({ id: 'general-july', path: 'general-july.json', month: '2026-07' }), descriptor(),
    masterDescriptor({ id: 'master-february', path: 'master/february.json', month: '2025-02' }),
    masterDescriptor({ id: 'master-april', path: 'master/april.json', month: '2025-04' }),
  ])
  assert.deepEqual(usageRateMonths(input), ['2026-07', '2026-09'])
  assert.deepEqual(usageRateMonths(input, 'MASTER', 'master'), ['2025-02', '2025-04'])
  assert.deepEqual(usageRateCalendarMonths(input), ['2026-07', '2026-08', '2026-09'])
  assert.deepEqual(usageRateCalendarMonths(input, 'master'), ['2025-02', '2025-03', '2025-04'])
  assert.deepEqual(initialUsageRateSelection(input), { league: 'MASTER', fromMonth: '2026-07', toMonth: '2026-09' })
  assert.deepEqual(initialUsageRateSelection(input, 'master'), { edition: 'master', league: 'MASTER', fromMonth: '2025-02', toMonth: '2025-04' })
  assert.deepEqual(usageRateSelectedMonths({ edition: 'master', league: 'ULTIMATE_MASTER', fromMonth: '2025-02', toMonth: '2025-03' }), ['2025-02', '2025-03'])
  assert.throws(() => usageRateSelectedMonths({ edition: 'master', league: 'ROOKIE', fromMonth: '2025-02', toMonth: '2025-03' }), /league/)
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

test('history loads only the selected edition and verifies source URLs for injected loaders', async () => {
  const general = descriptor()
  const master = masterDescriptor()
  const input = manifest([general, master])
  const requested: UsageRateDatasetDescriptor[] = []
  const loader = async (item: UsageRateDatasetDescriptor) => {
    requested.push(item)
    return usageRateEditionOf(item) === 'master' ? masterDataset() : dataset()
  }
  const common = { league: 'MASTER', fromMonth: general.month, toMonth: general.month }
  const results = await loadUsageRateHistory(input, common, loader)
  const masterResults = await loadUsageRateHistory(input, { ...common, edition: 'master' }, loader)
  assert.deepEqual(requested.map(usageRateEditionOf), ['general', 'master'])
  assert.equal(results[0].status, 'ready')
  assert.equal(masterResults[0].status, 'ready')
  const otherLocale = dataset({ source: { ...dataset().source, url: 'https://www.streetfighter.com/6/buckler/en-us/stats/usagerate' } })
  assert.equal((await loadUsageRateHistory(input, common, async () => otherLocale))[0].status, 'error')
  const wrongEdition = await loadUsageRateHistory(input, { ...common, edition: 'master' }, async () => dataset({ id: master.id }))
  assert.equal(wrongEdition[0].status, 'error')
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

test('source expectations isolate cached requests and evict source mismatches so the same conditions can retry', async (t) => {
  const selected = descriptor({ path: 'source-retry.json' })
  const requests: string[] = []
  let published = dataset({ source: { ...dataset().source, url: 'https://www.streetfighter.com/6/buckler/en-us/stats/usagerate' } })
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    requests.push(String(input))
    return Response.json(published)
  })
  // The compatible API without an expectation may accept another official locale.
  const unscoped = await loadUsageRateDataset(selected, generatedAt)
  assert.equal(unscoped.source.url, published.source.url)
  await assert.rejects(loadUsageRateDataset(selected, generatedAt, USAGE_RATE_SOURCE), /source.url: mismatch/)
  assert.equal(requests.length, 2)
  assert.notEqual(requests[0], requests[1])
  assert.ok(!requests[0].includes('&source='))
  assert.ok(requests[1].includes(`source=${encodeURIComponent(USAGE_RATE_SOURCE.url)}`))
  published = dataset()
  const [left, right] = await Promise.all([
    loadUsageRateDataset(selected, generatedAt, USAGE_RATE_SOURCE),
    loadUsageRateDataset(selected, generatedAt, USAGE_RATE_SOURCE),
  ])
  assert.equal(requests.length, 3)
  assert.equal(requests[1], requests[2])
  assert.strictEqual(left, right)
  assert.equal(left.source.url, USAGE_RATE_SOURCE.url)
  assert.throws(() => loadUsageRateDataset(selected, generatedAt, { ...USAGE_RATE_SOURCE, url: 'https://example.com/usagerate' }), /source.url/)
  assert.equal(requests.length, 3)
})

test('dataset cache isolates editions, checks cached descriptor matches, and supports master source expectations', async (t) => {
  const general = descriptor({ path: 'edition-cache.json' })
  const master = masterDescriptor({ path: general.path })
  const requests: string[] = []
  let published = dataset()
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    requests.push(String(input))
    return Response.json(published)
  })
  const before = await loadUsageRateDataset(general)
  published = masterDataset()
  const after = await loadUsageRateDataset(master)
  assert.equal(requests.length, 2)
  assert.equal(usageRateEditionOf(before), 'general')
  assert.equal(usageRateEditionOf(after), 'master')
  assert.strictEqual(await loadUsageRateDataset(general), before)
  const scoped = await loadUsageRateDataset(master, generatedAt, USAGE_RATE_EDITION_SOURCES.master)
  assert.equal(scoped.source.url, USAGE_RATE_EDITION_SOURCES.master.url)
  await assert.rejects(loadUsageRateDataset({ ...master, id: 'wrong-id' }, generatedAt, USAGE_RATE_EDITION_SOURCES.master), /一致しません.*id/)
  assert.throws(() => loadUsageRateDataset(master, generatedAt, USAGE_RATE_SOURCE), /source.url/)
  const history = await loadUsageRateHistory(manifest([master]), { edition: 'master', league: 'MASTER', fromMonth: master.month, toMonth: master.month })
  assert.equal(history[0].status, 'ready')
  assert.ok(requests.at(-1)!.includes(`source=${encodeURIComponent(USAGE_RATE_EDITION_SOURCES.master.url)}`))
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
  assert.ok(requests.every(url => url.includes(`source=${encodeURIComponent(USAGE_RATE_SOURCE.url)}`)))
})
