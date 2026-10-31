import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createElement, type ComponentType } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer, type ViteDevServer } from 'vite'
import type { SteamPlayerCountHourlyRow, SteamPlayerCountObservation } from '../types/steamPlayerCount.ts'

let server: ViteDevServer
let Hourly: ComponentType<{ rows: SteamPlayerCountHourlyRow[] }>
let Trend: ComponentType<{ observations: SteamPlayerCountObservation[] }>
before(async () => {
  server = await createServer({ root: fileURLToPath(new URL('../../', import.meta.url)), configFile: false,
    server: { middlewareMode: true, watch: null }, appType: 'custom', logLevel: 'error', optimizeDeps: { noDiscovery: true, include: [] } })
  const charts = await server.ssrLoadModule('/src/components/SteamPlayerCountCharts.tsx')
  Hourly = charts.SteamPlayerCountHourlyChart
  Trend = charts.SteamPlayerCountTrendChart
})
after(async () => { await server?.close() })
const observation = (minute: number, playerCount = 20000): SteamPlayerCountObservation => ({
  id: `sample-${minute}`, observedAt: new Date(Date.UTC(2026, 9, 31, 0, minute)).toISOString(),
  requestStartedAt: new Date(Date.UTC(2026, 9, 31, 0, minute)).toISOString(), playerCount, runId: null, runAttempt: null,
})
const renderTrend = (observations: SteamPlayerCountObservation[]) => renderToStaticMarkup(createElement(Trend, { observations }))

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
