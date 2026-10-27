import assert from 'node:assert/strict'
import test from 'node:test'
import type { TestContext } from 'node:test'
import type { Page } from 'playwright'
import { createRankDistributionPageReader, observeRankDistributionDom, RankDistributionDomError } from './rank-distribution-dom.ts'
import type { RankDistributionDomErrorCode, RankDistributionDomObservation, RankDistributionPageReaderOptions } from './rank-distribution-dom.ts'
import { rankBoundaryPageUrl, RANK_BOUNDARY_SOURCE_URL } from './rank-distribution-boundaries.ts'
import type { DistributionPageObservationSnapshot } from './distribution-page-observation.ts'

type FakeElement = {
  innerText: string; textContent: string; parentElement: FakeElement | null; value: string
  options: FakeElement[]; selectedOptions: FakeElement[]
  complete: boolean; naturalWidth: number; currentSrc: string; scrolls: number
  style: { display: string; visibility: string; opacity: string }
  getBoundingClientRect(): { width: number; height: number }
  getAttribute(name: string): string | null
  hasAttribute(name: string): boolean
  closest(selector: string): FakeElement | null
  querySelectorAll(selector: string): FakeElement[]
  scrollIntoView(): void
}

function element(text = '', children: Record<string, FakeElement[]> = {}, attributes: Record<string, string> = {}): FakeElement {
  return {
    innerText: text, textContent: text, parentElement: null, value: '', options: [], selectedOptions: [],
    complete: true, naturalWidth: 100, currentSrc: '', scrolls: 0,
    style: { display: 'block', visibility: 'visible', opacity: '1' },
    getBoundingClientRect: () => ({ width: 100, height: 20 }),
    getAttribute: name => attributes[name] ?? null,
    hasAttribute: name => Object.hasOwn(attributes, name),
    closest: () => null,
    querySelectorAll: selector => children[selector] ?? [],
    scrollIntoView() { this.scrolls++ },
  }
}

function select(value: string, label: string, options: FakeElement[] = []): FakeElement {
  return Object.assign(element(), { value, options, selectedOptions: [element(label)] })
}

function setDom(t: TestContext, nodes: Record<string, FakeElement[]>): void {
  const globals: Record<string, unknown> = {
    document: { querySelectorAll: (selector: string) => nodes[selector] ?? [] },
    window: { getComputedStyle: (node: FakeElement) => node.style },
    location: { origin: 'https://www.streetfighter.com' },
  }
  const previous = Object.keys(globals).map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const)
  for (const [name, value] of Object.entries(globals)) Object.defineProperty(globalThis, name, { configurable: true, value })
  t.mock.method(globalThis, 'setTimeout', ((callback: () => void) => { callback(); return 0 }) as unknown as typeof setTimeout)
  t.after(() => {
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else Reflect.deleteProperty(globalThis, name)
    }
  })
}

function fixture(rankId = 36, lp = 25000) {
  const asset = `/6/buckler/assets/images/material/rank/rank${rankId}_l.png`
  const image = Object.assign(element(), { currentSrc: `https://www.streetfighter.com/_next/image?url=${encodeURIComponent(asset)}&w=256&q=75` })
  const icon = element('', { img: [image] })
  const row = element('private-player-name', {
    dt: [element('1位')], dd: [element(`${lp}LP`)], 'div[class*="ranking_league_rank_icon"]': [icon],
  }, { href: '/6/buckler/ja-jp/profile/987654321' })
  const labels = ['総合', ...['Rookie', 'Iron', 'Bronze', 'Silver', 'Gold', 'Platinum', 'Diamond']
    .flatMap(group => Array.from({ length: 5 }, (_, i) => `${group}${i + 1}`)), 'Master']
  const leagueOptions = labels.map((label, i) => Object.assign(element(label), { value: String(i) }))
  const nodes: Record<string, FakeElement[]> = {
    'h1,h2': [], 'a,button': [element('ログアウト')], p: [element('1 - 1 / 1')],
    select: [select('0', '総合', leagueOptions), select('2', '最大LP'), select('0', 'すべて'), select('1', 'すべて'), select('1', '1'), select('1', '1')],
    'ul[class*="ranking_ranking_list"]:not([class*="ranking__my__list"])': [element('', { 'a[href*="/profile/"]': [row] })],
  }
  return { nodes, row, image, icon }
}

