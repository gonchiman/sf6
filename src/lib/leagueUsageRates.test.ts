import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { LeagueUsageRateMetadata, LeagueUsageRatePoint, LeagueUsageRateRow } from '../types/leagueUsageRates.ts'
import type { UsageRateDataset, UsageRateDatasetDescriptor, UsageRateEntry, UsageRateManifest } from '../types/usageRates.ts'
import {
  createLeagueUsageRates, formatLeagueUsageRatePoint, leagueUsageRateComparisonKey, loadLeagueUsageRates, selectLeagueUsageRateConditions,
  sortLeagueUsageRateRows, USAGE_RATE_LEAGUES,
} from './leagueUsageRates.ts'
import { loadUsageRateHistory, USAGE_RATE_EDITION_SOURCES, USAGE_RATE_SOURCE, usageRatePercentThousandths } from './usageRates.ts'

const capturedAt = '2026-10-09T05:00:00.000Z'
const generatedAt = '2026-10-09T06:00:00.000Z'

function descriptor(league = 'ALL', overrides: Partial<UsageRateDatasetDescriptor> = {}): UsageRateDatasetDescriptor {
  return { id: `2026-09-${league.toLowerCase()}`, month: '2026-09', league, path: `2026-09-${league.toLowerCase()}.json`, capturedAt, ...overrides }
}

function entry(characterId: string, text: string, name = characterId.toUpperCase()): UsageRateEntry {
  return { characterId, name, text, percentThousandths: usageRatePercentThousandths(text) }
}

function dataset(selected = descriptor()): UsageRateDataset {
  return {
    schemaVersion: 1, id: selected.id, month: selected.month, league: selected.league, capturedAt: selected.capturedAt, generatedAt,
    source: { ...USAGE_RATE_SOURCE, population: 'ランクマッチ', metric: 'キャラクター使用率', unit: '公開された割合（%）', notes: ['分母の詳細は未確認'] },
    distributions: [
      { controlType: 'all', month: selected.month, league: selected.league, entries: [entry('ryu', '9.739'), entry('ken', '90.261')] },
      { controlType: 'classic', month: selected.month, league: selected.league, entries: [entry('ryu', '0.000'), entry('ken', '100.000%')] },
      { controlType: 'modern', month: selected.month, league: selected.league, entries: [entry('ken', '90.433'), entry('ryu', '9.567')] },
    ],
  }
}

function manifest(descriptors = [descriptor()]): UsageRateManifest {
  return { schemaVersion: 1, generatedAt, source: USAGE_RATE_SOURCE, datasets: descriptors }
}

function masterDescriptor(league = 'MASTER'): UsageRateDatasetDescriptor {
  return descriptor(league, { edition: 'master', id: `2026-09-master-${league.toLowerCase()}`, path: `2026-09-master-${league.toLowerCase()}.json` })
}

function masterDataset(selected = masterDescriptor()): UsageRateDataset {
  const input = dataset(selected)
  return { ...input, edition: 'master', source: { ...input.source, ...USAGE_RATE_EDITION_SOURCES.master }, distributions: [input.distributions[0]] }
}

function ready(input: UsageRateDataset): LeagueUsageRateMetadata {
  return { league: input.league, status: 'ready', dataset: input }
}

function selectedPoint(data: ReturnType<typeof createLeagueUsageRates>, characterId = 'ryu', league = 'ALL', controlType: LeagueUsageRateRow['controlType'] = null): LeagueUsageRatePoint {
  return data.rows.find(row => row.characterId === characterId && row.controlType === controlType)!.values[data.leagues.indexOf(league)]
}

