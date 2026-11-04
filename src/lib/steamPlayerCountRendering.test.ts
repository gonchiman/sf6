import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createElement, type ComponentType } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer, type ViteDevServer } from 'vite'
import { STEAM_PLAYER_COUNT_GAMES } from './steamPlayerCountGames.ts'
import type { SteamPlayerCountAppId, SteamPlayerCountHourlyRow, SteamPlayerCountObservation } from '../types/steamPlayerCount.ts'
import type { SteamPlayerCountGameComparison } from '../types/steamPlayerCountComparison.ts'

let server: ViteDevServer
let Hourly: ComponentType<{ rows: SteamPlayerCountHourlyRow[] }>
let Trend: ComponentType<{ observations: SteamPlayerCountObservation[] }>
let Page: ComponentType<{ initialAppId?: SteamPlayerCountAppId; initialMode?: 'single' | 'comparison' }>
let ComparisonTable: ComponentType<{ comparison: SteamPlayerCountGameComparison }>
before(async () => {
  server = await createServer({ root: fileURLToPath(new URL('../../', import.meta.url)), configFile: false,
    server: { middlewareMode: true, watch: null }, appType: 'custom', logLevel: 'error', optimizeDeps: { noDiscovery: true, include: [] } })
  const charts = await server.ssrLoadModule('/src/components/SteamPlayerCountCharts.tsx')
  Hourly = charts.SteamPlayerCountHourlyChart
  Trend = charts.SteamPlayerCountTrendChart
  const page = await server.ssrLoadModule('/src/components/SteamPlayerCountPage.tsx')
  Page = page.SteamPlayerCountPage
  const comparison = await server.ssrLoadModule('/src/components/SteamPlayerCountComparisonView.tsx')
  ComparisonTable = comparison.SteamPlayerCountGameComparisonTable
})
after(async () => { await server?.close() })
const observation = (minute: number, playerCount = 20000): SteamPlayerCountObservation => ({
  id: `sample-${minute}`, observedAt: new Date(Date.UTC(2026, 9, 31, 0, minute)).toISOString(),
  requestStartedAt: new Date(Date.UTC(2026, 9, 31, 0, minute)).toISOString(), playerCount, runId: null, runAttempt: null,
})
const renderTrend = (observations: SteamPlayerCountObservation[]) => renderToStaticMarkup(createElement(Trend, { observations }))

test('the page defaults to SF6 with all five game options available during loading', () => {
  const html = renderToStaticMarkup(createElement(Page))
  assert.match(html, /data-steam-app-id="1364780"/)
  const selector = html.match(/<select[^>]*aria-label="ゲーム"[^>]*>[\s\S]*?<\/select>/)?.[0]
  assert.ok(selector)
  assert.doesNotMatch(selector, /disabled/)
  assert.equal((selector.match(/<option /g) ?? []).length, 5)
  assert.match(selector, /<option value="1364780" selected="">Street Fighter 6<\/option>/)
  assert.match(html, /Street Fighter 6の観測データを読み込み中/)
  assert.doesNotMatch(html, /aria-label="開始日"|aria-label="終了日"/)
  assert.match(html, /role="group" aria-label="期間"/)
  for (const label of ['今日', '昨日', '直近7日', '直近30日', '全期間', '日付指定']) {
    assert.match(html, new RegExp(`<button[^>]*aria-pressed="${label === '直近7日'}"[^>]*>${label}</button>`))
  }
  assert.match(html, /<dt>表示期間<\/dt>/)
  assert.match(html, /<dt>データ範囲<\/dt><dd>読込中<\/dd>/)
  assert.match(html, /aria-label="曜日"/)
})

test('every selected game has its own source and loading state without another game’s counts', () => {
  for (const game of STEAM_PLAYER_COUNT_GAMES) {
    const html = renderToStaticMarkup(createElement(Page, { initialAppId: game.appId }))
    assert.ok(html.includes(`data-steam-app-id="${game.appId}"`))
    assert.ok(html.includes(`href="${game.sourceUrl}"`))
    assert.ok(html.includes(`ゲーム：${game.label}`))
    assert.ok(html.includes(`${game.label}の観測データを読み込み中`))
    assert.ok(html.includes(`<option value="${game.appId}" selected="">`))
    assert.doesNotMatch(html, /<strong>\d[\d,]* 人<\/strong>|最終観測|公開日時/)
    const selector = html.match(/<select[^>]*aria-label="ゲーム"[^>]*>/)?.[0]
    assert.ok(selector)
    assert.doesNotMatch(selector, /disabled/)
  }
})

