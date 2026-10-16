import assert from 'node:assert/strict'
import test from 'node:test'
import type { TestContext } from 'node:test'
import type { Page } from 'playwright'
import { createMrDistributionPageReader, MrDistributionDomError, observeMrDistributionDom } from './mr-distribution-dom.ts'
import type { MrDistributionDomObservation, MrDistributionPageReaderOptions } from './mr-distribution-dom.ts'
import { mrDistributionPageUrl } from './mr-distribution-collector.ts'

type Node = {
  innerText: string; textContent: string; parentElement: Node | null; value: string; selectedOptions: Node[]
  style: { display: string; visibility: string; opacity: string }
  getBoundingClientRect(): { width: number; height: number }
  getAttribute(name: string): string | null; hasAttribute(name: string): boolean
  closest(selector: string): Node | null; querySelectorAll(selector: string): Node[]
}
function node(text = '', children: Record<string, Node[]> = {}, attributes: Record<string, string> = {}): Node {
  return { innerText: text, textContent: text, parentElement: null, value: '', selectedOptions: [],
    style: { display: 'block', visibility: 'visible', opacity: '1' }, getBoundingClientRect: () => ({ width: 100, height: 20 }),
    getAttribute: name => attributes[name] ?? null, hasAttribute: name => Object.hasOwn(attributes, name),
    closest: () => null, querySelectorAll: selector => children[selector] ?? [] }
}
const select = (value: string, label: string) => Object.assign(node(), { value, selectedOptions: [node(label)] })
function dom(t: TestContext) {
  const rows = Array.from({ length: 2 }, (_, i) => node('private-player-name', { dt: [node('1位')], dd: [node('1500MR')] },
    { href: `/6/buckler/ja-jp/profile/${987654321 + i}` }))
  const active = node('', { a: [node('今Act')] })
  const nav = node('', { 'li[class*="ranking_act_nav_active"]': [active] })
  const nodes: Record<string, Node[]> = { 'h1,h2': [], 'a,button': [node('ログアウト')], p: [node('1 - 2 / 2')],
    select: [select('2', '最大MR'), select('0', 'すべて'), select('1', 'すべて'), select('1', '1'), select('1', '1')],
    'aside[class*="ranking_act_nav"]': [nav],
    'ul[class*="ranking_ranking_list"]:not([class*="ranking__my__list"])': [node('', { 'li > a[href*="/profile/"]': rows })] }
  const globals = { document: { querySelectorAll: (selector: string) => nodes[selector] ?? [] },
    window: { getComputedStyle: (element: Node) => element.style, scrollTo: () => {} }, location: { origin: 'https://www.streetfighter.com' } }
  const before = Object.keys(globals).map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const)
  for (const [name, value] of Object.entries(globals)) Object.defineProperty(globalThis, name, { configurable: true, value })
  t.mock.method(globalThis, 'setTimeout', ((callback: () => void) => { callback(); return 0 }) as unknown as typeof setTimeout)
  t.after(() => { for (const [name, descriptor] of before) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name)
  } })
  return { nodes, rows, active, nav }
}

test('rendered current Act, visible filters and tied MR rows expose only salted transient keys', async t => {
  const setup = dom(t)
  const hidden = select('1', '別条件'); hidden.style.display = 'none'
  setup.nodes.select.push(hidden)
  const first = await observeMrDistributionDom({ salt: 'capture-one' })
  const second = await observeMrDistributionDom({ salt: 'capture-two' })
  assert.equal(first.conditionsMatch, true)
  assert.equal(first.currentActMatch, true)
  assert.equal(first.signedIn, true)
  assert.equal(first.authenticationEvidence, 'logout-control')
  assert.deepEqual(first.entries?.map(row => row.masterRating), [1500, 1500])
  assert.equal(new Set(first.entries?.map(row => row.accountKey)).size, 2)
  assert.match(first.entries![0].accountKey!, /^[a-f0-9]{64}$/)
  assert.notEqual(first.entries![0].accountKey, second.entries![0].accountKey)
  assert.doesNotMatch(JSON.stringify(first), /private-player-name|987654321|profile/)
})

test('hidden logout, own-card names and inactive current-Act links cannot establish auth or current-Act conditions', async t => {
  const setup = dom(t)
  const hidden = node('ログアウト'); hidden.style.opacity = '0'
  const ownCard = node('ログアウト'); ownCard.closest = () => ownCard
  setup.nodes['a,button'] = [hidden, ownCard, node('ログイン')]
  setup.nodes['ul[class*="ranking_ranking_list"]'] = [node('private own card')]
  const result = await observeMrDistributionDom({ salt: 'capture' })
  assert.equal(result.signedIn, false)
  assert.equal(result.entries?.length, 2)
  setup.active.querySelectorAll = () => [node('前Act')]
  assert.equal((await observeMrDistributionDom({ salt: 'capture' })).currentActMatch, false)
})