test('rendered rank image and official labels are read without exposing player names or raw identifiers', async t => {
  const { nodes, icon } = fixture()
  setDom(t, nodes)
  const first = await observeRankDistributionDom({ salt: 'capture-one' })
  const second = await observeRankDistributionDom({ salt: 'capture-two' })
  assert.equal(first.conditionsMatch, true)
  assert.equal(first.leagueLabelsMatch, true)
  assert.equal(first.signedIn, true)
  assert.equal(first.authenticationEvidence, 'logout-control')
  assert.equal(first.loginRequiredHeading, false)
  assert.equal(first.rankIcons, 'ready')
  assert.equal(first.entries?.[0].rankId, 36)
  assert.equal(first.entries?.[0].leaguePoint, 25000)
  assert.match(first.entries![0].accountKey!, /^[a-f0-9]{64}$/)
  assert.notEqual(first.entries![0].accountKey, second.entries![0].accountKey)
  assert.equal(icon.scrolls, 2)
  assert.doesNotMatch(JSON.stringify(first), /private-player-name|987654321|\/profile\//)
})

test('the official Next image wrapper supports its observed Buckler base path', async t => {
  const { nodes, image } = fixture()
  image.currentSrc = image.currentSrc.replace('/_next/image?', '/6/buckler/_next/image?')
  setDom(t, nodes)
  const result = await observeRankDistributionDom({ salt: 'capture' })
  assert.equal(result.rankIcons, 'ready')
  assert.equal(result.entries?.[0].rankId, 36)
})

test('visible login controls and an explicit login-required heading remain separate evidence', async t => {
  const { nodes } = fixture()
  nodes['a,button'] = [element('ログイン')]
  setDom(t, nodes)
  const buttonOnly = await observeRankDistributionDom({ salt: 'capture' })
  assert.equal(buttonOnly.authenticationEvidence, 'login-control')
  assert.equal(buttonOnly.loginRequiredHeading, false)
  assert.equal(buttonOnly.loginRequired, false)
  assert.equal(buttonOnly.rankIcons, 'ready')

  nodes['h1,h2'] = [element('ログインしてください')]
  const heading = await observeRankDistributionDom({ salt: 'capture' })
  assert.equal(heading.authenticationEvidence, 'login-control')
  assert.equal(heading.loginRequiredHeading, true)
  assert.equal(heading.loginRequired, true)
  assert.equal(heading.entries, null)

  nodes['h1,h2'] = []
  nodes['a,button'] = [element('ログイン'), element('ログアウト')]
  assert.equal((await observeRankDistributionDom({ salt: 'capture' })).authenticationEvidence, 'conflicting-controls')
  const hidden = element('ログアウト'); hidden.style.visibility = 'hidden'
  nodes['a,button'] = [hidden]
  assert.equal((await observeRankDistributionDom({ salt: 'capture' })).authenticationEvidence, 'no-control')
})

test('normal scrolling resolves a lazy rank1 image at 0LP independently of LP-based assumptions', async t => {
  const { nodes, image, icon } = fixture(1, 0)
  const actual = image.currentSrc
  image.currentSrc = 'data:image/png;base64,placeholder'
  image.naturalWidth = 1
  icon.scrollIntoView = () => { icon.scrolls++; image.currentSrc = actual; image.naturalWidth = 100 }
  setDom(t, nodes)
  const result = await observeRankDistributionDom({ salt: 'capture' })
  assert.equal(result.rankIcons, 'ready')
  assert.equal(result.entries?.[0].rankId, 1)
  assert.equal(result.entries?.[0].leaguePoint, 0)
  assert.equal(icon.scrolls, 1)
})

test('unknown, nested, external and unloaded rank icons are never filled with a presumed rank', async t => {
  const { nodes, image } = fixture()
  setDom(t, nodes)
  for (const source of [
    'https://www.streetfighter.com/6/buckler/assets/images/material/rank/rank0_l.png',
    'https://www.streetfighter.com/6/buckler/assets/images/material/rank/rank37_l.png',
    'https://example.com/6/buckler/assets/images/material/rank/rank1_l.png',
    'https://www.streetfighter.com/_next/image?url=%2F_next%2Fimage%3Furl%3Dprivate',
  ]) {
    image.currentSrc = source
    const result = await observeRankDistributionDom({ salt: 'capture' })
    assert.equal(result.rankIcons, 'unsupported')
    assert.equal(result.entries, null)
    assert.ok(!JSON.stringify(result).includes(source))
  }
  image.currentSrc = 'data:image/png;base64,placeholder'
  assert.equal((await observeRankDistributionDom({ salt: 'capture' })).rankIcons, 'pending')
})

test('hidden logout and public player names cannot establish login; the own-card list is excluded', async t => {
  const { nodes } = fixture()
  const hidden = element('ログアウト'); hidden.style.visibility = 'hidden'
  const nickname = element('ログアウト'); nickname.closest = () => nickname
  nodes['a,button'] = [hidden, nickname, element('ログイン')]
  // Only the non-own-list selector is queried by the observer.
  nodes['ul[class*="ranking_ranking_list"]'] = [element('private own card')]
  setDom(t, nodes)
  const result = await observeRankDistributionDom({ salt: 'capture' })
  assert.equal(result.signedIn, false)
  assert.equal(result.entries?.length, 1)
  nodes.select[0].options[1].textContent = 'Unconfirmed'
  assert.equal((await observeRankDistributionDom({ salt: 'capture' })).leagueLabelsMatch, false)
})

test('each observation returns to the top before checking a header that hides during ordinary image scrolling', async t => {
  const { nodes, icon } = fixture()
  const header = element()
  nodes['a,button'][0].parentElement = header
  icon.scrollIntoView = () => { icon.scrolls++; header.style.opacity = '0' }
  setDom(t, nodes)
  let topScrolls = 0
  window.scrollTo = ((options: ScrollToOptions) => {
    assert.deepEqual(options, { top: 0, left: 0, behavior: 'instant' })
    topScrolls++
    header.style.opacity = '1'
  }) as typeof window.scrollTo
  const first = await observeRankDistributionDom({ salt: 'capture' })
  assert.equal(header.style.opacity, '0')
  const second = await observeRankDistributionDom({ salt: 'capture' })
  assert.equal(first.signedIn, true)
  assert.equal(second.signedIn, true)
  assert.equal(topScrolls, 2)
  assert.equal(icon.scrolls, 2)

  const hiddenLogout = element('ログアウト')
  hiddenLogout.style.visibility = 'hidden'
  nodes['a,button'] = [hiddenLogout]
  assert.equal((await observeRankDistributionDom({ salt: 'capture' })).signedIn, null)
  nodes['a,button'] = [element('ログイン')]
  assert.equal((await observeRankDistributionDom({ salt: 'capture' })).signedIn, false)
})

function observation(page = 1, total = 43): RankDistributionDomObservation {
  const from = (page - 1) * 20 + 1
  const to = Math.min(page * 20, total)
  return {
    maintenance: false, loginRequired: false, signedIn: true, authenticationEvidence: 'logout-control', loginRequiredHeading: false,
    conditionsMatch: true, leagueLabelsMatch: true,
    selectedPage: page, range: { from, to, total }, rankIcons: 'ready',
    entries: Array.from({ length: to - from + 1 }, (_, i) => ({ leaguePoint: 30000 - from - i,
      rankId: page === 1 ? 36 : 1, accountKey: (from + i).toString(16).padStart(64, '0') })),
  }
}

function harness(observe: (page: number, evaluation: number, readOnly?: boolean) => RankDistributionDomObservation = page => observation(page), status = 200,
  options: RankDistributionPageReaderOptions = {}) {
  let currentUrl = ''
  let evaluations = 0
  let clock = 0
  const navigations: string[] = []
  const navigationTimes: number[] = []
  const fakePage = {
    goto: async (url: string) => { currentUrl = url; navigations.push(url); navigationTimes.push(clock); return { status: () => status } },
    url: () => currentUrl,
    evaluate: async (_fn: unknown, input?: { readOnly?: boolean }) => observe(Number(new URL(currentUrl).searchParams.get('page')), ++evaluations, input?.readOnly),
  } as unknown as Page
  const reader = createRankDistributionPageReader(fakePage, { timeoutMs: 1000, now: () => clock, wait: async ms => { clock += ms }, ...options })
  return { reader, fakePage, navigations, navigationTimes, evaluations: () => evaluations, elapsed: () => clock }
}

const pageUrl = (page: number) => rankBoundaryPageUrl(RANK_BOUNDARY_SOURCE_URL, page)
const errorCode = (code: RankDistributionDomErrorCode) => (error: unknown): boolean => {
  assert.ok(error instanceof RankDistributionDomError)
  assert.equal(error.code, code)
  assert.doesNotMatch(error.message, /private-token|private-player|https?:/)
  return true
}

test('reader measures first-page size and confirms deep and final pages from select/range, not option-window length', async () => {
  const { reader, navigations } = harness()
  const first = await reader.fetchPage(1, pageUrl(1))
  const last = await reader.fetchPage(first.totalPages, pageUrl(first.totalPages))
  assert.deepEqual([first.pageSize, first.totalPages, first.totalCount], [20, 3, 43])
  assert.deepEqual([last.page, last.entries.length], [3, 3])
  assert.deepEqual(navigations, [pageUrl(1), pageUrl(3)])
  assert.deepEqual(reader.getDiagnostics(), {
    requestCount: 2, successfulReadCount: 2, pageSize: 20, totalCount: 43, lastPage: 3, rankMappingConfirmed: true,
    lastObservedTotal: 43, lastAttemptedPage: 3, lastHttpStatus: 200, minimumObservedTotal: 43, maximumObservedTotal: 43,
    lastAuthenticationEvidence: 'logout-control', lastLoginRequiredHeading: false, lastRankingReadable: true,
    readableWithoutSignInReadCount: 0,
    observedRankIds: [1, 36], tailRankIds: [1], leagueLabelsConfirmed: true, displayedConditionsConfirmed: true,
    userStatusEvidence: 'fixed-url-only',
  })
  const copy = reader.getDiagnostics(); copy.observedRankIds.push(99)
  assert.deepEqual(reader.getDiagnostics().observedRankIds, [1, 36])
  assert.ok(!JSON.stringify(reader.getDiagnostics()).includes('accountKey'))
})

test('reader requires first page and exact fixed-condition URLs before navigation', async () => {
  const { reader, navigations } = harness()
  await assert.rejects(reader.fetchPage(2, pageUrl(2)), errorCode('first-page-required'))
  for (const url of [pageUrl(1).replace('user_status=1', 'user_status=0'), pageUrl(1) + '&token=private-token', pageUrl(2)]) {
    await assert.rejects(reader.fetchPage(1, url), errorCode('invalid-request'))
  }
  assert.equal(navigations.length, 0)
})

test('external pacing gates each LP navigation without a second internal wait', async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let starts = 0
  const setup = harness(undefined, 200, { navigateWithPacing: async navigate => { starts++; await gate; return navigate() } })
  const first = setup.reader.fetchPage(1, pageUrl(1))
  await Promise.resolve()
  assert.equal(starts, 1)
  assert.equal(setup.navigations.length, 0)
  release()
  await first
  await setup.reader.fetchPage(2, pageUrl(2))
  assert.equal(starts, 2)
  assert.deepEqual(setup.navigationTimes, [0, 0])
  const controller = new AbortController()
  const stopped = harness(undefined, 200, { signal: controller.signal,
    navigateWithPacing: navigate => { controller.abort(); return navigate() } })
  await assert.rejects(stopped.reader.fetchPage(1, pageUrl(1)), errorCode('cancelled'))
  assert.equal(stopped.navigations.length, 0)
  assert.throws(() => harness(undefined, 200, { navigateWithPacing: true as never }), errorCode('invalid-request'))
})

