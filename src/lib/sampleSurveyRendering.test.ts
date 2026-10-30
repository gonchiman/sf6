import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createElement, type ComponentType } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer, type ViteDevServer } from 'vite'
import type { SampleSurveyRank, SampleSurveyRun, SampleSurveyTarget } from '../types/sampleSurvey.ts'
import type { SampleSurveyInsightDataset, SampleSurveyInsightMetrics, SampleSurveyInsightTheme } from '../types/sampleSurveyInsights.ts'
import { parseSampleSurveyResultsRun } from './sampleSurveyResults.ts'
import { SAMPLE_SURVEY_MR_BANDS } from './sampleSurvey.ts'

type ResultProps = { run: SampleSurveyRun; source: SampleSurveyTarget }
let server: ViteDevServer
let InsightResults: ComponentType<ResultProps & { theme: SampleSurveyInsightTheme }>
let RatingResults: ComponentType<ResultProps>
let Quality: ComponentType<ResultProps>

before(async () => {
  // Do not load the application Vite config: it starts local acquisition services.
  server = await createServer({ root: fileURLToPath(new URL('../../', import.meta.url)), configFile: false,
    server: { middlewareMode: true, watch: null }, appType: 'custom', logLevel: 'error', optimizeDeps: { noDiscovery: true, include: [] } })
  InsightResults = (await server.ssrLoadModule('/src/components/SampleSurveyInsightResults.tsx')).SampleSurveyInsightResults
  RatingResults = (await server.ssrLoadModule('/src/components/SampleSurveyRatingResults.tsx')).SampleSurveyRatingResults
  Quality = (await server.ssrLoadModule('/src/components/SampleSurveyQuality.tsx')).SampleSurveyQuality
})
after(async () => { await server?.close() })

function legacyRun(ranks: SampleSurveyRank[] = ['MASTER']): SampleSurveyRun {
  return { schemaVersion: 1, id: 'survey-render-fixture', planId: 'plan-render-fixture',
    config: { ranks, rankSampleSize: 10, includeMr: false, mrSampleSize: 10, maxDurationMinutes: 10 },
    state: 'complete', phase: 'complete', startedAt: '2026-10-20T01:00:00.000Z', updatedAt: '2026-10-20T01:05:00.000Z',
    finishedAt: '2026-10-20T01:05:00.000Z', elapsedMs: 300000, attempts: 4, successfulPages: 4, uniqueAccountCount: ranks.length * 3,
    strata: ranks.map(rank => ({ id: `lp-${rank}`, label: rank, target: 'lp', requested: 10, population: 3, selected: 3,
      processed: 3, succeeded: 3, missing: 0, duplicates: 0, mean: rank === 'MASTER' ? 25000 : 0,
      min: rank === 'MASTER' ? 24900 : 0, max: rank === 'MASTER' ? 25100 : 0 })),
    frameChanged: false, stopReason: null, resumeAllowed: false }
}
function tolerantRun(mode: 'exact' | 'approximate'): SampleSurveyRun {
  const run = legacyRun(), start = mode === 'exact' ? 10000 : 10004, end = mode === 'exact' ? 20000 : 19998
  run.schemaVersion = 2; run.uniqueAccountCount = 10; run.frameChanged = mode === 'approximate'
  Object.assign(run.strata[0], { population: end - start, selected: 10, processed: 10, succeeded: 10 })
  run.observation = { method: 'rank-position-tolerant-v1', omittedChanges: 0, changes: [],
    strata: [{ id: 'lp-MASTER', status: mode === 'exact' ? 'checked' : 'review-required', startedAt: run.startedAt, finishedAt: run.finishedAt,
      totalCountBefore: 30000, totalCountAfter: 30000, startBefore: start, endBefore: end, startAfter: start, endAfter: end,
      boundaryChanged: mode === 'approximate', boundaryAcceptance: { mode, referenceStart: 10000, referenceEnd: 20000,
        referenceCheckedAt: '2026-10-20T01:01:00.000Z', start, end,
        startObservedAt: '2026-10-20T01:01:10.000Z', endObservedAt: '2026-10-20T01:01:20.000Z' } }] }
  return run
}
function dataset(theme: SampleSurveyInsightTheme, metrics: SampleSurveyInsightMetrics): SampleSurveyInsightDataset {
  const period = theme === 'battle' ? { kind: 'last-100' } as const : theme === 'recent' ? { kind: 'recent-10' } as const
    : theme === 'attributes' ? { kind: 'capture' } as const : { kind: 'act', act: 10 } as const
  return { theme, target: 'lp', period, mode: theme === 'battle' || theme === 'attributes' ? null : theme === 'recent' ? 'all' : 'rank',
    capturedAt: { start: '2026-10-20T01:01:00.000Z', end: '2026-10-20T01:04:00.000Z' },
    coverage: [{ stratumId: 'lp-MASTER', attemptedAccounts: 3, validAccounts: 3, failedAccounts: 0 }],
    rows: [{ stratumId: 'lp-MASTER', validAccounts: 3, ...(theme === 'character' || theme === 'matchup' ? { characterId: 'ryu' } : {}),
      ...(theme === 'matchup' ? { opponentCharacterId: 'ken' } : {}), metrics }] }
}
function withDataset(value: SampleSurveyInsightDataset, run = legacyRun()): SampleSurveyRun {
  return parseSampleSurveyResultsRun({ ...run, insights: { schemaVersion: 1, datasets: [value] } })
}
function renderInsight(run: SampleSurveyRun, theme: SampleSurveyInsightTheme, source: SampleSurveyTarget = 'lp') {
  return renderToStaticMarkup(createElement(InsightResults, { run, theme, source }))
}
function visibleText(html: string): string { return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() }

