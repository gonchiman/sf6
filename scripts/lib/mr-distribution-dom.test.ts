import assert from 'node:assert/strict'
import test from 'node:test'
import type { TestContext } from 'node:test'
import type { Page } from 'playwright'
import { createMrDistributionPageReader, MrDistributionDomError, observeMrDistributionDom } from './mr-distribution-dom.ts'
import type { MrDistributionDomObservation, MrDistributionPageReaderOptions } from './mr-distribution-dom.ts'
import { mrDistributionPageUrl } from './mr-distribution-collector.ts'
import type { DistributionPageObservationSnapshot } from './distribution-page-observation.ts'
import { observeDistributionHumanVerification } from './distribution-human-verification.ts'

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
    assert.equal(observeDistributionHumanVerification(), true)
  }
  setup.nodes['h1,h2'] = []
  const button = node('開始')
  setup.nodes['#amzn-captcha-verify-button'] = [button]
  assert.equal(observeDistributionHumanVerification(), true)
  button.style.display = 'none'
  assert.equal(observeDistributionHumanVerification(), false)
})

// The fixture models the separate common DOM guard alongside each ranking sample.
type SyntheticObservation = MrDistributionDomObservation & { humanVerificationRequired?: boolean }
function observation(page = 1, total = 43): SyntheticObservation {
  const from = (page - 1) * 20 + 1, to = Math.min(page * 20, total)
  return { maintenance: false, humanVerificationRequired: false, loginRequiredHeading: false, signedIn: true, authenticationEvidence: 'logout-control',
    conditionsMatch: true, currentActMatch: true, selectedPage: page, range: { from, to, total },
    entries: Array.from({ length: to - from + 1 }, (_, i) => ({ masterRating: 1600 - from - i, accountKey: (from + i).toString(16).padStart(64, '0') })) }
}
function browser(configuration: {
  observe?: (page: number, count: number, readOnly?: boolean) => SyntheticObservation
  status?: number; redirect?: (url: string) => string
  headers?: (requestCount: number) => Record<string, string>
  humanVerification?: (checks: number) => boolean
  options?: MrDistributionPageReaderOptions
} = {}) {
  let clock = 0, evaluations = 0, currentUrl = '', pageNumber = 1
  let guardChecks = 0
  let latest: SyntheticObservation | null = null
  const requests: string[] = [], waits: number[] = []
  const fake = {
    goto: async (url: string) => { requests.push(url); latest = null; pageNumber = Number(new URL(url).searchParams.get('page')); currentUrl = configuration.redirect?.(url) ?? url
      return { status: () => configuration.status ?? 200, url: () => currentUrl, headers: () => configuration.headers?.(requests.length) ?? {} } },
    url: () => currentUrl,
    evaluate: async (fn: unknown, input?: { readOnly?: boolean }) => {
      if (fn === observeDistributionHumanVerification) return configuration.humanVerification?.(++guardChecks) ?? latest?.humanVerificationRequired === true
      assert.equal(fn, observeMrDistributionDom)
      evaluations++; latest = configuration.observe?.(pageNumber, evaluations, input?.readOnly) ?? observation(pageNumber)
      return latest
    },
  } as unknown as Page
  const reader = createMrDistributionPageReader(fake, { now: () => clock,
    wait: async ms => { waits.push(ms); clock += ms }, ...configuration.options })
  return { reader, fake, requests, waits, evaluations: () => evaluations, elapsed: () => clock }
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

test('external pacing gates each MR navigation without a second internal wait', async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let starts = 0
  const setup = browser({ options: { navigateWithPacing: async navigate => { starts++; await gate; return navigate() } } })
  const first = setup.reader.fetchPage(1)
  await Promise.resolve()
  assert.equal(starts, 1)
  assert.equal(setup.requests.length, 0)
  release()
  await first
  await setup.reader.fetchPage(2)
  assert.equal(starts, 2)
  assert.deepEqual(setup.waits, [])
  const controller = new AbortController()
  const stopped = browser({ options: { signal: controller.signal,
    navigateWithPacing: navigate => { controller.abort(); return navigate() } } })
  await assert.rejects(stopped.reader.fetchPage(1), errorCode('cancelled'))
  assert.equal(stopped.requests.length, 0)
  assert.throws(() => browser({ options: { navigateWithPacing: true as never } }), errorCode('invalid-request'))
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

test('a slow MR sample gets one passive refresh before stale authentication is rejected', async () => {
  let clock = 0
  const modes: boolean[] = []
  const setup = browser({ observe: (page, count, readOnly) => {
    modes.push(readOnly === true)
    if (count === 1) {
      clock = 20000
      return { ...observation(page), signedIn: false, authenticationEvidence: 'login-control', entries: null }
    }
    return observation(page)
  }, options: { now: () => clock, wait: async () => { assert.fail('a final passive sample must not add a wait') } } })
  const result = await setup.reader.fetchPage(1)
  assert.equal(result.entries.length, 20)
  assert.deepEqual(modes, [false, true])
  assert.equal(setup.requests.length, 1)
  assert.equal(setup.evaluations(), 2)
  assert.equal(setup.reader.getDiagnostics().successfulReadCount, 1)
  assert.equal(setup.reader.getDiagnostics().lastAuthenticationEvidence, 'logout-control')
  assert.equal(setup.reader.getDiagnostics().readableWithoutSignInReadCount, 0)
})

test('the final MR sample preserves strict authentication, current Act, page and complete-layout checks', async () => {
  const cases: { patch: Partial<MrDistributionDomObservation>; code: string }[] = [
    { patch: { signedIn: false, authenticationEvidence: 'login-control' }, code: 'authentication-unconfirmed' },
    { patch: { loginRequiredHeading: true }, code: 'login-required' },
    { patch: { conditionsMatch: false }, code: 'condition-mismatch' },
    { patch: { currentActMatch: false }, code: 'condition-mismatch' },
    { patch: { selectedPage: 2 }, code: 'page-mismatch' },
    { patch: { entries: observation().entries!.slice(0, 19) }, code: 'unsupported-dom' },
    { patch: { entries: null }, code: 'read-failed' },
    { patch: { humanVerificationRequired: true }, code: 'human-verification' },
  ]
  for (const { patch, code } of cases) {
    let clock = 0
    const modes: boolean[] = []
    const setup = browser({ observe: (page, count, readOnly) => {
      modes.push(readOnly === true)
      clock = 20000
      return count === 1
        ? { ...observation(page), signedIn: false, authenticationEvidence: 'login-control', entries: null }
        : { ...observation(page), ...patch }
    }, options: { now: () => clock, wait: async () => { assert.fail('a final passive sample must not add a wait') } } })
    await assert.rejects(setup.reader.fetchPage(1), errorCode(code))
    assert.deepEqual(modes, [false, true], code)
    assert.equal(setup.requests.length, 1)
    assert.equal(setup.evaluations(), 2)
    assert.equal(setup.reader.getDiagnostics().successfulReadCount, 0)
  }
})

test('MR deadline headings, human verification and cancellation stop without extra observation or acceptance', async () => {
  for (const [patch, code] of [
    [{ loginRequiredHeading: true }, 'login-required'],
    [{ humanVerificationRequired: true }, 'human-verification'],
  ] as const) {
    let clock = 0
    const setup = browser({ observe: (page, count) => {
      clock = 20000
      return count === 1 ? { ...observation(page), ...patch } : observation(page)
    }, options: { now: () => clock } })
    await assert.rejects(setup.reader.fetchPage(1), errorCode(code))
    assert.equal(setup.evaluations(), 1)
    assert.equal(setup.requests.length, 1)
  }
  for (const abortAt of [1, 2]) {
    let clock = 0
    const controller = new AbortController()
    const setup = browser({ observe: (page, count) => {
      clock = 20000
      if (count === abortAt) controller.abort()
      return count === 1
        ? { ...observation(page), signedIn: false, authenticationEvidence: 'login-control', entries: null }
        : observation(page)
    }, options: { now: () => clock, signal: controller.signal } })
    await assert.rejects(setup.reader.fetchPage(1), errorCode('cancelled'))
    assert.equal(setup.evaluations(), abortAt)
    assert.equal(setup.requests.length, 1)
    assert.equal(setup.reader.getDiagnostics().successfulReadCount, 0)
  }
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

test('trusted document CAPTCHA and Challenge headers stop before HTTP classification or DOM observation', async () => {
  for (const [status, action] of [[405, 'captcha'], [202, 'challenge'], [200, 'captcha']] as const) {
    const setup = browser({ status, headers: () => ({ 'x-amzn-waf-action': action, 'set-cookie': 'private-session', authorization: 'private-token' }) })
    await assert.rejects(setup.reader.fetchPage(1), errorCode('human-verification'))
    const diagnostics = setup.reader.getDiagnostics()
    assert.equal(diagnostics.lastHttpStatus, status)
    assert.equal(diagnostics.successfulReadCount, 0)
    assert.deepEqual(diagnostics.humanVerification, { wafHeaderChecked: true, wafAction: action, domDetected: null })
    assert.equal(diagnostics.lastAuthenticationEvidence, null)
    assert.equal(setup.requests.length, 1)
    assert.equal(setup.evaluations(), 0)
    assert.deepEqual(setup.waits, [])
    assert.doesNotMatch(JSON.stringify(diagnostics), /private-session|private-token|set-cookie|authorization|https?:/)
    diagnostics.humanVerification!.wafAction = null
    assert.equal(setup.reader.getDiagnostics().humanVerification!.wafAction, action)
  }
})

test('405 alone, unknown WAF values and unreadable headers do not fabricate a CAPTCHA diagnosis', async () => {
  for (const [headers, checked] of [
    [() => ({}), true], [() => ({ 'x-amzn-waf-action': 'private-unknown-token' }), true],
    [() => { throw new Error('private-header-error') }, false],
  ] as const) {
    const setup = browser({ status: 405, headers })
    await assert.rejects(setup.reader.fetchPage(1), errorCode('http-error'))
    assert.deepEqual(setup.reader.getDiagnostics().humanVerification, { wafHeaderChecked: checked, wafAction: null, domDetected: null })
    assert.equal(setup.evaluations(), 0)
    assert.doesNotMatch(JSON.stringify(setup.reader.getDiagnostics()), /private-unknown-token|private-header-error/)
  }
})

test('only Buckler and CAPCOM HTTPS document responses establish WAF evidence', async () => {
  for (const url of ['https://example.com/check', 'https://www.streetfighter.com.example.com/check', 'http://www.streetfighter.com/check']) {
    const setup = browser({ status: 405, redirect: () => url, headers: () => ({ 'x-amzn-waf-action': 'captcha' }) })
    await assert.rejects(setup.reader.fetchPage(1), errorCode('http-error'))
    assert.deepEqual(setup.reader.getDiagnostics().humanVerification, { wafHeaderChecked: false, wafAction: null, domDetected: null })
  }
  for (const url of ['https://cid.capcom.com/check', 'https://auth.cid.capcom.com/check']) {
    const setup = browser({ status: 405, redirect: () => url, headers: () => ({ 'x-amzn-waf-action': 'captcha' }) })
    await assert.rejects(setup.reader.fetchPage(1), errorCode('human-verification'))
    assert.equal(setup.reader.getDiagnostics().humanVerification?.wafAction, 'captcha')
  }
})

test('a later explicit navigation resets WAF evidence rather than inheriting the previous response', async () => {
  const setup = browser({ status: 405, headers: n => n === 1 ? { 'x-amzn-waf-action': 'captcha' } : {} })
  await assert.rejects(setup.reader.fetchPage(1), errorCode('human-verification'))
  await assert.rejects(setup.reader.fetchPage(1), errorCode('http-error'))
  assert.deepEqual(setup.reader.getDiagnostics().humanVerification, { wafHeaderChecked: true, wafAction: null, domDetected: null })
})

test('rendered human verification and an ordinary readable page remain separate from WAF evidence', async () => {
  const normal = browser()
  await normal.reader.fetchPage(1)
  assert.deepEqual(normal.reader.getDiagnostics().humanVerification, { wafHeaderChecked: true, wafAction: null, domDetected: false })
  const rendered = browser({ observe: n => ({ ...observation(n), humanVerificationRequired: true }) })
  await assert.rejects(rendered.reader.fetchPage(1), errorCode('human-verification'))
  assert.deepEqual(rendered.reader.getDiagnostics().humanVerification, { wafHeaderChecked: true, wafAction: null, domDetected: true })
  assert.equal(rendered.requests.length, 1)
})

test('MR common DOM guard stops before ranking parsing and rechecks a challenge appearing during parsing', async () => {
  for (const phase of ['before', 'after']) {
    const setup = browser({ humanVerification: checks => checks >= (phase === 'before' ? 1 : 2), observe: page => {
      if (phase === 'before') assert.fail('a visible challenge must stop before ranking parsing can fail')
      return observation(page)
    } })
    await assert.rejects(setup.reader.fetchPage(1), errorCode('human-verification'))
    assert.deepEqual(setup.reader.getDiagnostics().humanVerification, { wafHeaderChecked: true, wafAction: null, domDetected: true })
    assert.equal(setup.reader.getDiagnostics().successfulReadCount, 0)
    assert.equal(setup.evaluations(), phase === 'before' ? 0 : 1)
    assert.equal(setup.requests.length, 1)
  }
})

test('passive MR protection checks surround ranking observation and preserve the stopped attempt diagnostics', async () => {
  for (const phase of ['before', 'after']) {
    let armed = false, checks = 0
    const setup = browser({ humanVerification: () => armed && ++checks >= (phase === 'before' ? 1 : 2), observe: page => {
      if (armed && phase === 'before') assert.fail('passive protection must stop before ranking parsing')
      return observation(page)
    } })
    await setup.reader.fetchPage(1)
    const before = setup.reader.getDiagnostics(), evaluations = setup.evaluations()
    armed = true
    await assert.rejects(setup.reader.observeCurrentPage(1), errorCode('human-verification'))
    assert.deepEqual(setup.reader.getDiagnostics(), before)
    assert.equal(setup.evaluations(), evaluations + (phase === 'before' ? 0 : 1))
    assert.equal(setup.requests.length, 1)
  }
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

test('passive MR DOM observation leaves scroll position unchanged and does not wait', async t => {
  dom(t)
  window.scrollTo = () => { assert.fail('passive observation must not scroll') }
  t.mock.method(globalThis, 'setTimeout', (() => { assert.fail('passive observation must not settle the page') }) as typeof setTimeout)
  const value = await observeMrDistributionDom({ salt: 'passive-capture', readOnly: true })
  assert.equal(value.authenticationEvidence, 'logout-control')
  assert.equal(value.entries?.length, 2)
})

test('each existing MR fetch poll emits only normalized safe evidence and callback errors cannot affect acceptance', async () => {
  const snapshots: DistributionPageObservationSnapshot[] = []
  const setup = browser({ observe: (page, count) => count === 1
    ? { ...observation(page), signedIn: null, authenticationEvidence: 'private-raw-value', loginRequiredHeading: 'private-heading', entries: null } as unknown as MrDistributionDomObservation
    : count === 2 ? { ...observation(page), signedIn: false, authenticationEvidence: 'login-control' } : observation(page),
  options: { onObservation: snapshot => { snapshots.push(snapshot); throw new Error('private-callback-error') } } })
  await setup.reader.fetchPage(1)
  assert.deepEqual(snapshots, [
    { authenticationEvidence: null, loginRequiredHeading: null, rankingReadable: false },
    { authenticationEvidence: 'login-control', loginRequiredHeading: false, rankingReadable: true },
    { authenticationEvidence: 'logout-control', loginRequiredHeading: false, rankingReadable: true },
  ])
  assert.equal(setup.evaluations(), snapshots.length)
  assert.equal(setup.requests.length, 1)
  assert.equal(setup.reader.getDiagnostics().successfulReadCount, 1)
  assert.equal(setup.elapsed(), 500)
})

test('passive MR samples after stop ignore the collection abort and preserve the failed attempt without navigation', async t => {
  const controller = new AbortController()
  const snapshots: DistributionPageObservationSnapshot[] = []
  let recovered = false
  const setup = browser({ observe: page => ({ ...observation(page), ...(page === 1 || recovered ? {}
    : { signedIn: false, authenticationEvidence: 'login-control' as const }) }),
  options: { signal: controller.signal, onObservation: snapshot => { snapshots.push(snapshot) } } })
  await setup.reader.fetchPage(1)
  await assert.rejects(setup.reader.fetchPage(3), errorCode('authentication-unconfirmed'))
  const diagnostics = setup.reader.getDiagnostics(), elapsed = setup.elapsed(), emitted = snapshots.length
  const evaluations = setup.evaluations()
  controller.abort()
  recovered = true
  const evaluate = setup.fake.evaluate.bind(setup.fake)
  t.mock.method(setup.fake, 'evaluate', (async (fn: unknown, input: unknown) => {
    assert.ok(fn === observeMrDistributionDom || fn === observeDistributionHumanVerification)
    if (fn === observeMrDistributionDom) assert.equal((input as { readOnly?: boolean }).readOnly, true)
    return evaluate(fn as never, input as never)
  }) as typeof setup.fake.evaluate)
  assert.deepEqual(await setup.reader.observeCurrentPage(3), {
    authenticationEvidence: 'logout-control', loginRequiredHeading: false, rankingReadable: true,
  })
  assert.deepEqual(setup.reader.getDiagnostics(), diagnostics)
  assert.equal(setup.elapsed(), elapsed)
  assert.equal(snapshots.length, emitted)
  assert.equal(setup.evaluations(), evaluations + 1)
  assert.deepEqual(setup.requests, [mrDistributionPageUrl(1), mrDistributionPageUrl(3)])
  await assert.rejects(setup.reader.fetchPage(3), errorCode('cancelled'))
})

test('passive MR readability reuses URL, known page size, current Act, controls, counters, order and duplicate validation', async t => {
  let patch: Partial<MrDistributionDomObservation> = {}
  const setup = browser({ observe: page => ({ ...observation(page), ...patch }) })
  await setup.reader.fetchPage(1)
  await setup.reader.fetchPage(3)
  const diagnostics = setup.reader.getDiagnostics()
  for (const invalid of [
    { conditionsMatch: false }, { currentActMatch: false }, { selectedPage: 2 },
    { range: { from: 7, to: 9, total: 43 } }, { entries: observation(3).entries!.slice(0, 2) },
    { entries: observation(3).entries!.map(entry => ({ ...entry, accountKey: 'a'.repeat(64) })) },
    { entries: [...observation(3).entries!].reverse() },
  ] satisfies Partial<MrDistributionDomObservation>[]) {
    patch = invalid
    assert.equal((await setup.reader.observeCurrentPage(3)).rankingReadable, false)
  }
  patch = { authenticationEvidence: 'private-raw-value', loginRequiredHeading: 'private-raw-heading' } as unknown as Partial<MrDistributionDomObservation>
  assert.deepEqual(await setup.reader.observeCurrentPage(3), { authenticationEvidence: null, loginRequiredHeading: null, rankingReadable: true })
  t.mock.method(setup.fake, 'url', () => mrDistributionPageUrl(3).replace('season_type=1', 'season_type=2'))
  assert.equal((await setup.reader.observeCurrentPage(3)).rankingReadable, false)
  assert.deepEqual(setup.reader.getDiagnostics(), diagnostics)
  assert.equal(setup.requests.length, 2)
})

test('passive MR observation sanitizes browser errors and invalid input causes no navigation', async () => {
  const setup = browser({ observe: () => { throw new Error('private-cookie-error') } })
  await assert.rejects(setup.reader.observeCurrentPage(1), error => error instanceof MrDistributionDomError
    && error.code === 'read-failed' && !error.message.includes('private-cookie-error'))
  await assert.rejects(setup.reader.observeCurrentPage(0), errorCode('invalid-request'))
  assert.equal(setup.requests.length, 0)
  assert.equal(setup.reader.getDiagnostics().requestCount, 0)
})