test('reader waits for page hydration, selected page, counters, authentication and lazy images together', async () => {
  const { reader, evaluations } = harness((page, evaluation) => evaluation === 1
    ? { ...observation(page), signedIn: false, selectedPage: null, entries: null, rankIcons: 'pending' }
    : observation(page))
  assert.equal((await reader.fetchPage(1, pageUrl(1))).entries.length, 20)
  assert.equal(evaluations(), 2)
})

test('a slow LP sample gets one passive refresh before stale authentication is rejected', async () => {
  let clock = 0
  const modes: boolean[] = []
  const setup = harness((page, count, readOnly) => {
    modes.push(readOnly === true)
    if (count === 1) {
      clock = 2000
      return { ...observation(page), signedIn: false, authenticationEvidence: 'login-control', rankIcons: 'pending', entries: null }
    }
    return observation(page)
  }, 200, { now: () => clock, wait: async () => { assert.fail('a final passive sample must not add a wait') } })
  const result = await setup.reader.fetchPage(1, pageUrl(1))
  assert.equal(result.entries.length, 20)
  assert.deepEqual(modes, [false, true])
  assert.equal(setup.navigations.length, 1)
  assert.equal(setup.evaluations(), 2)
  assert.equal(setup.reader.getDiagnostics().successfulReadCount, 1)
  assert.equal(setup.reader.getDiagnostics().lastAuthenticationEvidence, 'logout-control')
  assert.equal(setup.reader.getDiagnostics().readableWithoutSignInReadCount, 0)
})