test('legacy rating aggregates render LP values, genuine zero and accessible comparisons without requiring insights', () => {
  const run = parseSampleSurveyResultsRun(legacyRun(['ROOKIE', 'MASTER']))
  const html = renderToStaticMarkup(createElement(RatingResults, { run, source: 'lp' }))
  assert.match(html, /aria-label="LPの標本集計表"/)
  assert.match(visibleText(html), /ROOKIE 3 0 0 0/)
  assert.match(visibleText(html), /MASTER 3 25,000 24,900 25,100/)
  assert.match(html, /aria-label="ROOKIE：0LP"/)
  assert.match(html, /aria-label="MASTER：25,000LP"/)
  assert.doesNotMatch(html, /NaN|Infinity|undefined/)
})

test('each uncollected theme is explicitly missing and has no invented table or graph', () => {
  const run = parseSampleSurveyResultsRun(legacyRun())
  for (const theme of ['activity', 'character', 'matchup', 'battle', 'recent', 'attributes'] as const) {
    const html = renderInsight(run, theme)
    assert.match(html, /role="status">未取得<\/p>/)
    assert.doesNotMatch(html, /<table|<figure/)
  }
  const absent = renderInsight(run, 'activity', 'mr')
  assert.match(absent, /この取得日は調査対象なし/)
  assert.doesNotMatch(absent, /<table|<figure/)
  const rating = renderToStaticMarkup(createElement(RatingResults, { run, source: 'mr' }))
  assert.match(rating, /この取得日は調査対象なし/)
  assert.doesNotMatch(rating, /<table|<figure/)
})

test('MR rating results remain separate from LP ranks and empty strata do not become zero MR', () => {
  const run = legacyRun(); run.config.includeMr = true; run.uniqueAccountCount += 3
  run.strata.push(...SAMPLE_SURVEY_MR_BANDS.map(band => ({ id: band.id, label: band.label, target: 'mr' as const, requested: 10,
    population: band.id === 'mr-1400-1599' ? 3 : 0, selected: band.id === 'mr-1400-1599' ? 3 : 0,
    processed: band.id === 'mr-1400-1599' ? 3 : 0, succeeded: band.id === 'mr-1400-1599' ? 3 : 0, missing: 0, duplicates: 0,
    mean: band.id === 'mr-1400-1599' ? 1500 : null, min: band.id === 'mr-1400-1599' ? 1450 : null, max: band.id === 'mr-1400-1599' ? 1550 : null })))
  const html = renderToStaticMarkup(createElement(RatingResults, { run: parseSampleSurveyResultsRun(run), source: 'mr' }))
  assert.match(html, /aria-label="MRの標本集計表"/)
  assert.match(visibleText(html), /1400〜1599 3 1,500 1,450 1,550/)
  assert.match(html, /aria-label="1200未満：算出不可"/)
  assert.doesNotMatch(html, /MASTER|25,000|1200未満：0MR/)
})