test('published usage percentages retain thousandths and original precision without win-rate scaling or normalization', () => {
  const input = dataset()
  const before = structuredClone(input)
  const output = createLeagueUsageRates(manifest(), { month: '2026-09', operationMode: 'combined' }, [ready(input)])
  assert.deepEqual(output.leagues, ['ALL', 'ROOKIE', 'IRON', 'BRONZE', 'SILVER', 'GOLD', 'PLATINUM', 'DIAMOND', 'MASTER'])
  assert.equal(selectedPoint(output).percentThousandths, 9739)
  assert.equal(formatLeagueUsageRatePoint(selectedPoint(output)), '9.739%')
  assert.equal(output.rows[0].key, 'ryu:combined')
  assert.equal(output.rows[0].controlType, null)
  assert.deepEqual(input, before)
})

test('Classic and Modern project from the same file by stable character ID, regardless of entry order or display name', () => {
  const input = dataset()
  input.distributions[2].entries[1].name = 'リュウ'
  input.distributions.reverse()
  const output = createLeagueUsageRates(manifest(), { month: '2026-09', operationMode: 'separate' }, [ready(input)])
  assert.deepEqual(output.rows.map(row => row.key), ['ryu:classic', 'ryu:modern', 'ken:classic', 'ken:modern'])
  assert.equal(selectedPoint(output, 'ryu', 'ALL', 'classic').percentThousandths, 0)
  assert.equal(formatLeagueUsageRatePoint(selectedPoint(output, 'ryu', 'ALL', 'classic')), '0.000%')
  assert.equal(selectedPoint(output, 'ryu', 'ALL', 'modern').percentThousandths, 9567)
  assert.equal(formatLeagueUsageRatePoint(selectedPoint(output, 'ken', 'ALL', 'classic')), '100.000%')
  assert.equal(output.rows[1].name, 'RYU')
})

test('the roster is the union of validated league files; ALL remains its own published distribution', () => {
  const all = dataset()
  const masterDescriptor = descriptor('MASTER')
  const master = dataset(masterDescriptor)
  for (const distribution of master.distributions) {
    distribution.entries = [entry('chunli', '25.000'), entry('ken', '70.000'), entry('ryu', '5.000', 'リュウ')]
  }
  const output = createLeagueUsageRates(manifest([descriptor(), masterDescriptor]), { month: '2026-09', operationMode: 'combined' }, [ready(master), ready(all)])
  assert.deepEqual(output.rows.map(row => row.characterId), ['ryu', 'ken', 'chunli'])
  assert.equal(selectedPoint(output, 'ryu', 'ALL').percentThousandths, 9739)
  assert.equal(selectedPoint(output, 'ryu', 'MASTER').percentThousandths, 5000)
  assert.equal(selectedPoint(output, 'chunli', 'ALL').status, 'unlisted')
  assert.equal(formatLeagueUsageRatePoint(selectedPoint(output, 'chunli', 'ALL')), '未掲載')
  assert.equal(output.rows[0].name, 'RYU')
})

test('the roster includes characters published only in an operation distribution and never zero-fills omitted entries', () => {
  const input = dataset()
  input.distributions[1].entries = [entry('ken', '75.000'), entry('blanka', '25.000')]
  input.distributions[2].entries = [entry('ken', '100.000')]
  const combined = createLeagueUsageRates(manifest(), { month: '2026-09', operationMode: 'combined' }, [ready(input)])
  assert.deepEqual(combined.rows.map(row => row.characterId), ['ryu', 'ken', 'blanka'])
  assert.equal(selectedPoint(combined, 'blanka').status, 'unlisted')
  assert.equal(selectedPoint(combined, 'blanka').percentThousandths, null)
  const separate = createLeagueUsageRates(manifest(), { month: '2026-09', operationMode: 'separate' }, [ready(input)])
  assert.equal(selectedPoint(separate, 'blanka', 'ALL', 'classic').percentThousandths, 25000)
  assert.equal(selectedPoint(separate, 'blanka', 'ALL', 'modern').status, 'unlisted')
  assert.equal(selectedPoint(separate, 'ryu', 'ALL', 'modern').status, 'unlisted')
  assert.equal(formatLeagueUsageRatePoint(selectedPoint(separate, 'ryu', 'ALL', 'modern')), '未掲載')
})