test('the final LP sample preserves strict authentication, condition, page and complete-layout checks', async () => {
  const cases: { patch: Partial<RankDistributionDomObservation>; code: RankDistributionDomErrorCode }[] = [
    { patch: { signedIn: false, authenticationEvidence: 'login-control' }, code: 'authentication-unconfirmed' },
    { patch: { loginRequiredHeading: true }, code: 'login-required' },
    { patch: { conditionsMatch: false }, code: 'condition-mismatch' },
    { patch: { selectedPage: 2 }, code: 'page-mismatch' },
    { patch: { entries: observation().entries!.slice(0, 19) }, code: 'unsupported-dom' },
    { patch: { rankIcons: 'pending', entries: null }, code: 'read-failed' },
  ]
  for (const { patch, code } of cases) {
    let clock = 0
    const modes: boolean[] = []
    const setup = harness((page, count, readOnly) => {
      modes.push(readOnly === true)
      clock = 2000
      return count === 1
        ? { ...observation(page), signedIn: false, authenticationEvidence: 'login-control', rankIcons: 'pending', entries: null }
        : { ...observation(page), ...patch }
    }, 200, { now: () => clock, wait: async () => { assert.fail('a final passive sample must not add a wait') } })
    await assert.rejects(setup.reader.fetchPage(1, pageUrl(1)), errorCode(code))
    assert.deepEqual(modes, [false, true], code)
    assert.equal(setup.navigations.length, 1)
    assert.equal(setup.evaluations(), 2)
    assert.equal(setup.reader.getDiagnostics().successfulReadCount, 0)
  }
})

test('LP deadline headings and cancellation cannot be rescued by a final passive sample', async () => {
  let clock = 0
  const heading = harness((page, count) => {
    clock = 2000
    return count === 1 ? { ...observation(page), loginRequiredHeading: true } : observation(page)
  }, 200, { now: () => clock })
  await assert.rejects(heading.reader.fetchPage(1, pageUrl(1)), errorCode('login-required'))
  assert.equal(heading.evaluations(), 1)
  assert.equal(heading.navigations.length, 1)
  for (const abortAt of [1, 2]) {
    let elapsed = 0
    const controller = new AbortController()
    const setup = harness((page, count) => {
      elapsed = 2000
      if (count === abortAt) controller.abort()
      return count === 1
        ? { ...observation(page), signedIn: false, authenticationEvidence: 'login-control', entries: null }
        : observation(page)
    }, 200, { now: () => elapsed, signal: controller.signal })
    await assert.rejects(setup.reader.fetchPage(1, pageUrl(1)), errorCode('cancelled'))
    assert.equal(setup.evaluations(), abortAt)
    assert.equal(setup.navigations.length, 1)
    assert.equal(setup.reader.getDiagnostics().successfulReadCount, 0)
  }
})

test('an initial login-required heading can hydrate into a signed-in readable page within one navigation', async () => {
  const ready = harness((page, evaluation) => evaluation === 1
    ? { ...observation(page), signedIn: false, authenticationEvidence: 'login-control', loginRequired: true,
      loginRequiredHeading: true, rankIcons: 'pending', entries: null }
    : observation(page))
  const result = await ready.reader.fetchPage(1, pageUrl(1))
  assert.equal(result.entries.length, 20)
  assert.equal(ready.navigations.length, 1)
  assert.equal(ready.evaluations(), 2)
  assert.equal(ready.reader.getDiagnostics().lastAuthenticationEvidence, 'logout-control')
  assert.equal(ready.reader.getDiagnostics().lastLoginRequiredHeading, false)
  assert.equal(ready.reader.getDiagnostics().lastRankingReadable, true)
})

test('a persistent login-required heading stops at the DOM deadline without a second navigation', async () => {
  const blocked = harness(() => ({ ...observation(), signedIn: false, authenticationEvidence: 'login-control',
    loginRequired: true, loginRequiredHeading: true, rankIcons: 'pending', entries: null }))
  await assert.rejects(blocked.reader.fetchPage(1, pageUrl(1)), errorCode('login-required'))
  assert.equal(blocked.navigations.length, 1)
  assert.ok(blocked.evaluations() > 1)
  assert.equal(blocked.reader.getDiagnostics().lastAuthenticationEvidence, 'login-control')
  assert.equal(blocked.reader.getDiagnostics().lastLoginRequiredHeading, true)
  assert.equal(blocked.reader.getDiagnostics().lastRankingReadable, false)
  assert.equal(blocked.reader.getDiagnostics().successfulReadCount, 0)
})

test('a login-required heading with logout controls waits for consistent signed-in evidence in the same navigation', async () => {
  const ready = harness((page, evaluation) => evaluation === 1
    ? { ...observation(page), loginRequiredHeading: true, loginRequired: false }
    : observation(page))
  const result = await ready.reader.fetchPage(1, pageUrl(1))
  assert.equal(result.entries.length, 20)
  assert.equal(ready.navigations.length, 1)
  assert.equal(ready.evaluations(), 2)
  assert.equal(ready.reader.getDiagnostics().successfulReadCount, 1)
  assert.equal(ready.reader.getDiagnostics().lastLoginRequiredHeading, false)
})