test('observed zero, zero-denominator missing cells and failed/untouched strata remain visually distinct', () => {
  const run = legacyRun(['ROOKIE', 'IRON', 'BRONZE', 'MASTER'])
  const data = dataset('activity', {})
  data.coverage = [
    { stratumId: 'lp-ROOKIE', attemptedAccounts: 3, validAccounts: 3, failedAccounts: 0 },
    { stratumId: 'lp-IRON', attemptedAccounts: 3, validAccounts: 3, failedAccounts: 0 },
    { stratumId: 'lp-BRONZE', attemptedAccounts: 3, validAccounts: 0, failedAccounts: 3 },
  ]
  data.rows = [
    { stratumId: 'lp-ROOKIE', validAccounts: 3, metrics: { activeShare: { kind: 'ratio', n: 3, numerator: 0, denominator: 3 } } },
    { stratumId: 'lp-IRON', validAccounts: 3, metrics: { activeShare: { kind: 'ratio', n: 0, numerator: 0, denominator: 0 } } },
  ]
  const html = renderInsight(withDataset(data, run), 'activity')
  assert.match(visibleText(html), /ROOKIE 0 0 \/ 3 · n=3/)
  assert.match(visibleText(html), /IRON 算出不可 0 \/ 0 · n=0/)
  assert.match(visibleText(html), /BRONZE 取得失敗 MASTER 未取得/)
  for (const label of ['ROOKIE：0%', 'IRON：算出不可', 'BRONZE：取得失敗', 'MASTER：未取得']) assert.ok(html.includes(`aria-label="${label}"`))
  assert.equal((html.match(/class="sample-survey-bars-fill"/g) ?? []).length, 1)
  assert.doesNotMatch(html, /NaN|Infinity/)
})

test('an entirely failed attempt is not presented as an empty successful result', () => {
  const data = dataset('activity', {})
  data.coverage[0] = { stratumId: 'lp-MASTER', attemptedAccounts: 3, validAccounts: 0, failedAccounts: 3 }; data.rows = []
  const html = renderInsight(withDataset(data), 'activity')
  assert.match(html, /role="status">取得失敗<\/p>/)
  assert.match(visibleText(html), /取得失敗 · 有効 0件/)
  assert.doesNotMatch(html, /<table|<figure/)
})

test('all additional themes render validated aggregate values with conditions and contributing account counts', () => {
  const fixtures: Array<{ data: SampleSurveyInsightDataset; expected: RegExp[] }> = [
    { data: dataset('activity', { activeShare: { kind: 'ratio', n: 3, numerator: 1, denominator: 3 }, meanBattles: { kind: 'mean', n: 1, total: 2 } }),
      expected: [/活動・使用状況/, /Act 10 · ランクマッチ/, /33\.3 1 \/ 3 · n=3/, /2 n=1/] },
    { data: dataset('character', { userShare: { kind: 'ratio', n: 3, numerator: 2, denominator: 3 }, wins: { kind: 'count', n: 2, count: 5 },
      battles: { kind: 'count', n: 2, count: 8 }, winRate: { kind: 'ratio', n: 2, numerator: 5, denominator: 8 } }),
      expected: [/キャラ/, /ryu/, /66\.7 2 \/ 3 · n=3/, /62\.5 5 \/ 8 · n=2/] },
    { data: dataset('matchup', { battles: { kind: 'count', n: 2, count: 20 }, medianWinRate: { kind: 'median', n: 2, value: 55 } }),
      expected: [/相手キャラ/, /使用キャラ/, /ken/, /20 n=2/, /55 n=2/, /1戦以上あるアカウントの掲載勝率中央値/] },
    { data: dataset('battle', { driveParryShare: { kind: 'mean', n: 3, total: 90 } }),
      expected: [/ドライブパリィのゲージ割合/, /各アカウントの過去100戦/, /30 n=3/] },
    { data: dataset('recent', { records: { kind: 'count', n: 3, count: 25 }, classicRecords: { kind: 'count', n: 3, count: 18 },
      modernRecords: { kind: 'count', n: 3, count: 5 }, unknownRecords: { kind: 'count', n: 3, count: 2 },
      modernShare: { kind: 'ratio', n: 3, numerator: 5, denominator: 23 } }),
      expected: [/直近最大10件 \/ アカウント/, /21\.7 5 \/ 23 · n=3/, /同じ試合の重複を含む/] },
    { data: dataset('attributes', { meanPlayPoints: { kind: 'mean', n: 2, total: 500 } }),
      expected: [/平均プレイポイント/, /取得時点/, /250 n=2/] },
  ]
  for (const { data, expected } of fixtures) {
    const html = renderInsight(withDataset(data), data.theme), text = visibleText(html)
    for (const expression of expected) assert.match(text, expression)
    assert.match(html, /<table/); assert.match(html, /<figure/)
    assert.match(text, /n：指標ごとの有効アカウント数/)
    assert.doesNotMatch(html, /NaN|Infinity|undefined/)
  }
})