test('comparison mode starts with all five games and shared period controls while loading', () => {
  const html = renderToStaticMarkup(createElement(Page, { initialMode: 'comparison' }))
  assert.match(html, /aria-label="Steam同時接続数のゲーム比較"/)
  const selectedGames = html.match(/<button[^>]*class="[^"]*comparison-grid-option[^"]*"[^>]*>[\s\S]*?<\/button>/g) ?? []
  assert.equal(selectedGames.length, 5)
  for (const [index, label] of ['SF6', 'TEKKEN 8', 'GGST', 'GBVSR', 'KOF XV'].entries()) {
    assert.match(selectedGames[index], /aria-pressed="true"/)
    assert.ok(selectedGames[index].includes(label))
  }
  assert.match(html, /role="group" aria-label="期間"/)
  for (const label of ['今日', '昨日', '直近7日', '直近30日', '全期間', '日付指定']) {
    assert.match(html, new RegExp(`<button[^>]*aria-pressed="${label === '直近7日'}"[^>]*>${label}</button>`))
  }
  assert.match(html, /aria-label="曜日"/)
  assert.match(html, /<dt>共通データ範囲<\/dt><dd>読込中<\/dd>/)
  assert.match(html, /比較するゲームの観測データを読み込み中/)
})

test('the comparison table distinguishes zero from missing means and retains shared coverage', () => {
  const hourly: SteamPlayerCountHourlyRow[] = [
    { hour: 9, mean: null, validDays: 1, totalDays: 2, observedSlots: 4, expectedSlots: 8 },
    { hour: 10, mean: null, validDays: 0, totalDays: 2, observedSlots: 3, expectedSlots: 8 },
  ]
  const comparison: SteamPlayerCountGameComparison = {
    hourly, commonDays: 1, commonHours: 1, commonSlots: 4, expectedSlots: 16, totalDays: 2,
    series: STEAM_PLAYER_COUNT_GAMES.map((game, index) => ({
      game, hourly: hourly.map(row => ({ ...row, mean: row.hour === 9 ? index * 100 : null })),
      periodMean: index * 100, peak: index * 100,
    })),
  }
  const html = renderToStaticMarkup(createElement(ComparisonTable, { comparison }))
  const header = html.match(/<thead>[\s\S]*?<\/thead>/)?.[0]
  assert.ok(header)
  for (const label of ['時間帯（JST）', 'SF6', 'TEKKEN 8', 'GGST', 'GBVSR', 'KOF XV', '平均（人）', '共通比較日数', '共通観測／予定']) {
    assert.ok(header.includes(label))
  }
  const zeroRow = html.match(/<tr><th scope="row">09時台<\/th>[\s\S]*?<\/tr>/)?.[0]
  assert.ok(zeroRow)
  assert.match(zeroRow, /<td>0<\/td>/)
  assert.match(zeroRow, /<td>1 \/ 2 日<\/td><td>4 \/ 8 区間<\/td>/)
  assert.doesNotMatch(zeroRow, /算出不可/)
  const missingRow = html.match(/<tr><th scope="row">10時台<\/th>[\s\S]*?<\/tr>/)?.[0]
  assert.ok(missingRow)
  assert.equal((missingRow.match(/算出不可/g) ?? []).length, 5)
  assert.match(missingRow, /<td>0 \/ 2 日<\/td><td>3 \/ 8 区間<\/td>/)
})

test('unavailable hourly means stay missing while a verified zero remains visible', () => {
  const rows = Array.from({ length: 24 }, (_, hour) => ({ hour, mean: null, validDays: 0,
    totalDays: 1, observedSlots: 0, expectedSlots: 4 })) as SteamPlayerCountHourlyRow[]
  const empty = renderToStaticMarkup(createElement(Hourly, { rows }))
  assert.match(empty, /対象期間の観測がありません/)
  assert.match(empty, /算出不可/)
  rows[9].observedSlots = 3
  assert.match(renderToStaticMarkup(createElement(Hourly, { rows })), /4区間が揃った時間帯はありません/)
  rows[9] = { ...rows[9], mean: 0, validDays: 1, observedSlots: 4 }
  const zero = renderToStaticMarkup(createElement(Hourly, { rows }))
  assert.match(zero, /平均 0 人/)
  assert.doesNotMatch(zero, /4区間が揃った時間帯はありません|NaN|Infinity/)
})

test('the first real observation has its timestamp and count, including a true zero', () => {
  const html = renderTrend([observation(7, 0)])
  assert.match(html, /2026\/10\/31 9:07 JST/)
  assert.match(html, /<strong>0 人<\/strong>/)
  assert.match(html, /steam-player-count-selected-point/)
  assert.doesNotMatch(html, /NaN|Infinity|対象期間の観測がありません/)
  assert.match(renderTrend([]), /対象期間の観測がありません/)
})

test('missing quarter-hour slots break the trend and dense complete histories do not create a dot per reading', () => {
  const gap = renderTrend([observation(7), observation(22), observation(52)])
  assert.equal((gap.match(/class="steam-player-count-line"/g) ?? []).length, 2)
  const complete = renderTrend(Array.from({ length: 96 }, (_, index) => observation(7 + 15 * index)))
  assert.equal((complete.match(/class="steam-player-count-line"/g) ?? []).length, 1)
  assert.equal((complete.match(/<circle /g) ?? []).length, 1)
})
