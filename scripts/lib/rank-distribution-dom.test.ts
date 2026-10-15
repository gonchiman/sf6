import assert from 'node:assert/strict'
import test from 'node:test'
import type { TestContext } from 'node:test'
import type { Page } from 'playwright'
import { createRankDistributionPageReader, observeRankDistributionDom, RankDistributionDomError } from './rank-distribution-dom.ts'
import type { RankDistributionDomErrorCode, RankDistributionDomObservation, RankDistributionPageReaderOptions } from './rank-distribution-dom.ts'
import { rankBoundaryPageUrl, RANK_BOUNDARY_SOURCE_URL } from './rank-distribution-boundaries.ts'

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
    maintenance: false, loginRequired: false, signedIn: true, conditionsMatch: true, leagueLabelsMatch: true,
    selectedPage: page, range: { from, to, total }, rankIcons: 'ready',
    entries: Array.from({ length: to - from + 1 }, (_, i) => ({ leaguePoint: 30000 - from - i,
      rankId: page === 1 ? 36 : 1, accountKey: (from + i).toString(16).padStart(64, '0') })),
  }
}

function harness(observe: (page: number, evaluation: number) => RankDistributionDomObservation = page => observation(page), status = 200,
  options: Pick<RankDistributionPageReaderOptions, 'totalCountPolicy'> = {}) {
  let currentUrl = ''
  let evaluations = 0
  let clock = 0
  const navigations: string[] = []
  const fakePage = {
    goto: async (url: string) => { currentUrl = url; navigations.push(url); return { status: () => status } },
    url: () => currentUrl,
    evaluate: async () => observe(Number(new URL(currentUrl).searchParams.get('page')), ++evaluations),
  } as unknown as Page
  const reader = createRankDistributionPageReader(fakePage, { timeoutMs: 1000, now: () => clock, wait: async ms => { clock += ms }, ...options })
  return { reader, fakePage, navigations, evaluations: () => evaluations }
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

test('reader waits for page hydration, selected page, counters, authentication and lazy images together', async () => {
  const { reader, evaluations } = harness((page, evaluation) => evaluation === 1
    ? { ...observation(page), signedIn: false, selectedPage: null, entries: null, rankIcons: 'pending' }
    : observation(page))
  assert.equal((await reader.fetchPage(1, pageUrl(1))).entries.length, 20)
  assert.equal(evaluations(), 2)
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