test('captured character ratings and categorical profile summaries use their own grouping and units', () => {
  const character = dataset('character', { medianLp: { kind: 'median', n: 3, value: 26000 }, medianMr: { kind: 'median', n: 2, value: 1510 } })
  character.period = { kind: 'capture' }; character.mode = null
  const ratings = renderInsight(withDataset(character), 'character')
  assert.match(visibleText(ratings), /26,000 n=3 1,510 n=2/)
  assert.match(visibleText(ratings), /MR：掲載値があるアカウントのみ/)
  const attributes = dataset('attributes', { categoryShare: { kind: 'ratio', n: 3, numerator: 2, denominator: 3 } })
  attributes.rows[0].category = 'region-jp'
  const categories = renderInsight(withDataset(attributes), 'attributes')
  assert.match(visibleText(categories), /設定地域/)
  assert.match(visibleText(categories), /日本 66\.7 2 \/ 3 · n=3/)
  assert.match(categories, /aria-label="日本：66\.7%"/)
})

test('quality keeps legacy/interval boundary evidence and independent acquisition coverage visible', () => {
  const legacy = renderToStaticMarkup(createElement(Quality, { run: legacyRun(), source: 'lp' }))
  assert.match(visibleText(legacy), /層別抽出（旧形式）/)
  assert.match(visibleText(legacy), /母集団への推定 未実施/)
  assert.match(visibleText(legacy), /追加データの取得状況 未取得/)
  assert.doesNotMatch(legacy, /掲載位置の境界|初期観測|近似採用/)
  const data = dataset('activity', { activeShare: { kind: 'ratio', n: 2, numerator: 1, denominator: 2 } })
  data.coverage[0].validAccounts = 2; data.coverage[0].failedAccounts = 1; data.rows[0].validAccounts = 2
  const run = withDataset(data); run.schemaVersion = 2; run.frameChanged = true
  run.observation = { method: 'rank-position-interval-v1', omittedChanges: 0,
    strata: [{ id: 'lp-MASTER', status: 'review-required', startedAt: run.startedAt, finishedAt: run.finishedAt,
      totalCountBefore: 3, totalCountAfter: 4, startBefore: 0, endBefore: 3, startAfter: 0, endAfter: 4, boundaryChanged: true }],
    changes: [{ kind: 'total-count', target: 'lp', stratumId: 'lp-MASTER', at: run.finishedAt!, before: 3, after: 4 }] }
  const html = renderToStaticMarkup(createElement(Quality, { run: parseSampleSurveyResultsRun(run), source: 'lp' }))
  assert.match(visibleText(html), /観測期間内の順位枠抽出/)
  assert.match(visibleText(html), /要確認 3 → 4/)
  assert.match(visibleText(html), /掲載総数の変化：あり/)
  assert.match(visibleText(html), /MASTER 3 2 1 一部欠測/)
  assert.match(html, /aria-label="追加データの条件別取得状況"/)
  assert.doesNotMatch(html, /掲載位置の境界|初期観測|近似採用/)
})

