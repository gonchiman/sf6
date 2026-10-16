import assert from 'node:assert/strict'
import test from 'node:test'
import { LEGEND_ANALYSIS_SOURCE } from '../../src/lib/legendAnalysis.ts'
import { collectLegendAnalysisDataset, LegendAnalysisCollectionError } from './legend-analysis-collector.ts'
import type { CollectLegendAnalysisOptions, LegendAnalysisEntry, LegendAnalysisPage } from './legend-analysis-collector.ts'
import { LEGEND_ANALYSIS_CONDITIONS, legendAnalysisPageUrl } from './legend-analysis-dom.ts'

function fixture(rows?: LegendAnalysisEntry[], pageSize = 2) {
  const values = rows ?? Array.from({ length: 4 }, (_, index) => ({ accountKey: (index + 1).toString(16).padStart(64, '0'),
    characterId: index % 2 ? 'ken' : 'ryu', rank: index + 1, masterRating: 2400 - index, isLegend: index < 2 }))
  const requested: number[] = []
  let actChecks = 0
  const options: CollectLegendAnalysisOptions = {
    sourceUrl: LEGEND_ANALYSIS_SOURCE.url, pageUrl: legendAnalysisPageUrl,
    act: { id: 'act-13', label: 'Act 13' }, conditions: { ...LEGEND_ANALYSIS_CONDITIONS }, characterIds: ['ryu', 'ken'],
    characterNames: { ryu: 'リュウ', ken: 'ケン' }, membershipRule: 'official-legend-badge', membershipConfirmed: true,
    now: () => new Date('2026-10-16T00:00:00.000Z'), confirmAct: async () => { actChecks++ },
    fetchPage: async (page, sourceUrl): Promise<LegendAnalysisPage> => {
      requested.push(page)
      return { sourceUrl, page, pageSize, totalCount: values.length, from: (page - 1) * pageSize + 1,
        to: Math.min(page * pageSize, values.length), nextPage: page * pageSize < values.length ? page + 1 : null,
        actId: 'act-13', conditions: { ...LEGEND_ANALYSIS_CONDITIONS }, conditionsConfirmed: true, actConfirmed: true,
        rosterConfirmed: true, entries: structuredClone(values.slice((page - 1) * pageSize, page * pageSize)) }
    },
  }
  return { values, options, requested, actChecks: () => actChecks }
}

test('complete capture aggregates account-character entries and rechecks both endpoints', async () => {
  const data = fixture()
  // A single account may legitimately have different listed characters.
  data.values[1].accountKey = data.values[0].accountKey
  const result = await collectLegendAnalysisDataset(data.options)
  assert.equal(result.dataset.totalCount, 2)
  assert.equal(result.dataset.characters[0].count, 1)
  assert.equal(result.dataset.characters[1].count, 1)
  assert.deepEqual(data.requested, [1, 2, 2, 1])
  assert.equal(data.actChecks(), 1)
  assert.equal(JSON.stringify(result).includes('accountKey'), false)
  assert.equal(JSON.stringify(result).includes(data.values[0].accountKey), false)
})

test('Legend cutoff follows displayed badges across tied rank and page boundaries, without a 500 cap', async () => {
  const rows = Array.from({ length: 520 }, (_, index) => ({ accountKey: (index + 1).toString(16).padStart(64, '0'), characterId: 'ryu',
    rank: index >= 486 && index < 504 ? 487 : index + 1,
    masterRating: index < 486 ? 3000 - index : index < 504 ? 2183 : 2182 - (index - 504), isLegend: index < 504 }))
  const data = fixture(rows, 20)
  const result = await collectLegendAnalysisDataset(data.options)
  assert.equal(result.dataset.totalCount, 504)
  assert.equal(result.dataset.mr.min, 2183)
  assert.equal(result.dataset.characters[1].count, 0)
  assert.equal(result.dataset.characters[1].mr.min, null)
  assert.equal(result.pagesRead, 26)
  assert.equal(result.requestCount, 28)
})

test('same account-character duplicate causes bounded capture retry and failure, never deletion', async () => {
  const data = fixture()
  const retries: number[] = []
  data.options.onRetry = count => { retries.push(count) }
  data.values[1] = { ...data.values[0], rank: 2, masterRating: 2399 }
  await assert.rejects(collectLegendAnalysisDataset(data.options), error => error instanceof LegendAnalysisCollectionError && error.code === 'duplicate-entry')
  assert.deepEqual(data.requested, [1, 1])
  assert.deepEqual(retries, [1])
})

test('changed first page on recheck fails after finite retries', async () => {
  const data = fixture()
  const original = data.options.fetchPage
  let firstReads = 0
  data.options.fetchPage = async (page, url) => {
    const value = await original(page, url)
    if (page === 1 && ++firstReads % 2 === 0) value.entries[0].masterRating++
    return value
  }
  await assert.rejects(collectLegendAnalysisDataset(data.options), error => error instanceof LegendAnalysisCollectionError && error.code === 'source-changed')
  assert.equal(data.requested.length, 8)
})

test('changing global MASTER population does not invalidate an unchanged Legend prefix', async () => {
  const data = fixture(), original = data.options.fetchPage
  let extra = 0
  data.options.fetchPage = async (page, url) => {
    const value = await original(page, url)
    value.totalCount = 800000 + extra++
    value.nextPage = page + 1
    return value
  }
  const result = await collectLegendAnalysisDataset(data.options)
  assert.equal(result.dataset.totalCount, 2)
  assert.equal(result.requestCount, 4)
})

test('missing membership evidence, request limits and cancellation fail closed', async () => {
  const data = fixture()
  await assert.rejects(collectLegendAnalysisDataset({ ...data.options, membershipConfirmed: false }), /evidence-unconfirmed/)
  assert.equal(data.requested.length, 0)
  await assert.rejects(collectLegendAnalysisDataset({ ...data.options, maxRequests: 3 }), /request-limit/)
  const controller = new AbortController(); controller.abort()
  await assert.rejects(collectLegendAnalysisDataset({ ...data.options, signal: controller.signal }), /cancelled/)
})

test('invalid condition, Act, character and reversed ordering are rejected', async () => {
  for (const mutate of [
    (page: LegendAnalysisPage) => { page.conditions.platform = 'different' },
    (page: LegendAnalysisPage) => { page.actId = 'act-12' },
    (page: LegendAnalysisPage) => { page.entries[0].characterId = 'unknown' },
    (page: LegendAnalysisPage) => { page.entries[1].masterRating = 9999 },
    (page: LegendAnalysisPage) => { page.entries[0].isLegend = false },
    (page: LegendAnalysisPage) => { page.nextPage = null },
  ]) {
    const data = fixture(), original = data.options.fetchPage
    data.options.fetchPage = async (page, url) => { const value = await original(page, url); mutate(value); return value }
    await assert.rejects(collectLegendAnalysisDataset(data.options))
  }
})