test('general and master editions keep overlapping MASTER conditions, source URLs and ranks separate', () => {
  const general = descriptor('MASTER')
  const master = masterDescriptor()
  const publication = manifest([general, master])
  const generalData = dataset(general)
  const masterData = masterDataset(master)
  masterData.distributions[0].entries = [entry('ryu', '80.000'), entry('ken', '20.000')]
  const generalOutput = createLeagueUsageRates(publication, { month: '2026-09', operationMode: 'combined' }, [ready(generalData)])
  const masterOutput = createLeagueUsageRates(publication, { edition: 'master', month: '2026-09', operationMode: 'combined' }, [ready(masterData)])
  assert.deepEqual(masterOutput.leagues, ['MASTER', 'HIGH_MASTER', 'GRAND_MASTER', 'ULTIMATE_MASTER'])
  assert.equal(selectedPoint(generalOutput, 'ryu', 'MASTER').percentThousandths, 9739)
  assert.equal(selectedPoint(masterOutput, 'ryu', 'MASTER').percentThousandths, 80000)
  assert.equal(masterOutput.metadata[0].dataset?.source.url, USAGE_RATE_EDITION_SOURCES.master.url)
  const stale = createLeagueUsageRates(publication, { edition: 'master', month: '2026-09', operationMode: 'combined' }, [ready(generalData)])
  assert.equal(stale.metadata[0].status, 'error')
  assert.deepEqual(stale.rows, [])
  const wrongSource = structuredClone(masterData)
  wrongSource.source.url = USAGE_RATE_SOURCE.url
  const rejected = createLeagueUsageRates(publication, { edition: 'master', month: '2026-09', operationMode: 'combined' }, [ready(wrongSource)])
  assert.equal(rejected.metadata[0].status, 'error')
  assert.deepEqual(rejected.rows, [])
  assert.throws(() => createLeagueUsageRates(publication, { edition: 'master', month: '2026-09', operationMode: 'separate' }, []), /操作タイプ/)
})

test('edition changes resolve unsupported months and modes before display and cannot reuse the previous edition request key', () => {
  const older = descriptor('ALL', { id: '2023-06-all', month: '2023-06', path: '2023-06-all.json' })
  const masterOlder = { ...masterDescriptor(), id: '2025-02-master', month: '2025-02', path: '2025-02-master.json' }
  const publication = manifest([older, descriptor(), masterOlder, masterDescriptor()])
  const initial = selectLeagueUsageRateConditions(publication)
  assert.deepEqual(initial, { edition: 'general', month: '2026-09', operationMode: 'combined' })
  const general = selectLeagueUsageRateConditions(publication, { edition: 'general', month: '2023-06', operationMode: 'separate' })!
  assert.deepEqual(general, { edition: 'general', month: '2023-06', operationMode: 'separate' })
  const switched = selectLeagueUsageRateConditions(publication, { ...general, edition: 'master' })!
  assert.deepEqual(switched, { edition: 'master', month: '2026-09', operationMode: 'combined' })
  assert.deepEqual(selectLeagueUsageRateConditions(publication, { ...switched, month: '2025-02' }),
    { edition: 'master', month: '2025-02', operationMode: 'combined' })
  const latestGeneral = selectLeagueUsageRateConditions(publication, { month: '2026-09' })!
  assert.notEqual(leagueUsageRateComparisonKey(publication, latestGeneral), leagueUsageRateComparisonKey(publication, switched))
  assert.equal(leagueUsageRateComparisonKey(publication, latestGeneral),
    leagueUsageRateComparisonKey(publication, { ...latestGeneral, operationMode: 'separate' }))
  assert.notEqual(leagueUsageRateComparisonKey(publication, initial!), leagueUsageRateComparisonKey(publication, general))
  assert.deepEqual(selectLeagueUsageRateConditions(manifest([masterDescriptor()])),
    { edition: 'master', month: '2026-09', operationMode: 'combined' })
})

