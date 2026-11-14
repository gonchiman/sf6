import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createElement, type ComponentType } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer, type ViteDevServer } from 'vite'
import { LEGEND_ANALYSIS_SOURCE, LEGEND_ANALYSIS_VALIDATION_CHECKS } from './legendAnalysis.ts'
import type { LegendPlayerRow, LegendPlayersDataset } from '../types/legendPlayers.ts'
import type { LegendCollectionRun } from './legendCollectionHistory.ts'

let server: ViteDevServer
let Page: ComponentType
let CaptureInfo: ComponentType<import('react').ComponentProps<typeof import('../components/LegendPlayersPage.tsx').LegendPlayersCaptureInfo>>
let MatchSummary: ComponentType<import('react').ComponentProps<typeof import('../components/LegendPlayersPage.tsx').LegendPlayersMatchSummary>>
let Table: ComponentType<{ rows: readonly LegendPlayerRow[]; names: ReadonlyMap<string, string> | null }>
let ResultsDialog: ComponentType<import('react').ComponentProps<typeof import('../components/LegendCollectionResults.tsx').LegendCollectionResultsDialog>>
before(async () => {
  // Avoid the application Vite config, which starts acquisition services.
  server = await createServer({ root: fileURLToPath(new URL('../../', import.meta.url)), configFile: false,
    server: { middlewareMode: true, watch: null }, appType: 'custom', logLevel: 'error', optimizeDeps: { noDiscovery: true, include: [] } })
  const page = await server.ssrLoadModule('/src/components/LegendPlayersPage.tsx')
  Page = page.LegendPlayersPage
  CaptureInfo = page.LegendPlayersCaptureInfo
  MatchSummary = page.LegendPlayersMatchSummary
  Table = (await server.ssrLoadModule('/src/components/LegendPlayersTable.tsx')).LegendPlayersTable
  ResultsDialog = (await server.ssrLoadModule('/src/components/LegendCollectionResults.tsx')).LegendCollectionResultsDialog
})
after(async () => { await server?.close() })

function dataset(version: 1 | 2 | 3 | 4): LegendPlayersDataset {
  const value: LegendPlayersDataset = {
    schemaVersion: version, id: 'legend-2026-11-05T00-00-00-000Z', captureStartedAt: '2026-11-05T00:00:00.000Z',
    captureEndedAt: '2026-11-05T00:02:00.000Z', generatedAt: '2026-11-05T00:06:00.000Z',
    source: { ...LEGEND_ANALYSIS_SOURCE, population: '人工テスト', metric: '掲載プレイヤー一覧', unit: 'account-character', notes: ['人工テスト。'] },
    act: { id: 'act-13', label: 'Act 13' }, definitionVersion: 'legend-listed-v1', membershipRule: 'official-legend-badge',
    conditions: { region: 'all', platform: 'all', characters: 'all', users: 'source-default' }, totalCount: 2,
    players: [
      { id: 'entry-1', playerName: '<player A>', characterId: 'ryu', rank: 1, masterRating: 2500 },
      { id: 'entry-2', playerName: 'Player B', characterId: 'ken', rank: 2, masterRating: 2400 },
    ],
    validation: { status: 'verified', coverage: 'all-listed-legend-entries', checks: [...LEGEND_ANALYSIS_VALIDATION_CHECKS], notes: ['人工テスト。'] },
  }
  if (version !== 1) value.players = value.players.map((row, index) => ({ ...row,
    playerId: `000000000${index + 1}`, region: 'Japan', platform: 'Steam',
    ...(version === 2 ? { rankedMatchCount: index * 120 } : {}),
  }))
  if (version === 2) value.rankedMatchScope = { actId: value.act.id, mode: 'ranked',
    collectionStartedAt: '2026-11-05T00:03:00.000Z', collectionEndedAt: '2026-11-05T00:05:00.000Z' }
  if (version === 3) value.rankedMatchAvailability = { status: 'unavailable', reason: 'access-unavailable', checkedAt: '2026-11-05T00:05:00.000Z' }
  return value
}
const renderInfo = (value: LegendPlayersDataset) => renderToStaticMarkup(createElement(CaptureInfo, { dataset: value }))
const renderSummary = (value: LegendPlayersDataset) => renderToStaticMarkup(createElement(MatchSummary, { dataset: value }))
const renderTable = (value: LegendPlayersDataset) => renderToStaticMarkup(createElement(Table, { rows: value.players, names: null }))
function finalCells(html: string): string[] {
  const body = html.match(/<tbody>([\s\S]*?)<\/tbody>/)?.[1] ?? ''
  return [...body.matchAll(/<td[^>]*>([^<>]*)<\/td><\/tr>/g)].map(match => match[1])
}

test('a complete ranking with failed profile acquisition shows failure separately from ranking timestamps', () => {
  const value = dataset(3), html = renderInfo(value)
  assert.match(renderSummary(value), />対戦数：取得失敗<\/span>/)
  const ranking = html.match(/<div><dt>順位・MR取得区間<\/dt>[\s\S]*?<\/div>/)?.[0] ?? ''
  assert.ok(ranking.includes(`dateTime="${value.captureStartedAt}"`))
  assert.ok(ranking.includes(`dateTime="${value.captureEndedAt}"`))
  assert.ok(!ranking.includes(value.rankedMatchAvailability!.checkedAt))
  assert.match(html, /<dt>対戦数<\/dt><dd>取得失敗 · <time dateTime="2026-11-05T00:05:00.000Z">/)
  assert.doesNotMatch(html, /対戦数取得区間|access-unavailable|CAPTCHA|NaN|undefined/)
  assert.match(html, /全地域 · 全プラットフォーム/)
})

