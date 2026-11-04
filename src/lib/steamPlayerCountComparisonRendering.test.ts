import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createElement, type ComponentType } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer, type ViteDevServer } from 'vite'
import { STEAM_PLAYER_COUNT_GAMES } from './steamPlayerCountGames.ts'
import type { SteamPlayerCountComparisonSeries } from '../types/steamPlayerCountComparison.ts'

let server: ViteDevServer
let Hourly: ComponentType<{ series: readonly SteamPlayerCountComparisonSeries[]; scale: 'people' | 'index' }>
let Summary: ComponentType<{ series: readonly SteamPlayerCountComparisonSeries[]; metric: 'mean' | 'peak' }>
before(async () => {
  server = await createServer({ root: fileURLToPath(new URL('../../', import.meta.url)), configFile: false,
    server: { middlewareMode: true, watch: null }, appType: 'custom', logLevel: 'error', optimizeDeps: { noDiscovery: true, include: [] } })
  const module = await server.ssrLoadModule('/src/components/SteamPlayerCountComparisonCharts.tsx')
  Hourly = module.SteamPlayerCountGameHourlyChart
  Summary = module.SteamPlayerCountGameSummaryChart
})
after(async () => { await server?.close() })
const series = (index: number, value: number | null, periodMean = value): SteamPlayerCountComparisonSeries => ({
  game: STEAM_PLAYER_COUNT_GAMES[index], periodMean, peak: value,
  hourly: Array.from({ length: 24 }, (_, hour) => ({ hour, mean: value, validDays: value === null ? 0 : 1,
    totalDays: 1, observedSlots: value === null ? 0 : 4, expectedSlots: 4 })),
})

const peopleTicks = (input: SteamPlayerCountComparisonSeries[]) => {
  const html = renderToStaticMarkup(createElement(Hourly, { series: input, scale: 'people' }))
  assert.doesNotMatch(html, /NaN|Infinity/)
  return [...html.matchAll(/<text class="steam-game-chart-tick"[^>]*text-anchor="end">([^<]+)<\/text>/g)]
    .map(match => Number(match[1].replaceAll(',', ''))).slice(0, -1) // Last end-anchored tick is hour 23.
}

test('the people axis fits selected hourly means with padded whole-person ticks', () => {
  const first = { ...series(0, 31045), peak: 50000 }, second = series(1, 5500)
  assert.deepEqual(peopleTicks([first, second]), [0, 5000, 10000, 15000, 20000, 25000, 30000, 35000])
  assert.deepEqual(peopleTicks([second]), [0, 1000, 2000, 3000, 4000, 5000, 6000])
  assert.deepEqual(peopleTicks([series(0, 15)]), [0, 5, 10, 15, 20])
  assert.deepEqual(peopleTicks([series(0, .2)]), [0, 1])
})

test('zero observations and missing data both retain a finite zero-based axis without inventing data', () => {
  assert.deepEqual(peopleTicks([series(0, 0)]), [0, 1])
  assert.deepEqual(peopleTicks([series(0, null)]), [0, 1])
  const missing = renderToStaticMarkup(createElement(Hourly, { series: [series(0, null)], scale: 'people' }))
  assert.doesNotMatch(missing, /class="steam-game-chart-line"|0 人/)
  assert.match(missing, /共通の比較対象がありません/)
})

test('a missing hourly value splits each line without adding a point at every reading', () => {
  const item = series(0, 100)
  item.hourly[4].mean = null
  const html = renderToStaticMarkup(createElement(Hourly, { series: [item], scale: 'people' }))
  assert.equal((html.match(/class="steam-game-chart-line"/g) ?? []).length, 2)
  assert.equal((html.match(/class="steam-game-selected-point"/g) ?? []).length, 1)
  assert.doesNotMatch(html, /NaN|Infinity/)
})

test('proportional games share the same index line, and a zero baseline cannot create an index', () => {
  const first = series(0, 150, 100), second = series(1, 3000, 2000)
  const html = renderToStaticMarkup(createElement(Hourly, { series: [first, second], scale: 'index' }))
  const paths = [...html.matchAll(/<path class="steam-game-chart-line"[^>]* d="([^"]+)"/g)].map(match => match[1])
  assert.equal(paths.length, 2)
  assert.equal(paths[0], paths[1])
  const zero = renderToStaticMarkup(createElement(Hourly, { series: [series(0, 0)], scale: 'index' }))
  assert.doesNotMatch(zero, /class="steam-game-chart-line"|NaN|Infinity/)
  assert.match(zero, /0 人/)
  assert.match(zero, /期間平均が0人/)
})

test('summary ordering follows the selected statistic while null and zero stay distinct', () => {
  const first = { ...series(0, 100), peak: 2000 }, second = { ...series(1, 200), peak: 400 }
  const input = [first, second, series(2, null), series(3, 0)]
  const means = renderToStaticMarkup(createElement(Summary, { series: input, metric: 'mean' }))
  const peaks = renderToStaticMarkup(createElement(Summary, { series: input, metric: 'peak' }))
  const order = (html: string) => [...html.matchAll(/data-steam-summary-game="(\d+)"/g)].map(match => Number(match[1]))
  assert.deepEqual(order(means), [second.game.appId, first.game.appId, input[3].game.appId, input[2].game.appId])
  assert.deepEqual(order(peaks), [first.game.appId, second.game.appId, input[3].game.appId, input[2].game.appId])
  assert.equal((means.match(/class="steam-game-summary-bar"/g) ?? []).length, 2)
  assert.equal((means.match(/class="steam-game-summary-zero"/g) ?? []).length, 1)
  assert.match(means, /算出不可/)
  assert.doesNotMatch(means, /NaN|Infinity/)
})