test('a persistent login-required heading cannot be overridden by logout controls and readable rows', async () => {
  const blocked = harness(() => ({ ...observation(), loginRequiredHeading: true, loginRequired: false }))
  await assert.rejects(blocked.reader.fetchPage(1, pageUrl(1)), errorCode('login-required'))
  assert.equal(blocked.navigations.length, 1)
  assert.ok(blocked.evaluations() > 1)
  assert.equal(blocked.reader.getDiagnostics().lastAuthenticationEvidence, 'logout-control')
  assert.equal(blocked.reader.getDiagnostics().lastLoginRequiredHeading, true)
  assert.equal(blocked.reader.getDiagnostics().lastRankingReadable, true)
  assert.equal(blocked.reader.getDiagnostics().successfulReadCount, 0)
})

const loginControlPage = (page: number): RankDistributionDomObservation => ({ ...observation(page),
  signedIn: false, authenticationEvidence: 'login-control', loginRequired: false, loginRequiredHeading: false })

test('readable login-control pages cannot bootstrap the opt-in reader without a signed-in first page', async () => {
  const anonymous = harness(page => loginControlPage(page), 200, { allowReadablePagesAfterSignIn: true, timeoutMs: 10_000 })
  await assert.rejects(anonymous.reader.fetchPage(1, pageUrl(1)), errorCode('authentication-unconfirmed'))
  assert.equal(anonymous.reader.getDiagnostics().successfulReadCount, 0)
  assert.equal(anonymous.reader.getDiagnostics().readableWithoutSignInReadCount, 0)
  assert.equal(anonymous.navigations.length, 1)
  assert.ok(anonymous.elapsed() >= 10_000)
})

test('after confirmed sign-in, an opted-in login-control page is accepted only after the complete ten-second DOM wait', async () => {
  const readable = harness(page => page === 1 ? observation(page) : loginControlPage(page), 200,
    { allowReadablePagesAfterSignIn: true, timeoutMs: 10_000 })
  await readable.reader.fetchPage(1, pageUrl(1))
  assert.equal(readable.reader.getDiagnostics().readableWithoutSignInReadCount, 0)
  const result = await readable.reader.fetchPage(2, pageUrl(2))
  assert.equal(result.page, 2)
  assert.equal(result.entries.length, 20)
  assert.equal(readable.navigations.length, 2)
  assert.ok(readable.elapsed() - readable.navigationTimes[1] >= 10_000)
  const diagnostics = readable.reader.getDiagnostics()
  assert.equal(diagnostics.successfulReadCount, 2)
  assert.equal(diagnostics.readableWithoutSignInReadCount, 1)
  assert.equal(diagnostics.lastAuthenticationEvidence, 'login-control')
  assert.equal(diagnostics.lastLoginRequiredHeading, false)
  assert.equal(diagnostics.lastRankingReadable, true)
})

test('the opt-in accepts neither absent or conflicting controls nor explicit headings after initial sign-in', async () => {
  const cases: Array<{ patch: Partial<RankDistributionDomObservation>; code: RankDistributionDomErrorCode }> = [
    { patch: { signedIn: null, authenticationEvidence: 'no-control' }, code: 'authentication-unconfirmed' },
    { patch: { signedIn: null, authenticationEvidence: 'conflicting-controls' }, code: 'authentication-unconfirmed' },
    { patch: { loginRequired: true, loginRequiredHeading: true }, code: 'login-required' },
    { patch: { loginRequired: false, loginRequiredHeading: true }, code: 'login-required' },
  ]
  for (const item of cases) {
    const blocked = harness(page => page === 1 ? observation(page) : { ...loginControlPage(page), ...item.patch }, 200,
      { allowReadablePagesAfterSignIn: true })
    await blocked.reader.fetchPage(1, pageUrl(1))
    await assert.rejects(blocked.reader.fetchPage(2, pageUrl(2)), errorCode(item.code))
    assert.equal(blocked.reader.getDiagnostics().successfulReadCount, 1)
    assert.equal(blocked.reader.getDiagnostics().readableWithoutSignInReadCount, 0)
  }
})

test('malformed layouts, changed URLs, HTTP denial and maintenance remain refusals with the opt-in enabled', async t => {
  for (const patch of [
    { entries: [] },
    { range: { from: 22, to: 41, total: 43 } },
    { selectedPage: 1 },
  ] satisfies Array<Partial<RankDistributionDomObservation>>) {
    const blocked = harness(page => page === 1 ? observation(page) : { ...loginControlPage(page), ...patch }, 200,
      { allowReadablePagesAfterSignIn: true })
    await blocked.reader.fetchPage(1, pageUrl(1))
    await assert.rejects(blocked.reader.fetchPage(2, pageUrl(2)), errorCode('authentication-unconfirmed'))
    assert.equal(blocked.reader.getDiagnostics().readableWithoutSignInReadCount, 0)
  }
  const moved = harness(page => page === 1 ? observation(page) : loginControlPage(page), 200,
    { allowReadablePagesAfterSignIn: true })
  await moved.reader.fetchPage(1, pageUrl(1))
  t.mock.method(moved.fakePage, 'url', () => pageUrl(2) + '&token=private-token')
  await assert.rejects(moved.reader.fetchPage(2, pageUrl(2)), errorCode('page-mismatch'))
  assert.equal(moved.reader.getDiagnostics().readableWithoutSignInReadCount, 0)

  const denied = harness(page => observation(page), 200, { allowReadablePagesAfterSignIn: true })
  await denied.reader.fetchPage(1, pageUrl(1))
  t.mock.method(denied.fakePage, 'goto', async () => ({ status: () => 403 }) as never)
  await assert.rejects(denied.reader.fetchPage(2, pageUrl(2)), errorCode('http-denied'))
  assert.equal(denied.reader.getDiagnostics().readableWithoutSignInReadCount, 0)

  const maintenance = harness(page => page === 1 ? observation(page) : { ...loginControlPage(page), maintenance: true }, 200,
    { allowReadablePagesAfterSignIn: true })
  await maintenance.reader.fetchPage(1, pageUrl(1))
  await assert.rejects(maintenance.reader.fetchPage(2, pageUrl(2)), errorCode('maintenance'))
  assert.equal(maintenance.reader.getDiagnostics().readableWithoutSignInReadCount, 0)
})