test('zero, published missing markers, unregistered ranks and known load failures never collapse to the same value', () => {
  const input = dataset()
  input.distributions[0].entries[0] = entry('ryu', '-')
  input.distributions[2].entries[1] = entry('ryu', '-.---')
  const registered = manifest([descriptor(), descriptor('ROOKIE')])
  const metadata: LeagueUsageRateMetadata[] = [ready(input), { league: 'ROOKIE', status: 'error' }]
  const combined = createLeagueUsageRates(registered, { month: '2026-09', operationMode: 'combined' }, metadata)
  assert.equal(selectedPoint(combined).status, 'missing')
  assert.equal(selectedPoint(combined).percentThousandths, null)
  assert.equal(formatLeagueUsageRatePoint(selectedPoint(combined)), '-')
  assert.equal(selectedPoint(combined, 'ryu', 'ROOKIE').status, 'error')
  assert.equal(formatLeagueUsageRatePoint(selectedPoint(combined, 'ryu', 'ROOKIE')), '読込失敗')
  assert.equal(selectedPoint(combined, 'ryu', 'BRONZE').status, 'unavailable')
  assert.equal(formatLeagueUsageRatePoint(selectedPoint(combined, 'ryu', 'BRONZE')), '未登録')
  assert.equal(formatLeagueUsageRatePoint(undefined), '未登録')
  const separate = createLeagueUsageRates(registered, { month: '2026-09', operationMode: 'separate' }, metadata)
  assert.equal(selectedPoint(separate, 'ryu', 'ALL', 'classic').status, 'value')
  assert.equal(selectedPoint(separate, 'ryu', 'ALL', 'classic').percentThousandths, 0)
  assert.equal(formatLeagueUsageRatePoint(selectedPoint(separate, 'ryu', 'ALL', 'modern')), '-.---')
})

test('wrong month, league, ID, capture time, source and malformed whole datasets cannot contribute values or roster IDs', () => {
  const corruptions: ((value: UsageRateDataset) => void)[] = [
    value => { value.month = '2026-08' },
    value => { value.league = 'MASTER' },
    value => { value.id = 'other' },
    value => { value.capturedAt = '2026-10-08T00:00:00Z' },
    value => { value.source.url = 'https://www.streetfighter.com/6/buckler/en-us/stats/usagerate' },
    value => { value.source.url = 'https://www.streetfighter.com/6/buckler/ja-jp/stats/dia' },
    value => { value.distributions = [] },
    value => { value.distributions[1].entries[0].percentThousandths = 1 },
  ]
  for (const corrupt of corruptions) {
    const input = dataset()
    corrupt(input)
    const output = createLeagueUsageRates(manifest(), { month: '2026-09', operationMode: 'combined' }, [{ league: 'ALL', status: 'ready', dataset: input }])
    assert.equal(output.metadata[0].status, 'error')
    assert.equal(output.metadata[0].dataset, undefined)
    assert.deepEqual(output.rows, [])
  }
})

test('unregistered and duplicate metadata cannot inject characters; unknown conditions are not accepted', () => {
  const unknown = dataset(descriptor('MASTER'))
  for (const distribution of unknown.distributions) distribution.entries = [entry('poison', '100.000')]
  const input = dataset()
  const output = createLeagueUsageRates(manifest(), { month: '2026-09', operationMode: 'combined' }, [ready(input), ready(unknown)])
  assert.deepEqual(output.rows.map(row => row.characterId), ['ryu', 'ken'])
  assert.equal(output.metadata.at(-1)!.status, 'unavailable')
  const duplicate = createLeagueUsageRates(manifest(), { month: '2026-09', operationMode: 'combined' }, [ready(input), ready(input)])
  assert.equal(duplicate.metadata[0].status, 'error')
  assert.deepEqual(duplicate.rows, [])
  const notRegisteredMonth = createLeagueUsageRates(manifest(), { month: '2026-08', operationMode: 'combined' }, [ready(input)])
  assert.ok(notRegisteredMonth.metadata.every(item => item.status === 'unavailable'))
  assert.deepEqual(notRegisteredMonth.rows, [])
  assert.throws(() => createLeagueUsageRates(manifest(), { month: '2026-13', operationMode: 'combined' }, []), /対象月/)
  assert.throws(() => createLeagueUsageRates(manifest(), { month: '2026-09', operationMode: 'unknown' } as never, []), /操作タイプ/)
})

