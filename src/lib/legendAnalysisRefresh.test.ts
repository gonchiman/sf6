import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { LegendAnalysisDescriptor, LegendAnalysisManifest } from '../types/legendAnalysis.ts'
import { selectRefreshedLegendId, shouldAcceptLegendPublication, startLegendAnalysisRefresh } from './legendAnalysisRefresh.ts'

function descriptor(day: string): LegendAnalysisDescriptor {
  return { id: `legend-${day}`, path: `legend-${day}.json`, actId: '13', definitionVersion: 'legend-listed-v1',
    membershipRule: 'official-legend-badge', conditions: { region: 'all', platform: 'all', characters: 'all', users: 'source-default' },
    captureStartedAt: `2026-10-${day}T01:00:00.000Z`, captureEndedAt: `2026-10-${day}T01:01:00.000Z`, totalCount: 501 }
}
function manifest(days: string[], overrides: Partial<LegendAnalysisManifest> = {}): LegendAnalysisManifest {
  return { schemaVersion: 1, generatedAt: '2026-10-27T00:00:00.000Z',
    source: { url: 'https://www.streetfighter.com/6/buckler/ja-jp/ranking/master', title: 'Buckler MRランキング' },
    datasets: days.map(descriptor), ...overrides }
}
function publication(days: string[], source: 'history' | 'bundled' = 'history', overrides: Partial<LegendAnalysisManifest> = {}) {
  return { manifest: manifest(days, overrides), source }
}

test('selection follows the latest capture without depending on manifest order', () => {
  const previous = manifest(['17', '18']), next = manifest(['17', '19', '18'])
  assert.equal(selectRefreshedLegendId(null, next, null), 'legend-19')
  assert.equal(selectRefreshedLegendId(previous, next, null), 'legend-19')
  assert.equal(selectRefreshedLegendId(previous, next, 'legend-18'), 'legend-19')
  assert.equal(selectRefreshedLegendId(previous, next, 'legend-17'), 'legend-17')
})

test('selection recovers when a capture disappears and handles an empty manifest', () => {
  const previous = manifest(['17', '18']), next = manifest(['19'])
  assert.equal(selectRefreshedLegendId(previous, next, 'legend-17'), 'legend-19')
  assert.equal(selectRefreshedLegendId(previous, next, 'unknown'), 'legend-19')
  assert.equal(selectRefreshedLegendId(previous, manifest([]), 'legend-18'), null)
  assert.equal(selectRefreshedLegendId(null, manifest([]), null), null)
})

test('publication accepts initial and extended histories, regardless of import timestamp', () => {
  assert.equal(shouldAcceptLegendPublication(null, publication([], 'bundled')), true)
  const previous = publication(['17'], 'bundled')
  assert.equal(shouldAcceptLegendPublication(previous, publication(['18', '17'], 'history', {
    generatedAt: '2026-10-18T01:02:00.000Z',
  })), true)
  assert.equal(shouldAcceptLegendPublication(publication(['18']), publication(['17', '18'])), true)
})

test('history fallback and shortened histories cannot erase already displayed captures', () => {
  const previous = publication(['17', '18'])
  assert.equal(shouldAcceptLegendPublication(previous, publication(['17'], 'bundled')), false)
  assert.equal(shouldAcceptLegendPublication(previous, publication(['17', '18'], 'bundled')), false)
  assert.equal(shouldAcceptLegendPublication(previous, publication(['18', '19'])), false)
  assert.equal(shouldAcceptLegendPublication(previous, publication([])), false)
})

test('an older latest capture is rejected even if IDs remain and import time is newer', () => {
  const previous = publication(['18'])
  const altered = { ...descriptor('18'), captureEndedAt: '2026-10-17T01:01:00.000Z' }
  assert.equal(shouldAcceptLegendPublication(previous, publication(['18'], 'history', {
    generatedAt: '2026-10-28T00:00:00.000Z', datasets: [altered],
  })), false)
})

test('availability changes for the same latest capture are accepted without inventing a new capture', () => {
  const previous = publication(['17', '18'])
  const failed = publication(['18', '17'], 'history', { availability: {
    status: 'collection-failed', checkedAt: '2026-10-27T00:00:00.000Z', message: '今回の取得を完了できませんでした。',
  } })
  assert.equal(shouldAcceptLegendPublication(previous, failed), true)
  assert.equal(shouldAcceptLegendPublication(failed, previous), true)
})

function refreshEnvironment(initialVisibility = 'visible') {
  let intervalCallback: (() => void) | null = null
  let visibilityCallback: (() => void) | null = null
  let cleared = 0, removed = 0, milliseconds = 0
  const document = {
    visibilityState: initialVisibility,
    addEventListener(type: 'visibilitychange', listener: () => void) {
      assert.equal(type, 'visibilitychange'); visibilityCallback = listener
    },
    removeEventListener(type: 'visibilitychange', listener: () => void) {
      assert.equal(type, 'visibilitychange'); assert.equal(listener, visibilityCallback); removed++
    },
  }
  const window = {
    setInterval(callback: () => void, delay: number) { intervalCallback = callback; milliseconds = delay; return 7 },
    clearInterval(handle: number) { assert.equal(handle, 7); cleared++ },
  }
  return { environment: { document, window }, tick: () => intervalCallback?.(),
    visibility: (state: string) => { document.visibilityState = state; visibilityCallback?.() },
    state: () => ({ cleared, removed, milliseconds }) }
}

test('refresh polls every five minutes only while visible and refreshes on return', () => {
  const fixture = refreshEnvironment()
  let requests = 0
  const cleanup = startLegendAnalysisRefresh(() => { requests++ }, fixture.environment)
  assert.equal(requests, 0)
  assert.equal(fixture.state().milliseconds, 300_000)
  fixture.tick(); assert.equal(requests, 1)
  fixture.visibility('hidden'); fixture.tick(); fixture.tick(); assert.equal(requests, 1)
  fixture.visibility('visible'); assert.equal(requests, 2)
  fixture.tick(); assert.equal(requests, 3)
  cleanup(); cleanup()
  assert.deepEqual(fixture.state(), { cleared: 1, removed: 1, milliseconds: 300_000 })
  fixture.tick(); fixture.visibility('visible'); assert.equal(requests, 3)
})

test('mounting in a hidden tab waits until visibility returns', () => {
  const fixture = refreshEnvironment('hidden')
  let requests = 0
  const cleanup = startLegendAnalysisRefresh(() => { requests++ }, fixture.environment)
  fixture.tick(); assert.equal(requests, 0)
  fixture.visibility('visible'); assert.equal(requests, 1)
  cleanup()
})