test('a malformed MR row, external profile href, missing nav or conflicting filter is not silently filled', async t => {
  const setup = dom(t)
  setup.rows[0].querySelectorAll = selector => selector === 'dt' ? [node('1位')] : [node('unknownMR')]
  assert.equal((await observeMrDistributionDom({ salt: 'capture' })).entries, null)
  setup.rows[0].querySelectorAll = selector => selector === 'dt' ? [node('1位')] : [node('1500MR')]
  setup.rows[0].getAttribute = () => 'https://example.com/profile/123'
  assert.equal((await observeMrDistributionDom({ salt: 'capture' })).entries, null)
  setup.nodes['aside[class*="ranking_act_nav"]'] = []
  assert.equal((await observeMrDistributionDom({ salt: 'capture' })).currentActMatch, null)
  setup.nodes.select[0].value = '1'
  assert.equal((await observeMrDistributionDom({ salt: 'capture' })).conditionsMatch, false)
})

test('visible human-verification headings or the observed AWS begin button are hard-stop evidence, with no challenge action', async t => {
  const setup = dom(t)
  for (const heading of ['ユーザーが人間であることを確認する', 'Human Verification', 'Verify you are human']) {
    setup.nodes['h1,h2'] = [node(heading)]
    const value = await observeMrDistributionDom({ salt: 'capture' })
    assert.equal(value.humanVerificationRequired, true)
    assert.equal(value.entries, null)
  }
  setup.nodes['h1,h2'] = []
  const button = node('開始')
  setup.nodes['#amzn-captcha-verify-button'] = [button]
  assert.equal((await observeMrDistributionDom({ salt: 'capture' })).humanVerificationRequired, true)
  button.style.display = 'none'
  assert.equal((await observeMrDistributionDom({ salt: 'capture' })).humanVerificationRequired, false)
})

function observation(page = 1, total = 43): MrDistributionDomObservation {
  const from = (page - 1) * 20 + 1, to = Math.min(page * 20, total)
  return { maintenance: false, loginRequiredHeading: false, signedIn: true, authenticationEvidence: 'logout-control',
    conditionsMatch: true, currentActMatch: true, selectedPage: page, range: { from, to, total },
    entries: Array.from({ length: to - from + 1 }, (_, i) => ({ masterRating: 1600 - from - i, accountKey: (from + i).toString(16).padStart(64, '0') })) }
}
function browser(configuration: {
  observe?: (page: number, count: number) => MrDistributionDomObservation
  status?: number; redirect?: (url: string) => string
  options?: MrDistributionPageReaderOptions
} = {}) {
  let clock = 0, evaluations = 0, currentUrl = '', pageNumber = 1
  const requests: string[] = [], waits: number[] = []
  const fake = {
    goto: async (url: string) => { requests.push(url); pageNumber = Number(new URL(url).searchParams.get('page')); currentUrl = configuration.redirect?.(url) ?? url
      return { status: () => configuration.status ?? 200 } },
    url: () => currentUrl,
    evaluate: async () => { evaluations++; return configuration.observe?.(pageNumber, evaluations) ?? observation(pageNumber) },
  } as unknown as Page
  const reader = createMrDistributionPageReader(fake, { now: () => clock,
    wait: async ms => { waits.push(ms); clock += ms }, ...configuration.options })
  return { reader, requests, waits, evaluations: () => evaluations, elapsed: () => clock }
}
const errorCode = (code: string) => (error: unknown) => error instanceof MrDistributionDomError && error.code === code

test('page 1 then a deep final page are checked against ranges, both page controls and fixed URL', async () => {
  const setup = browser()
  await setup.reader.fetchPage(1, mrDistributionPageUrl(1))
  const tail = await setup.reader.fetchPage(3, mrDistributionPageUrl(3))
  assert.equal(tail.entries.length, 3)
  assert.equal(tail.pageSize, 20)
  assert.equal(tail.totalPages, 3)
  assert.equal(setup.reader.getDiagnostics().initialSignInConfirmed, true)
  assert.equal(setup.reader.getDiagnostics().currentActConfirmed, true)
  assert.equal(setup.reader.getDiagnostics().successfulReadCount, 2)
  assert.ok(setup.waits.includes(5000))
  await assert.rejects(browser().reader.fetchPage(3, mrDistributionPageUrl(3)), errorCode('first-page-required'))
  await assert.rejects(setup.reader.fetchPage(1, `${mrDistributionPageUrl(1)}&user_status=1`), errorCode('invalid-request'))
})