test('sorting uses unrounded raw values, retains official tie order, puts every missing state last and never mutates input', () => {
  const statuses: LeagueUsageRatePoint['status'][] = ['missing', 'unlisted', 'unavailable', 'error']
  const values: (number | null)[] = [1001, 1000, 0, 1001, NaN, ...statuses.map(() => null)]
  const rows: LeagueUsageRateRow[] = values.map((value, index) => ({
    key: `${index}`, characterId: `${index}`, name: `${index}`, controlType: null,
    values: [{ status: index >= 5 ? statuses[index - 5] : 'value', entry: null, percentThousandths: value }],
  }))
  const original = [...rows]
  assert.deepEqual(sortLeagueUsageRateRows(rows, ['ALL'], { league: 'ALL', direction: 'ascending' }).map(row => row.key), ['2', '1', '0', '3', '4', '5', '6', '7', '8'])
  assert.deepEqual(sortLeagueUsageRateRows(rows, ['ALL'], { league: 'ALL', direction: 'descending' }).map(row => row.key), ['0', '3', '1', '2', '4', '5', '6', '7', '8'])
  assert.deepEqual(rows, original)
  const restored = sortLeagueUsageRateRows(rows, ['ALL'], { league: null, direction: 'descending' })
  assert.deepEqual(restored, rows)
  assert.notStrictEqual(restored, rows)
  assert.deepEqual(sortLeagueUsageRateRows(rows, ['ALL'], { league: 'MASTER', direction: 'ascending' }), rows)
})

test('loading keeps nine fixed columns, requests only registered selected-month files and distinguishes failures', async () => {
  const registered = [descriptor(), descriptor('DIAMOND'), descriptor('MASTER'), descriptor('ROOKIE', { id: 'older', month: '2026-08', path: 'older.json' })]
  const requested: string[] = []
  const results = await loadLeagueUsageRates(manifest(registered), '2026-09', async selected => {
    requested.push(selected.league)
    if (selected.league === 'DIAMOND') throw new Error('network')
    if (selected.league === 'MASTER') return dataset(descriptor())
    return dataset(selected)
  })
  assert.deepEqual(requested, ['ALL', 'DIAMOND', 'MASTER'])
  assert.deepEqual(results.map(item => item.league), USAGE_RATE_LEAGUES)
  assert.deepEqual(results.map(item => item.status), ['ready', 'unavailable', 'unavailable', 'unavailable', 'unavailable', 'unavailable', 'unavailable', 'error', 'error'])
  const sourceMismatch = await loadLeagueUsageRates(manifest(), '2026-09', async selected => {
    const input = dataset(selected)
    input.source.url = 'https://www.streetfighter.com/6/buckler/en-us/stats/usagerate'
    return input
  })
  assert.equal(sourceMismatch[0].status, 'error')
})

test('master loading requests only the selected edition and preserves four fixed rank columns', async () => {
  const general = descriptor('MASTER')
  const master = masterDescriptor()
  const high = masterDescriptor('HIGH_MASTER')
  const publication = manifest([general, master, high])
  const requested: string[] = []
  const results = await loadLeagueUsageRates(publication, '2026-09', 'master', async selected => {
    requested.push(selected.id)
    if (selected.league === 'HIGH_MASTER') return dataset(general)
    return masterDataset(selected)
  })
  assert.deepEqual(requested, [master.id, high.id])
  assert.deepEqual(results.map(item => item.league), ['MASTER', 'HIGH_MASTER', 'GRAND_MASTER', 'ULTIMATE_MASTER'])
  assert.deepEqual(results.map(item => item.status), ['ready', 'error', 'unavailable', 'unavailable'])
})

