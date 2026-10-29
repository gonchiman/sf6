import assert from 'node:assert/strict'
import test from 'node:test'
import { createDistributionNavigation } from './distribution-navigation.ts'

const url = 'https://www.streetfighter.com/6/buckler/ja-jp/ranking/master?page=1'

test('navigation paces starts rather than adding a full interval after page completion', async () => {
  let now = 0
  const waits: number[] = [], starts: number[] = [], resets: number[] = []
  const navigate = createDistributionNavigation({ goto: async (actualUrl, options) => {
    assert.equal(actualUrl, url)
    assert.deepEqual(options, { waitUntil: 'domcontentloaded', timeout: 30000 })
    starts.push(now); now += 4000
    return null
  } }, { minIntervalMs: 5000, now: () => now, wait: async milliseconds => { waits.push(milliseconds); now += milliseconds }, check: () => {} })
  await navigate(url, () => { resets.push(now) })
  await navigate(url, () => { resets.push(now) })
  now = 20000
  await navigate(url, () => { resets.push(now) })
  assert.deepEqual(starts, [0, 5000, 20000])
  assert.deepEqual(resets, starts)
  assert.deepEqual(waits, [1000, 0])
})

test('external pacing owns the start and diagnostics reset remains immediately before goto', async () => {
  const events: string[] = []
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const navigate = createDistributionNavigation({ goto: async () => { events.push('goto'); return null } }, {
    minIntervalMs: 5000, now: () => 0, wait: async () => { assert.fail('reader must not add an independent wait') },
    check: () => { events.push('check') }, navigateWithPacing: async perform => { await gate; events.push('gate'); return perform() },
  })
  const first = navigate(url, () => { events.push('reset') })
  assert.deepEqual(events, [])
  release(); await first
  await navigate(url, () => { events.push('reset') })
  assert.deepEqual(events, ['gate', 'check', 'reset', 'goto', 'gate', 'check', 'reset', 'goto'])
})

test('cancellation while waiting for an external start cannot reset diagnostics or navigate', async () => {
  const controller = new AbortController()
  const navigate = createDistributionNavigation({ goto: async () => { assert.fail('must not navigate') } }, {
    minIntervalMs: 5000, now: () => 0, wait: async () => {}, check: () => controller.signal.throwIfAborted(),
    navigateWithPacing: perform => { controller.abort(); return perform() },
  })
  await assert.rejects(navigate(url, () => { assert.fail('must not reset') }), error => error === controller.signal.reason)
})

test('failed navigation is not retried by the helper and still counts as a paced start', async () => {
  let now = 0, requests = 0
  const waits: number[] = []
  const failure = new Error('synthetic navigation error')
  const navigate = createDistributionNavigation({ goto: async () => { if (++requests === 1) throw failure; return null } }, {
    minIntervalMs: 5000, now: () => now, wait: async milliseconds => { waits.push(milliseconds); now += milliseconds }, check: () => {},
  })
  await assert.rejects(navigate(url, () => {}), error => error === failure)
  assert.equal(requests, 1)
  now = 1500
  await navigate(url, () => {})
  assert.equal(requests, 2)
  assert.deepEqual(waits, [3500])
})
