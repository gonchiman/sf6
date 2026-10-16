import assert from 'node:assert/strict'
import test from 'node:test'
import type { TestContext } from 'node:test'
import { BUCKLER_AUTH_PROBE_URL } from './buckler-auth-probe.ts'
import { isBucklerAuthProbePage, observeBucklerAuthDom, readBucklerAuthProbePage } from './buckler-auth-probe-dom.ts'
import type { Page } from 'playwright'

type FakeElement = {
  innerText: string; parentElement: FakeElement | null; value?: string
  getBoundingClientRect(): { width: number; height: number }
  getAttribute(name: string): string | null; hasAttribute(name: string): boolean
  querySelector(selector: string): FakeElement | null
  querySelectorAll(selector: string): FakeElement[]
  style: { display: string; visibility: string; opacity: string }
}

function element(text = '', children: Record<string, FakeElement[]> = {}, visibility = 'visible'): FakeElement {
  return {
    innerText: text, parentElement: null, style: { display: 'block', visibility, opacity: '1' },
    getBoundingClientRect: () => ({ width: 100, height: 20 }),
    getAttribute: () => null, hasAttribute: () => false,
    querySelector: selector => children[selector]?.[0] ?? null,
    querySelectorAll: selector => children[selector] ?? [],
  }
}

function setDom(t: TestContext, nodes: Record<string, FakeElement[]>): void {
  const descriptors = ['document', 'window'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const)
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { querySelectorAll: (selector: string) => nodes[selector] ?? [] } })
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { getComputedStyle: (node: FakeElement) => node.style } })
  t.after(() => {
    for (const [name, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else Reflect.deleteProperty(globalThis, name)
    }
  })
}

function ranking(controls: FakeElement[] = []): Record<string, FakeElement[]> {
  const rows = Array.from({ length: 20 }, () => element('', { dt: [element('1位')], dd: [element('10000LP')] }))
  const selects = ['0', '2', '0', '1', '1'].map(value => Object.assign(element(), { value }))
  return {
    'a,button': controls, p: [element('1 - 20 / 3000000')], select: selects,
    'ul[class*="ranking_ranking_list"]:not([class*="ranking__my__list"])': [element('', { 'a[href*="/profile/"]': rows })],
  }
}

test('only the fixed official first page is accepted, including strict query conditions', () => {
  assert.equal(isBucklerAuthProbePage(BUCKLER_AUTH_PROBE_URL), true)
  for (const url of [BUCKLER_AUTH_PROBE_URL.replace('page=1', 'page=2'), BUCKLER_AUTH_PROBE_URL + '&token=private',
    BUCKLER_AUTH_PROBE_URL.replace('character_filter=2', 'character_filter=1'), 'https://example.com/']) {
    assert.equal(isBucklerAuthProbePage(url), false)
  }
})

test('rendered maintenance is detected while names and links never leave DOM observation', t => {
  setDom(t, { 'h1,h2': [element('Maintenance\nただいま、システムメンテナンス中です')],
    'a,button': [element('private-player-name')] })
  const result = observeBucklerAuthDom()
  assert.equal(result.maintenance, true)
  assert.equal(result.rankingRows, null)
  assert.ok(!JSON.stringify(result).includes('private-player-name'))
})

test('anonymous, unconfirmed and signed-in UI are distinct; hidden logout cannot prove authentication', t => {
  const nodes = ranking([element('ログイン / 新規登録'), element('ログアウト', {}, 'hidden')])
  setDom(t, nodes)
  assert.equal(observeBucklerAuthDom().signedIn, false)
  assert.equal(observeBucklerAuthDom().rankingRows, 20)
  assert.equal(observeBucklerAuthDom().loginRequired, false)
  nodes['a,button'] = [element('公開プロフィール')]
  assert.equal(observeBucklerAuthDom().signedIn, null)
  nodes['a,button'] = [element('ログアウト')]
  assert.equal(observeBucklerAuthDom().signedIn, true)
  nodes['a,button'] = [element('ログアウト'), element('ログイン')]
  assert.equal(observeBucklerAuthDom().signedIn, null)
})