test('first anonymous pages remain unconfirmed; only later fully readable login-control pages can pass after ten seconds', async () => {
  const anonymous = (page: number): MrDistributionDomObservation => ({ ...observation(page), signedIn: false, authenticationEvidence: 'login-control' })
  const first = browser({ observe: anonymous, options: { allowReadablePagesAfterSignIn: true } })
  await assert.rejects(first.reader.fetchPage(1, mrDistributionPageUrl(1)), errorCode('authentication-unconfirmed'))
  assert.equal(first.elapsed(), 10000)
  assert.equal(first.reader.getDiagnostics().initialSignInConfirmed, false)
  for (const allow of [false, true]) {
    const setup = browser({ observe: page => page === 1 ? observation(page) : anonymous(page), options: { allowReadablePagesAfterSignIn: allow } })
    await setup.reader.fetchPage(1, mrDistributionPageUrl(1))
    if (allow) {
      await setup.reader.fetchPage(3, mrDistributionPageUrl(3))
      assert.equal(setup.reader.getDiagnostics().readableWithoutSignInReadCount, 1)
      assert.equal(setup.reader.getDiagnostics().lastAuthenticationEvidence, 'login-control')
    } else await assert.rejects(setup.reader.fetchPage(3, mrDistributionPageUrl(3)), errorCode('authentication-unconfirmed'))
    assert.equal(setup.elapsed(), 15000)
  }
})

test('explicit login headings, absent/conflicting auth, wrong Act and malformed readable rows are rejected after initial auth', async () => {
  for (const [patch, code] of [
    [{ signedIn: false, authenticationEvidence: 'login-control', loginRequiredHeading: true }, 'login-required'],
    [{ signedIn: null, authenticationEvidence: 'no-control' }, 'authentication-unconfirmed'],
    [{ signedIn: null, authenticationEvidence: 'conflicting-controls' }, 'authentication-unconfirmed'],
    [{ currentActMatch: false }, 'condition-mismatch'],
    [{ entries: [{ masterRating: -1, accountKey: 'a'.repeat(64) }] }, 'unsupported-dom'],
  ] as const) {
    const setup = browser({ observe: page => ({ ...observation(page), ...(page === 1 ? {} : patch) }) as MrDistributionDomObservation,
      options: { allowReadablePagesAfterSignIn: true } })
    await setup.reader.fetchPage(1, mrDistributionPageUrl(1))
    await assert.rejects(setup.reader.fetchPage(3, mrDistributionPageUrl(3)), errorCode(code))
    assert.equal(setup.reader.getDiagnostics().successfulReadCount, 1)
  }
})

test('temporary hydration headings/pending rows settle within one navigation; permanent pending remains retryable', async () => {
  const recovering = browser({ observe: (page, count) => count === 1
    ? { ...observation(page), signedIn: false, authenticationEvidence: 'login-control', loginRequiredHeading: true, entries: null } : observation(page) })
  await recovering.reader.fetchPage(1, mrDistributionPageUrl(1))
  assert.equal(recovering.requests.length, 1)
  assert.equal(recovering.evaluations(), 2)
  const pending = browser({ observe: page => ({ ...observation(page), entries: null }) })
  await assert.rejects(pending.reader.fetchPage(1, mrDistributionPageUrl(1)), errorCode('read-failed'))
  assert.equal(pending.reader.getDiagnostics().lastRankingReadable, false)
})

test('HTTP denial/server/other errors stop before DOM reading; redirects and raw exceptions stay sanitized', async () => {
  for (const [status, code] of [[401, 'http-denied'], [403, 'http-denied'], [429, 'http-denied'], [503, 'server-error'], [404, 'http-error']] as const) {
    const setup = browser({ status })
    await assert.rejects(setup.reader.fetchPage(1, mrDistributionPageUrl(1)), errorCode(code))
    assert.equal(setup.evaluations(), 0)
    assert.equal(setup.reader.getDiagnostics().lastHttpStatus, status)
    assert.equal(setup.reader.getDiagnostics().lastRankingReadable, null)
  }
  const redirect = browser({ redirect: url => url.replace('season_type=1', 'season_type=2') })
  await assert.rejects(redirect.reader.fetchPage(1, mrDistributionPageUrl(1)), errorCode('page-mismatch'))
  const raw = browser({ observe: () => { throw new Error('private-cookie-error') } })
  await assert.rejects(raw.reader.fetchPage(1, mrDistributionPageUrl(1)), error => error instanceof MrDistributionDomError
    && error.code === 'read-failed' && !error.message.includes('private-cookie-error'))
})

test('a rendered challenge stops after one observation before URL or hydration retries, independently of login and maintenance', async () => {
  const setup = browser({ observe: page => ({ ...observation(page), humanVerificationRequired: true,
    signedIn: null, authenticationEvidence: 'no-control', conditionsMatch: null, currentActMatch: null, entries: null }),
    redirect: () => 'https://www.streetfighter.com/security-check' })
  await assert.rejects(setup.reader.fetchPage(1, mrDistributionPageUrl(1)), errorCode('human-verification'))
  assert.equal(setup.requests.length, 1)
  assert.equal(setup.evaluations(), 1)
  assert.equal(setup.elapsed(), 0)
  assert.equal(setup.reader.getDiagnostics().successfulReadCount, 0)
})