test('tolerant quality exposes approximate adopted cuts, signed movement and separate observation times', () => {
  const run = parseSampleSurveyResultsRun(tolerantRun('approximate'))
  const html = renderToStaticMarkup(createElement(Quality, { run, source: 'lp' })), text = visibleText(html)
  assert.match(text, /近似採用・要確認/)
  assert.match(text, /掲載位置の境界（0起点） 初期 → 採用（差）/)
  assert.match(text, /開始：10,000 → 10,004（差 \+4）/)
  assert.match(text, /終了：20,000 → 19,998（差 -2）/)
  assert.match(text, /抽出区間幅：9,994枠/)
  assert.match(text, /移動量合計：6位置 · 許容：10位置/)
  assert.match(text, /各端20位置・合計は初期区間幅の0\.1％（切捨て）/)
  for (const [label, iso, clock] of [
    ['初期観測', '2026-10-20T01:01:00.000Z', '10:01:00'],
    ['開始観測', '2026-10-20T01:01:10.000Z', '10:01:10'],
    ['終了観測', '2026-10-20T01:01:20.000Z', '10:01:20'],
  ]) {
    assert.ok(html.includes(`${label}：<time dateTime="${iso}">`))
    assert.ok(text.includes(`${clock} JST`))
  }
  assert.match(text, /母集団への推定 未実施/)
  assert.doesNotMatch(html, /NaN|Infinity|undefined|確認不能/)
  const otherSeries = renderToStaticMarkup(createElement(Quality, { run, source: 'mr' }))
  assert.doesNotMatch(otherSeries, /近似採用・要確認|10,004|19,998/)
})

test('exact adoption and a verified empty range are distinct from unavailable boundary evidence', () => {
  const exact = parseSampleSurveyResultsRun(tolerantRun('exact'))
  const html = renderToStaticMarkup(createElement(Quality, { run: exact, source: 'lp' })), text = visibleText(html)
  assert.match(text, /前後一致/); assert.match(text, /採用：一致 · 抽出区間幅：10,000枠/)
  assert.match(text, /移動量合計：0位置 · 許容：10位置/)
  assert.doesNotMatch(text, /近似採用|未採用|確認不能/)

  const empty = tolerantRun('exact'), observed = empty.observation!.strata[0]
  empty.uniqueAccountCount = 0
  Object.assign(empty.strata[0], { population: 0, selected: 0, processed: 0, succeeded: 0, mean: null, min: null, max: null })
  Object.assign(observed, { startBefore: 0, endBefore: 0, startAfter: 0, endAfter: 0 })
  Object.assign(observed.boundaryAcceptance!, { referenceStart: 0, referenceEnd: 0, start: 0, end: 0 })
  const emptyHtml = renderToStaticMarkup(createElement(Quality, { run: parseSampleSurveyResultsRun(empty), source: 'lp' }))
  assert.match(visibleText(emptyHtml), /採用：一致 · 抽出区間幅：0枠/)
  assert.doesNotMatch(emptyHtml, /未取得・確認不能|未採用/)

  const unknown = tolerantRun('exact'), unavailable = unknown.observation!.strata[0]
  unknown.uniqueAccountCount = 0
  Object.assign(unknown.strata[0], { population: null, selected: 0, processed: 0, succeeded: 0, mean: null, min: null, max: null })
  Object.assign(unavailable, { status: 'review-required', startBefore: null, endBefore: null, startAfter: null, endAfter: null })
  delete unavailable.boundaryAcceptance
  const unknownHtml = renderToStaticMarkup(createElement(Quality, { run: parseSampleSurveyResultsRun(unknown), source: 'lp' }))
  assert.match(visibleText(unknownHtml), /10 — — — — 未取得・確認不能/)
  assert.match(visibleText(unknownHtml), /未採用/)
  assert.doesNotMatch(unknownHtml, /抽出区間幅：0|採用：一致|近似採用|初期観測/)
})

test('displayed total movement allowance also respects the per-boundary cap for large strata', () => {
  const run = tolerantRun('approximate'), observed = run.observation!.strata[0]
  run.strata[0].population = 99960
  Object.assign(observed, { totalCountBefore: 300000, totalCountAfter: 300000,
    startBefore: 100020, endBefore: 199980, startAfter: 100020, endAfter: 199980 })
  Object.assign(observed.boundaryAcceptance!, { referenceStart: 100000, referenceEnd: 200000, start: 100020, end: 199980 })
  const html = renderToStaticMarkup(createElement(Quality, { run: parseSampleSurveyResultsRun(run), source: 'lp' }))
  assert.match(visibleText(html), /移動量合計：40位置 · 許容：40位置/)
  assert.doesNotMatch(visibleText(html), /許容：100位置/)
})