test('default and explicitly disabled readers still require signed-in UI on every readable page', async () => {
  for (const options of [{}, { allowReadablePagesAfterSignIn: false }]) {
    const strict = harness(page => page === 1 ? observation(page) : loginControlPage(page), 200, options)
    await strict.reader.fetchPage(1, pageUrl(1))
    await assert.rejects(strict.reader.fetchPage(2, pageUrl(2)), errorCode('authentication-unconfirmed'))
    assert.equal(strict.reader.getDiagnostics().successfulReadCount, 1)
    assert.equal(strict.reader.getDiagnostics().readableWithoutSignInReadCount, 0)
  }
})

test('reader refuses a changing total, changed filters and unsupported loaded badges', async () => {
  const changing = harness(page => observation(page, page === 1 ? 43 : 44))
  await changing.reader.fetchPage(1, pageUrl(1))
  await assert.rejects(changing.reader.fetchPage(3, pageUrl(3)), errorCode('total-count-changed'))
  const diagnostics = changing.reader.getDiagnostics()
  assert.equal(diagnostics.totalCount, 43)
  assert.equal(diagnostics.lastPage, 1)
  assert.equal(diagnostics.lastObservedTotal, 44)
  assert.equal(diagnostics.lastAttemptedPage, 3)
  assert.equal(diagnostics.successfulReadCount, 1)
  for (const [patch, code] of [
    [{ conditionsMatch: false }, 'condition-mismatch'],
    [{ leagueLabelsMatch: false }, 'condition-mismatch'],
    [{ rankIcons: 'unsupported', entries: null }, 'unsupported-rank-icon'],
  ] as const) {
    const { reader } = harness(() => ({ ...observation(), ...patch }))
    await assert.rejects(reader.fetchPage(1, pageUrl(1)), errorCode(code))
  }
})

test('estimate reader records total increases and decreases while retaining page and source checks', async () => {
  const live = harness((page, evaluation) => observation(page, evaluation === 1 ? 43 : evaluation === 2 ? 44 : 42), 200,
    { totalCountPolicy: 'record' })
  await live.reader.fetchPage(1, pageUrl(1))
  assert.equal((await live.reader.fetchPage(3, pageUrl(3))).totalCount, 44)
  assert.equal((await live.reader.fetchPage(3, pageUrl(3))).totalCount, 42)
  const diagnostics = live.reader.getDiagnostics()
  assert.deepEqual([diagnostics.minimumObservedTotal, diagnostics.maximumObservedTotal, diagnostics.totalCount], [42, 44, 42])
  assert.equal(diagnostics.successfulReadCount, 3)
  const changed = harness(() => ({ ...observation(), conditionsMatch: false }), 200, { totalCountPolicy: 'record' })
  await assert.rejects(changed.reader.fetchPage(1, pageUrl(1)), errorCode('condition-mismatch'))
  const malformed = harness(() => ({ ...observation(), range: { from: 2, to: 21, total: 43 } }), 200, { totalCountPolicy: 'record' })
  await assert.rejects(malformed.reader.fetchPage(1, pageUrl(1)), errorCode('unsupported-dom'))
})

test('stale page and ranges time out without claiming arrival or inventing rows', async () => {
  const wrongPage = harness(() => ({ ...observation(), selectedPage: 2 }))
  await assert.rejects(wrongPage.reader.fetchPage(1, pageUrl(1)), errorCode('page-mismatch'))
  const wrongRange = harness(() => ({ ...observation(), range: { from: 2, to: 21, total: 43 } }))
  await assert.rejects(wrongRange.reader.fetchPage(1, pageUrl(1)), errorCode('unsupported-dom'))
  assert.equal(wrongRange.reader.getDiagnostics().successfulReadCount, 0)
})

test('signed-in pending rendering reaches read-failed at the deadline and can succeed in a later full page read', async () => {
  let hydrated = false
  const pending = harness(page => hydrated ? observation(page)
    : { ...observation(page), rankIcons: 'pending', entries: null })
  await assert.rejects(pending.reader.fetchPage(1, pageUrl(1)), errorCode('read-failed'))
  assert.equal(pending.navigations.length, 1)
  assert.equal(pending.reader.getDiagnostics().lastAuthenticationEvidence, 'logout-control')
  assert.equal(pending.reader.getDiagnostics().lastLoginRequiredHeading, false)
  assert.equal(pending.reader.getDiagnostics().lastRankingReadable, false)
  assert.equal(pending.reader.getDiagnostics().successfulReadCount, 0)
  hydrated = true
  assert.equal((await pending.reader.fetchPage(1, pageUrl(1))).entries.length, 20)
  assert.equal(pending.navigations.length, 2)
  assert.equal(pending.reader.getDiagnostics().successfulReadCount, 1)
})

test('missing rendered fields are transient, while ready invalid ranges and rows remain unsupported', async () => {
  for (const patch of [
    { rankIcons: 'pending' }, { entries: null }, { range: null },
  ] satisfies Array<Partial<RankDistributionDomObservation>>) {
    const pending = harness(() => ({ ...observation(), ...patch }))
    await assert.rejects(pending.reader.fetchPage(1, pageUrl(1)), errorCode('read-failed'))
    assert.equal(pending.navigations.length, 1)
  }
  for (const patch of [
    { range: { from: 2, to: 21, total: 43 } },
    { entries: observation().entries!.slice(0, 19) },
  ] satisfies Array<Partial<RankDistributionDomObservation>>) {
    const invalid = harness(() => ({ ...observation(), ...patch }))
    await assert.rejects(invalid.reader.fetchPage(1, pageUrl(1)), errorCode('unsupported-dom'))
    assert.equal(invalid.navigations.length, 1)
    assert.equal(invalid.reader.getDiagnostics().successfulReadCount, 0)
  }
})