test('registered leagues load with a maximum of four concurrent requests while preserving fixed order', async () => {
  const registered = USAGE_RATE_LEAGUES.map(league => descriptor(league))
  let active = 0
  let maximum = 0
  const results = await loadLeagueUsageRates(manifest(registered), '2026-09', async selected => {
    active += 1
    maximum = Math.max(maximum, active)
    await new Promise(resolve => setTimeout(resolve, selected.league === 'ALL' ? 10 : 2))
    active -= 1
    return dataset(selected)
  })
  assert.equal(maximum, 4)
  assert.equal(active, 0)
  assert.deepEqual(results.map(item => item.league), USAGE_RATE_LEAGUES)
  assert.ok(results.every(item => item.status === 'ready'))
})

test('the default loader reuses successful cached files, includes the publication version and retries failed files', async t => {
  const registered = ['ALL', 'DIAMOND', 'MASTER'].map(league => descriptor(league, { path: `league-usage-cache-${league.toLowerCase()}.json` }))
  const publication = manifest(registered)
  const requests: string[] = []
  let failAll = false
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const url = String(input)
    requests.push(url)
    const selected = registered.find(item => url.includes(item.path))!
    if (failAll && selected.league === 'ALL') return new Response('', { status: 503 })
    return Response.json(dataset(selected))
  })
  const history = await loadUsageRateHistory(publication, { league: 'ALL', fromMonth: '2026-09', toMonth: '2026-09' })
  assert.equal(history[0].status, 'ready')
  assert.equal(requests.length, 1)
  const [left, right] = await Promise.all([loadLeagueUsageRates(publication, '2026-09'), loadLeagueUsageRates(publication, '2026-09')])
  assert.equal(requests.length, 3)
  assert.equal(left[0].status, 'ready')
  assert.equal(right[0].status, 'ready')
  assert.ok(requests.every(url => url.includes(`published=${encodeURIComponent(generatedAt)}`)))
  assert.ok(requests.every(url => url.includes(`source=${encodeURIComponent(USAGE_RATE_SOURCE.url)}`)))
  const newer = { ...publication, generatedAt: '2026-10-09T07:00:00.000Z' }
  failAll = true
  const failed = await loadLeagueUsageRates(newer, '2026-09')
  assert.equal(failed[0].status, 'error')
  assert.equal(requests.length, 6)
  failAll = false
  const retried = await loadLeagueUsageRates(newer, '2026-09')
  assert.equal(retried[0].status, 'ready')
  assert.equal(requests.length, 7)
})

test('the default master loader validates and caches the master source independently of the general MASTER file', async t => {
  const general = descriptor('MASTER', { path: 'edition-general-master-cache.json' })
  const master = { ...masterDescriptor(), path: 'edition-master-master-cache.json' }
  const publication = manifest([general, master])
  const requests: string[] = []
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const url = String(input)
    requests.push(url)
    return Response.json(url.includes(master.path) ? masterDataset(master) : dataset(general))
  })
  const generalResults = await loadLeagueUsageRates(publication, '2026-09')
  const masterResults = await loadLeagueUsageRates(publication, '2026-09', 'master')
  assert.equal(generalResults.at(-1)!.status, 'ready')
  assert.equal(masterResults[0].status, 'ready')
  assert.equal(requests.length, 2)
  assert.ok(requests[0].includes(`source=${encodeURIComponent(USAGE_RATE_SOURCE.url)}`))
  assert.ok(requests[1].includes(`source=${encodeURIComponent(USAGE_RATE_EDITION_SOURCES.master.url)}`))
  const masterAgain = await loadLeagueUsageRates(publication, '2026-09', 'master')
  assert.equal(masterAgain[0].status, 'ready')
  assert.equal(requests.length, 2)
})
