import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createElement, type ComponentType } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer, type ViteDevServer } from 'vite'
import { LEGEND_ANALYSIS_SOURCE, LEGEND_ANALYSIS_VALIDATION_CHECKS } from './legendAnalysis.ts'
import type { LegendPlayerRow, LegendPlayersDataset } from '../types/legendPlayers.ts'

let server: ViteDevServer
let CaptureInfo: ComponentType<{ dataset: LegendPlayersDataset }>
let MatchSummary: ComponentType<{ dataset: LegendPlayersDataset }>
let Table: ComponentType<{ rows: readonly LegendPlayerRow[]; names: ReadonlyMap<string, string> | null }>
before(async () => {
  // Avoid the application Vite config, which starts acquisition services.
  server = await createServer({ root: fileURLToPath(new URL('../../', import.meta.url)), configFile: false,
    server: { middlewareMode: true, watch: null }, appType: 'custom', logLevel: 'error', optimizeDeps: { noDiscovery: true, include: [] } })
  const page = await server.ssrLoadModule('/src/components/LegendPlayersPage.tsx')
  CaptureInfo = page.LegendPlayersCaptureInfo
  MatchSummary = page.LegendPlayersMatchSummary
  Table = (await server.ssrLoadModule('/src/components/LegendPlayersTable.tsx')).LegendPlayersTable
})
after(async () => { await server?.close() })

function dataset(version: 1 | 2 | 3): LegendPlayersDataset {
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