test('ranking-only rows retain public identity and counts remain missing, never fabricated zeros', () => {
  const html = renderTable(dataset(3))
  assert.deepEqual(finalCells(html), ['未取得', '未取得'])
  for (const value of ['0000000001', '0000000002', '2,500', '2,400', 'Japan', 'Steam', '&lt;player A&gt;']) assert.ok(html.includes(value))
  assert.doesNotMatch(html, /<player A>/)
  assert.equal((html.match(/legend-players-unavailable/g) ?? []).length, 2)
})

test('complete profile captures keep scope and confirmed zero counts', () => {
  const value = dataset(2), html = renderInfo(value)
  assert.match(renderSummary(value), />対戦数：Act 13・ランクマッチ（Act全期間）<\/span>/)
  const profile = html.match(/<div><dt>対戦数取得区間<\/dt>[\s\S]*?<\/div>/)?.[0] ?? ''
  assert.ok(profile.includes(`dateTime="${value.rankedMatchScope!.collectionStartedAt}"`))
  assert.ok(profile.includes(`dateTime="${value.rankedMatchScope!.collectionEndedAt}"`))
  assert.doesNotMatch(html, /取得失敗|未取得/)
  assert.deepEqual(finalCells(renderTable(value)), ['0', '120'])
})

test('legacy captures remain uncollected rather than being labelled failed', () => {
  const value = dataset(1), html = renderInfo(value)
  assert.match(renderSummary(value), />対戦数：未取得<\/span>/)
  assert.doesNotMatch(html, /取得失敗|対戦数取得区間|00:05:00/)
  assert.deepEqual(finalCells(renderTable(value)), ['未取得', '未取得'])
})

test('split rankings display immediately with a pending match count and preserve the ranking interval', () => {
  const value = dataset(4), html = renderInfo(value)
  assert.match(renderSummary(value), />対戦数：取得待ち<\/span>/)
  assert.match(html, /<dt>対戦数<\/dt><dd>取得待ち<\/dd>/)
  assert.ok(html.includes(`dateTime="${value.captureEndedAt}"`))
  assert.deepEqual(finalCells(renderTable(value)), ['未取得', '未取得'])
  assert.match(renderToStaticMarkup(createElement(MatchSummary, { dataset: value, state: 'unavailable' })), /対戦数：未取得/)
  assert.match(renderToStaticMarkup(createElement(MatchSummary, { dataset: value, state: 'error' })), /対戦数：読込失敗/)
})

test('collection results remain available before a player snapshot has loaded', () => {
  const html = renderToStaticMarkup(createElement(Page))
  assert.match(html, /<button[^>]*aria-haspopup="dialog"[^>]*>取得結果<\/button>/)
  assert.match(html, /取得記録を読み込み中/)
  assert.doesNotMatch(html, /<select|<dialog/)
})

test('collection history separates saved coverage, incomplete acquisition, and save failure', () => {
  const complete: LegendCollectionRun = {
    runId: '42316199947', runAttempt: 1, trigger: 'schedule',
    startedAt: '2026-11-07T00:07:00.000Z', endedAt: '2026-11-07T01:28:00.000Z',
    outcome: 'succeeded', phase: 'complete', reason: null, lastAttemptedPage: null,
    datasetId: 'legend-2026-11-07T00-07-40-858Z', rankingCount: 503, rankedMatchCount: 503,
  }
  const stopped: LegendCollectionRun = {
    ...complete, runId: '42426148449', startedAt: '2026-11-07T23:38:00.000Z', endedAt: '2026-11-07T23:43:00.000Z',
    outcome: 'stopped', phase: 'listing', reason: 'captcha', lastAttemptedPage: 19,
    datasetId: null, rankingCount: null, rankedMatchCount: null,
  }
  const partial: LegendCollectionRun = {
    ...complete, runId: '42316199946', runAttempt: 2, trigger: 'workflow_dispatch',
    outcome: 'partial', phase: 'profiles', reason: 'access-unavailable', rankedMatchCount: 0,
  }
  const saveFailure: LegendCollectionRun = {
    ...complete, runId: '42316199945', outcome: 'save-failed', phase: 'saving',
    reason: 'output-unavailable', datasetId: null, rankingCount: null, rankedMatchCount: null,
  }
  const renderResults = (status: 'ready' | 'error', runs: LegendCollectionRun[]) =>
    renderToStaticMarkup(createElement(ResultsDialog, { status, runs, retry: () => {}, onClose: () => {} }))
  const html = renderResults('ready', [stopped, complete, partial, saveFailure])
  const [stopRow, completeRow, partialRow, saveRow] = html.match(/<li[^>]*>[\s\S]*?<\/li>/g) ?? []
  assert.match(stopRow, /2026\/11\/08 8:38/)
  assert.match(stopRow, /CAPTCHAで停止/)
  assert.match(stopRow, /19ページ目で停止/)
  assert.match(stopRow, /<dt>対戦数<\/dt><dd>未実施<\/dd>/)
  assert.match(completeRow, /取得完了.*503\/503件/)
  assert.match(partialRow, /手動.*順位・MRのみ保存.*503件保存.*<dt>対戦数<\/dt><dd>未取得<\/dd>/)
  assert.match(partialRow, /\/actions\/runs\/42316199946\/attempts\/2/)
  assert.match(saveRow, /保存失敗.*<dt>新規保存<\/dt><dd>なし<\/dd>/)
  assert.doesNotMatch(saveRow, /CAPTCHA|\/503件/)
  assert.match(renderResults('ready', []), /履歴未記録/)
  assert.match(renderResults('error', [complete]), /取得結果の読込失敗.*取得完了/)
})