test('HTTP denial prevents DOM reading; maintenance, missing login and unknown authentication are distinct', async () => {
  const denied = harness(undefined, 403)
  await assert.rejects(denied.reader.fetchPage(1, pageUrl(1)), errorCode('http-denied'))
  assert.equal(denied.evaluations(), 0)
  assert.equal(denied.reader.getDiagnostics().lastHttpStatus, 403)
  for (const [patch, code] of [
    [{ maintenance: true }, 'maintenance'],
    [{ loginRequired: true, signedIn: false }, 'login-required'],
    [{ signedIn: null }, 'authentication-unconfirmed'],
  ] as const) {
    const { reader } = harness(() => ({ ...observation(), ...patch }))
    await assert.rejects(reader.fetchPage(1, pageUrl(1)), errorCode(code))
  }
})

test('HTTP 5xx and other HTTP errors stop before reading DOM and retain their numeric status', async () => {
  for (const status of [500, 502, 503, 599, 404]) {
    const failed = harness(undefined, status)
    await assert.rejects(failed.reader.fetchPage(1, pageUrl(1)), errorCode(status >= 500 ? 'server-error' : 'http-error'))
    assert.equal(failed.evaluations(), 0)
    assert.equal(failed.reader.getDiagnostics().lastHttpStatus, status)
    assert.equal(failed.reader.getDiagnostics().lastAttemptedPage, 1)
    assert.equal(failed.reader.getDiagnostics().successfulReadCount, 0)
    assert.equal(failed.reader.getDiagnostics().lastAuthenticationEvidence, null)
    assert.equal(failed.reader.getDiagnostics().lastLoginRequiredHeading, null)
    assert.equal(failed.reader.getDiagnostics().lastRankingReadable, null)
  }
})

test('a navigation timeout after HTTP 200 clears the prior response while retaining the last successful page', async t => {
  const setup = harness()
  await setup.reader.fetchPage(1, pageUrl(1))
  assert.equal(setup.reader.getDiagnostics().lastHttpStatus, 200)
  const evaluations = setup.evaluations()
  const failure = new Error('synthetic navigation timeout')
  failure.name = 'TimeoutError'
  t.mock.method(setup.fakePage, 'goto', async () => { throw failure })
  await assert.rejects(setup.reader.fetchPage(2, pageUrl(2)), errorCode('timeout'))
  const diagnostics = setup.reader.getDiagnostics()
  assert.equal(diagnostics.lastHttpStatus, null)
  assert.equal(diagnostics.lastAttemptedPage, 2)
  assert.equal(diagnostics.lastPage, 1)
  assert.equal(diagnostics.requestCount, 2)
  assert.equal(diagnostics.successfulReadCount, 1)
  assert.equal(diagnostics.lastAuthenticationEvidence, null)
  assert.equal(diagnostics.lastLoginRequiredHeading, null)
  assert.equal(diagnostics.lastRankingReadable, null)
  assert.equal(setup.evaluations(), evaluations)
})