test('DOM reader waits for complete counters/rows and sanitizes navigation errors', async t => {
  const complete = { maintenance: false, loginRequired: false, signedIn: true, rankingRows: 20,
    visibleCounters: { from: 1, to: 20, total: 3000000 }, controlMatches: true }
  let evaluations = 0
  let navigations = 0
  const page = {
    goto: async (url: string) => { assert.equal(url, BUCKLER_AUTH_PROBE_URL); navigations++ },
    url: () => BUCKLER_AUTH_PROBE_URL,
    evaluate: async () => ++evaluations === 1 ? { ...complete, rankingRows: 0, visibleCounters: null } : complete,
  } as unknown as Page
  const result = await readBucklerAuthProbePage(page)
  assert.equal(evaluations, 2)
  assert.equal(navigations, 1)
  assert.equal(result.rankingRows, 20)
  const error = new Error('https://example.com/?token=private'); error.name = 'TimeoutError'
  t.mock.method(page, 'goto', async () => { throw error })
  await assert.rejects(readBucklerAuthProbePage(page), failure => {
    assert.ok(failure instanceof Error)
    assert.ok(!failure.message.includes('private'))
    return 'status' in failure && failure.status === 'timeout'
  })
})

test('expected authentication waits for login controls to hydrate after readable anonymous or unconfirmed rows', async t => {
  for (const initialControl of ['ログイン', '公開プロフィール']) {
    await t.test(initialControl, async t => {
      const nodes = ranking()
      setDom(t, nodes)
      let evaluations = 0
      const page = {
        goto: async () => { assert.fail('navigate=false must not reload the page') },
        url: () => BUCKLER_AUTH_PROBE_URL,
        evaluate: async () => {
          nodes['a,button'] = [element(++evaluations === 1 ? initialControl : 'ログアウト')]
          return observeBucklerAuthDom()
        },
      } as unknown as Page
      const result = await readBucklerAuthProbePage(page, false, true)
      assert.equal(evaluations, 2)
      assert.equal(result.signedIn, true)
      assert.equal(result.rankingRows, 20)
    })
  }
})

test('default DOM reading still returns readable anonymous rows immediately', async t => {
  setDom(t, ranking([element('ログイン')]))
  let evaluations = 0
  const page = {
    url: () => BUCKLER_AUTH_PROBE_URL,
    evaluate: async () => { evaluations++; return observeBucklerAuthDom() },
  } as unknown as Page
  const result = await readBucklerAuthProbePage(page, false)
  assert.equal(evaluations, 1)
  assert.equal(result.signedIn, false)
  assert.equal(result.rankingRows, 20)
})

test('expected authentication returns the last observed anonymous state at the deadline without inventing a login', async t => {
  setDom(t, ranking([element('ログイン')]))
  let evaluations = 0
  let nowCalls = 0
  t.mock.method(Date, 'now', () => ++nowCalls === 1 ? 0 : 10_001)
  const page = {
    url: () => BUCKLER_AUTH_PROBE_URL,
    evaluate: async () => { evaluations++; return observeBucklerAuthDom() },
  } as unknown as Page
  const result = await readBucklerAuthProbePage(page, false, true)
  assert.equal(evaluations, 1)
  assert.equal(result.signedIn, false)
  assert.equal(result.rankingRows, 20)
})

test('maintenance and explicit login gates remain immediate when authentication is expected', async t => {
  for (const heading of ['Maintenance', 'ログインしてください']) {
    await t.test(heading, async t => {
      setDom(t, { 'h1,h2': [element(heading)] })
      let evaluations = 0
      const page = {
        url: () => BUCKLER_AUTH_PROBE_URL,
        evaluate: async () => { evaluations++; return observeBucklerAuthDom() },
      } as unknown as Page
      const result = await readBucklerAuthProbePage(page, false, true)
      assert.equal(evaluations, 1)
      assert.equal(result.maintenance, heading === 'Maintenance')
      assert.equal(result.loginRequired, heading === 'ログインしてください')
    })
  }
})