test('failed authentication diagnostics distinguish readable login-button pages, explicit gates and missing controls or rows', async () => {
  const cases: Array<{ patch: Partial<RankDistributionDomObservation>; code: RankDistributionDomErrorCode; readable: boolean }> = [
    { patch: { signedIn: false, authenticationEvidence: 'login-control', loginRequiredHeading: false }, code: 'authentication-unconfirmed', readable: true },
    { patch: { signedIn: false, authenticationEvidence: 'login-control', loginRequiredHeading: true,
      loginRequired: true, rankIcons: 'pending', entries: null }, code: 'login-required', readable: false },
    { patch: { signedIn: null, authenticationEvidence: 'no-control', loginRequiredHeading: false }, code: 'authentication-unconfirmed', readable: true },
    { patch: { signedIn: null, authenticationEvidence: 'no-control', loginRequiredHeading: false,
      rankIcons: 'pending', entries: null }, code: 'authentication-unconfirmed', readable: false },
    { patch: { signedIn: null, authenticationEvidence: 'conflicting-controls', loginRequiredHeading: false }, code: 'authentication-unconfirmed', readable: true },
  ]
  for (const item of cases) {
    const failed = harness(() => ({ ...observation(), ...item.patch }))
    await assert.rejects(failed.reader.fetchPage(1, pageUrl(1)), errorCode(item.code))
    const diagnostics = failed.reader.getDiagnostics()
    assert.equal(diagnostics.lastAuthenticationEvidence, item.patch.authenticationEvidence)
    assert.equal(diagnostics.lastLoginRequiredHeading, item.patch.loginRequiredHeading)
    assert.equal(diagnostics.lastRankingReadable, item.readable)
    assert.equal(diagnostics.successfulReadCount, 0)
    assert.equal(diagnostics.lastPage, null)
    assert.doesNotMatch(JSON.stringify(diagnostics), /accountKey|leaguePoint|private-player|\/profile\//)
    assert.ok(failed.evaluations() > 1)
  }
})

test('browser errors are sanitized and cancellation does not navigate', async t => {
  const { reader, fakePage } = harness()
  const failure = new Error('private-token https://example.com/?private-player=1'); failure.name = 'TimeoutError'
  t.mock.method(fakePage, 'goto', async () => { throw failure })
  await assert.rejects(reader.fetchPage(1, pageUrl(1)), errorCode('timeout'))
  const controller = new AbortController(); controller.abort()
  const cancelled = createRankDistributionPageReader(fakePage, { signal: controller.signal })
  await assert.rejects(cancelled.fetchPage(1, pageUrl(1)), errorCode('cancelled'))
})

test('passive DOM observation reads loaded ranks without scrolling or waiting for lazy images', async t => {
  const { nodes, icon } = fixture()
  setDom(t, nodes)
  window.scrollTo = () => { assert.fail('passive observation must not scroll') }
  icon.scrollIntoView = () => { assert.fail('passive observation must not load lazy images') }
  t.mock.method(globalThis, 'setTimeout', (() => { assert.fail('passive observation must not settle the page') }) as typeof setTimeout)
  const value = await observeRankDistributionDom({ salt: 'passive-capture', readOnly: true })
  assert.equal(value.authenticationEvidence, 'logout-control')
  assert.equal(value.rankIcons, 'ready')
  assert.equal(value.entries?.length, 1)
})

test('each existing fetch poll emits normalized safe evidence and observer errors cannot affect hydration', async () => {
  const snapshots: DistributionPageObservationSnapshot[] = []
  const setup = harness((page, count) => count === 1
    ? { ...observation(page), signedIn: null, authenticationEvidence: undefined, loginRequiredHeading: undefined, entries: null }
    : count === 2 ? { ...observation(page), signedIn: false, authenticationEvidence: 'login-control' } : observation(page), 200, {
    onObservation: snapshot => { snapshots.push(snapshot); throw new Error('private-callback-error') },
  })
  await setup.reader.fetchPage(1, pageUrl(1))
  assert.deepEqual(snapshots, [
    { authenticationEvidence: null, loginRequiredHeading: null, rankingReadable: false },
    { authenticationEvidence: 'login-control', loginRequiredHeading: false, rankingReadable: true },
    { authenticationEvidence: 'logout-control', loginRequiredHeading: false, rankingReadable: true },
  ])
  assert.equal(setup.evaluations(), snapshots.length)
  assert.equal(setup.navigations.length, 1)
  assert.equal(setup.reader.getDiagnostics().successfulReadCount, 1)
  assert.equal(setup.elapsed(), 500)
})

test('post-stop samples bypass the original aborted signal without navigation or changing the failed attempt', async t => {
  const controller = new AbortController()
  const snapshots: DistributionPageObservationSnapshot[] = []
  let recovered = false
  const setup = harness(page => ({ ...observation(page), ...(page === 1 || recovered ? {}
    : { signedIn: false, authenticationEvidence: 'login-control' as const }) }), 200,
  { signal: controller.signal, onObservation: snapshot => { snapshots.push(snapshot) } })
  await setup.reader.fetchPage(1, pageUrl(1))
  await assert.rejects(setup.reader.fetchPage(3, pageUrl(3)), errorCode('authentication-unconfirmed'))
  const diagnostics = setup.reader.getDiagnostics(), elapsed = setup.elapsed(), emitted = snapshots.length
  const evaluations = setup.evaluations()
  controller.abort()
  recovered = true
  const evaluate = setup.fakePage.evaluate.bind(setup.fakePage)
  t.mock.method(setup.fakePage, 'evaluate', (async (fn: unknown, input: unknown) => {
    assert.equal(fn, observeRankDistributionDom)
    assert.equal((input as { readOnly?: boolean }).readOnly, true)
    return evaluate(fn as never, input as never)
  }) as typeof setup.fakePage.evaluate)
  assert.deepEqual(await setup.reader.observeCurrentPage(3), {
    authenticationEvidence: 'logout-control', loginRequiredHeading: false, rankingReadable: true,
  })
  assert.deepEqual(setup.reader.getDiagnostics(), diagnostics)
  assert.equal(setup.elapsed(), elapsed)
  assert.equal(snapshots.length, emitted)
  assert.equal(setup.evaluations(), evaluations + 1)
  assert.deepEqual(setup.navigations, [pageUrl(1), pageUrl(3)])
  await assert.rejects(setup.reader.fetchPage(3, pageUrl(3)), errorCode('cancelled'))
})

test('post-stop readability reuses fixed URL, known page size, controls, counters, icons and duplicate checks', async t => {
  let patch: Partial<RankDistributionDomObservation> = {}
  const setup = harness(page => ({ ...observation(page), ...patch }))
  await setup.reader.fetchPage(1, pageUrl(1))
  await setup.reader.fetchPage(3, pageUrl(3))
  const diagnostics = setup.reader.getDiagnostics()
  for (const invalid of [
    { conditionsMatch: false }, { leagueLabelsMatch: false }, { selectedPage: 2 }, { rankIcons: 'unsupported' },
    { range: { from: 7, to: 9, total: 43 } }, { entries: observation(3).entries!.slice(0, 2) },
    { entries: observation(3).entries!.map(entry => ({ ...entry, accountKey: 'a'.repeat(64) })) },
  ] satisfies Partial<RankDistributionDomObservation>[]) {
    patch = invalid
    assert.equal((await setup.reader.observeCurrentPage(3)).rankingReadable, false)
  }
  patch = { authenticationEvidence: 'private-raw-value', loginRequiredHeading: 'private-raw-heading' } as unknown as Partial<RankDistributionDomObservation>
  assert.deepEqual(await setup.reader.observeCurrentPage(3), { authenticationEvidence: null, loginRequiredHeading: null, rankingReadable: true })
  t.mock.method(setup.fakePage, 'url', () => pageUrl(3).replace('user_status=1', 'user_status=0'))
  assert.equal((await setup.reader.observeCurrentPage(3)).rankingReadable, false)
  assert.deepEqual(setup.reader.getDiagnostics(), diagnostics)
  assert.equal(setup.navigations.length, 2)
})

test('passive observation sanitizes browser errors and rejects invalid pages before evaluation', async t => {
  const setup = harness()
  t.mock.method(setup.fakePage, 'evaluate', async () => { throw new Error('private-token https://example.com/private-player') })
  await assert.rejects(setup.reader.observeCurrentPage(1), errorCode('read-failed'))
  await assert.rejects(setup.reader.observeCurrentPage(0), errorCode('invalid-request'))
  assert.equal(setup.navigations.length, 0)
  assert.equal(setup.reader.getDiagnostics().requestCount, 0)
})
