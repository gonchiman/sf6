import assert from 'node:assert/strict'
import test from 'node:test'
import type { Page } from 'playwright'
import { classifyLegendClickFailure, createLegendAnalysisPageReader, LegendAnalysisDomError, legendAnalysisPageUrl, observeLegendAnalysisDom, observeLegendAnalysisRoster, sanitizeLegendRosterDiagnostics } from './legend-analysis-dom.ts'

function fixture() {
  let url = '', clock = 0, actId = 13, status = 200, redirected = false, readyOnAttempt = 1, controlReads = 0, cookieOverlay = false, autoOpen = false
  let signedIn = true, loginRequired = false, authenticationEvidence = 'logout-control'
  const statuses: number[] = []
  const navigations: string[] = [], salts: string[] = [], waits: number[] = [], controls: string[] = []
  const page = {
    goto: async (value: string) => { url = redirected ? 'https://example.com/unconfirmed' : value; navigations.push(value); const actual = statuses.shift() ?? status; return { status: () => actual, url: () => url } },
    url: () => url,
    evaluate: async (operation: { name: string }, input?: { salt: string }) => {
      if (!operation.name) return false
      if (operation.name === 'observeLegendAnalysisAct') return { id: `act-${actId}`, label: `Act ${actId}` }
      if (operation.name === 'observeLegendAnalysisRoster') return { roster: [{ characterId: 'arjun', name: 'アージュン' }, { characterId: 'ryu', name: 'リュウ' }],
        diagnostics: { h3Count: 1, liCount: 3, randomCount: 1, failedIndex: null, reason: null, items: [] } }
      if (operation.name === 'observeLegendAnalysisRosterControl') return { characterFilter: ++controlReads >= readyOnAttempt ? '4' : '1', visibleRosterButtonCount: controlReads >= readyOnAttempt ? 1 : 0, rosterModalVisible: autoOpen && controlReads >= readyOnAttempt }
      if (operation.name === 'observeLegendAnalysisClickTarget') return { hitKind: cookieOverlay ? 'cookie-consent' : 'ranking-control', hitTag: cookieOverlay ? 'div' : 'span', parentParagraph: true, pointerEventsNone: false }
      salts.push(input!.salt)
      const selectedPage = Number(new URL(url).searchParams.get('page'))
      return { maintenance: false, signedIn, authenticationEvidence, loginRequired, conditionsConfirmed: true, currentActConfirmed: true,
        selectedPage, range: { from: (selectedPage - 1) * 20 + 1, to: selectedPage * 20, total: 800000 },
        firstPlayUrl: 'https://www.streetfighter.com/6/buckler/ja-jp/profile/12345/play',
        entries: Array.from({ length: 20 }, (_, index) => ({ accountKey: String(index).padStart(64, '0'), characterId: 'ryu', rank: index + 1,
          masterRating: 2400 - index, isLegend: true })) }
    },
    locator: (selector: string) => ({ first() { return this }, selectOption: async (value: string) => { controls.push(`${selector}:${value}`) },
      count: async () => selector === 'button#onetrust-reject-all-handler:visible' && cookieOverlay ? 1 : 0,
      click: async () => { controls.push(selector)
        if (selector === 'button#onetrust-reject-all-handler:visible') cookieOverlay = false
        else if (selector.includes('ranking_search_character_btn') && cookieOverlay) throw new Error('private-source-text intercepts pointer events')
      } }),
  } as unknown as Page
  const reader = createLegendAnalysisPageReader(page, { now: () => clock, wait: async milliseconds => { waits.push(milliseconds); clock += milliseconds } })
  return { reader, navigations, salts, waits, controls, changeAct: () => { actId++ }, deny: () => { status = 403 }, redirect: () => { redirected = true }, hydrateAfter: (attempts: number) => { readyOnAttempt = attempts }, showCookieOverlay: () => { cookieOverlay = true }, autoOpenRoster: () => { autoOpen = true },
    showLoginControl: () => { signedIn = false; authenticationEvidence = 'login-control' },
    showLoginHeading: () => { signedIn = false; authenticationEvidence = 'login-control'; loginRequired = true },
    showNoControls: () => { signedIn = false; authenticationEvidence = 'no-control' }, respond: (...values: number[]) => { statuses.push(...values) } }
}

test('reader confirms Act and visible source roster, uses one salt, and spaces navigations by five seconds', async () => {
  const data = fixture(), initial = await data.reader.initialize()
  assert.deepEqual(initial.characterIds, ['arjun', 'ryu'])
  assert.equal(initial.characterNames.arjun, 'アージュン')
  const first = await data.reader.fetchPage(1, legendAnalysisPageUrl(1))
  await data.reader.confirmAct()
  await data.reader.fetchPage(1, legendAnalysisPageUrl(1))
  assert.equal(first.actId, 'act-13')
  assert.equal(first.rosterConfirmed, true)
  assert.equal(new Set(data.salts).size, 1)
  assert.equal(data.waits.filter(value => value >= 5000).length > 0, true)
  assert.deepEqual(data.controls, ['select:visible:1', 'select:visible:4', 'span[class*="ranking_search_character_btn"]:visible'])
  assert.deepEqual(Object.keys(data.reader.getDiagnostics()), ['requestCount', 'lastStep', 'lastErrorCode', 'characterFilter', 'visibleRosterButtonCount', 'clickFailure', 'clickHitKind', 'clickHitTag', 'parentParagraph', 'pointerEventsNone', 'rosterDiagnostics', 'lastLoginRequired', 'lastSignedIn', 'lastRankingReadable', 'readableWithoutSignInReadCount', 'lastHttpStatus'])
})

test('reader rejects Act change, denied HTTP, redirects and noncanonical requests without leaking URLs', async () => {
  const changed = fixture(); await changed.reader.initialize(); changed.changeAct()
  await assert.rejects(changed.reader.confirmAct(), error => error instanceof LegendAnalysisDomError && error.code === 'act-changed')
  const denied = fixture(); denied.deny()
  await assert.rejects(denied.reader.initialize(), /http-denied/)
  const redirect = fixture(); redirect.redirect()
  await assert.rejects(redirect.reader.initialize(), /condition-mismatch/)
  const invalid = fixture(); await invalid.reader.initialize()
  await assert.rejects(invalid.reader.fetchPage(1, 'https://example.com/private'), /invalid-request/)
  assert.throws(() => legendAnalysisPageUrl(0), /invalid-request/)
})

test('ordinary control reselection retries hydration finitely and rejects an unready source', async () => {
  const delayed = fixture(); delayed.hydrateAfter(3)
  await delayed.reader.initialize()
  assert.equal(delayed.controls.filter(value => value === 'select:visible:4').length, 3)
  assert.equal(delayed.reader.getDiagnostics().visibleRosterButtonCount, 1)
  const missing = fixture(); missing.hydrateAfter(4)
  await assert.rejects(missing.reader.initialize(), /unsupported-dom/)
  assert.equal(missing.controls.filter(value => value === 'select:visible:4').length, 3)
  assert.equal(missing.reader.getDiagnostics().characterFilter, '1')
  await assert.rejects(missing.reader.fetchPage(1, legendAnalysisPageUrl(1)), /invalid-request/)
})

test('confirmed consent interception uses only the ordinary reject control and retains fixed diagnostics', async () => {
  const data = fixture(); data.showCookieOverlay()
  await data.reader.initialize()
  assert.equal(data.controls.includes('button#onetrust-reject-all-handler:visible'), true)
  assert.equal(data.reader.getDiagnostics().clickFailure, 'intercepts-pointer-events')
  assert.equal(JSON.stringify(data.reader.getDiagnostics()).includes('private-source-text'), false)
  for (const [message, code] of [['element is not visible', 'not-visible'], ['element is not stable', 'not-stable'],
    ['element outside of the viewport', 'outside-viewport'], ['strict mode violation', 'strict-mode'], ['untrusted arbitrary source text', 'other']]) {
    assert.equal(classifyLegendClickFailure(new Error(message)), code)
  }
})

test('character mode that automatically opens its modal is read without clicking the covered background control', async () => {
  const data = fixture(); data.autoOpenRoster()
  const initial = await data.reader.initialize()
  assert.equal(initial.characterIds.length, 2)
  assert.deepEqual(data.controls, ['select:visible:1', 'select:visible:4'])
  assert.equal(data.reader.getDiagnostics().clickFailure, null)
})

test('only a previously confirmed reader accepts complete login-control pages after hydration, never a login heading or missing controls', async () => {
  const initial = fixture(); initial.showLoginControl()
  await assert.rejects(initial.reader.initialize(), /authentication-required/)
  const later = fixture(); await later.reader.initialize(); later.showLoginControl()
  const page = await later.reader.fetchPage(1, legendAnalysisPageUrl(1))
  assert.equal(page.entries.length, 20)
  assert.equal(later.reader.getDiagnostics().readableWithoutSignInReadCount, 1)
  assert.equal(later.reader.getDiagnostics().lastSignedIn, false)
  assert.equal(later.reader.getDiagnostics().lastLoginRequired, false)
  assert.equal(later.reader.getDiagnostics().lastRankingReadable, true)
  const heading = fixture(); await heading.reader.initialize(); heading.showLoginHeading()
  await assert.rejects(heading.reader.fetchPage(1, legendAnalysisPageUrl(1)), /authentication-required/)
  const missing = fixture(); await missing.reader.initialize(); missing.showNoControls()
  await assert.rejects(missing.reader.fetchPage(1, legendAnalysisPageUrl(1)), /authentication-required/)
})

test('each server fault gets one delayed retry, while denied and other client faults stop immediately', async () => {
  const recovered = fixture(); await recovered.reader.initialize(); recovered.respond(503, 200)
  const before = recovered.reader.getDiagnostics().requestCount
  await recovered.reader.fetchPage(1, legendAnalysisPageUrl(1))
  assert.equal(recovered.reader.getDiagnostics().requestCount - before, 2)
  assert.equal(recovered.reader.getDiagnostics().lastHttpStatus, 200)
  const failed = fixture(); await failed.reader.initialize(); failed.respond(503, 502)
  const start = failed.reader.getDiagnostics().requestCount
  await assert.rejects(failed.reader.fetchPage(1, legendAnalysisPageUrl(1)), /server-error/)
  assert.equal(failed.reader.getDiagnostics().requestCount - start, 2)
  assert.equal(failed.reader.getDiagnostics().lastHttpStatus, 502)
  for (const status of [401, 403, 404, 405, 429]) {
    const data = fixture(); await data.reader.initialize(); data.respond(status, 200)
    const initial = data.reader.getDiagnostics().requestCount
    await assert.rejects(data.reader.fetchPage(1, legendAnalysisPageUrl(1)))
    assert.equal(data.reader.getDiagnostics().requestCount - initial, 1)
    assert.equal(data.reader.getDiagnostics().lastHttpStatus, status)
  }
})

test('rendered rows accept official noscript assets behind placeholders and hash identities without emitting them', async t => {
  function element(value = '', children: Record<string, unknown[]> = {}, attributes: Record<string, string> = {}) {
    return { innerText: value, textContent: value, innerHTML: value, parentElement: null,
      complete: false, naturalWidth: 0, currentSrc: 'data:image/gif;base64,placeholder',
      getBoundingClientRect: () => ({ width: 100, height: 20 }), hasAttribute: () => false,
      getAttribute: (name: string) => attributes[name] ?? null, closest: () => null,
      querySelectorAll: (selector: string) => children[selector] ?? [], scrollIntoView: () => {} }
  }
  const select = (value: string, label: string) => Object.assign(element(), { value, options: [element(label)], selectedOptions: [element(label)] })
  const fallback = (src: string) => element('', { img: [element()], noscript: [element(`<img src="${src}">`)] })
  const row = element('private player display name', {
    'div[class*="ranking_page_data"]': [element()], '[class*="ranking_time"]': [element('', { 'dl dt': [element('1位')], 'dl dd': [element('2430MR')] })],
    'div[class*="ranking_character"]': [fallback('/6/buckler/assets/images/material/character/character_ryu_l.png')],
    'div[class*="ranking_league_rank_icon"] p[class*="ranking_master_rating_icon"]': [fallback('/6/buckler/assets/images/material/rank/rank37_l.png')],
  }, { href: '/6/buckler/ja-jp/profile/987654321' })
  const nodes: Record<string, unknown[]> = {
    'a,button': [element('ログアウト')], 'h1,h2': [], select: [select('1', '総合'), select('0', 'すべて'), select('1', 'すべて'), ...Array.from({ length: 4 }, () => select('1', '1'))],
    'aside[class*="ranking_act_nav"] li[class*="active"]': [element('今Act')],
    'p[class*="ranking_ranking_now"]': [element('1 - 1/ 800000'), element('1 - 1/ 800000')],
    'ul[class*="ranking_ranking_list"]:not([class*="ranking__my__list"])': [element('', { 'a[href*="/profile/"]': [row] })],
  }
  const globals: Record<string, unknown> = {
    document: { querySelectorAll: (selector: string) => nodes[selector] ?? [] },
    window: { scrollTo: () => {}, getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }) },
    location: { origin: 'https://www.streetfighter.com' },
    DOMParser: class { parseFromString(value: string) { const match = /src="([^"]+)"/.exec(value); return { querySelectorAll: () => match ? [element('', {}, { src: match[1] })] : [] } } },
  }
  const previous = Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const)
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value })
  t.mock.method(globalThis, 'setTimeout', ((callback: () => void) => { callback(); return 0 }) as unknown as typeof setTimeout)
  t.after(() => { for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key) } })
  const first = await observeLegendAnalysisDom({ salt: 'first-capture', characterIds: ['ryu'] })
  const second = await observeLegendAnalysisDom({ salt: 'second-capture', characterIds: ['ryu'] })
  assert.equal(first.conditionsConfirmed, true)
  assert.equal(first.currentActConfirmed, true)
  assert.equal(first.selectedPage, 1)
  assert.equal(first.entries?.[0].isLegend, true)
  assert.equal(first.entries?.[0].characterId, 'ryu')
  assert.match(first.entries![0].accountKey, /^[a-f0-9]{64}$/)
  assert.notEqual(first.entries![0].accountKey, second.entries![0].accountKey)
  // Only the transient PLAY navigation URL may contain the source identity.
  const { firstPlayUrl: _privateNavigation, ...publicObservation } = first
  assert.equal(JSON.stringify(publicObservation).includes('987654321'), false)
  assert.equal(JSON.stringify(first).includes('private player display name'), false)
})

test('source roster scroll loads every catalog portrait and diagnoses only catalog IDs and bounded counts', async t => {
  const row = (characterId: string, name: string, label: string) => {
    const image = { complete: false, naturalWidth: 0, currentSrc: 'data:image/gif;base64,placeholder',
      getAttribute: (attribute: string) => attribute === 'alt' ? name : attribute === 'src' ? image.currentSrc : null }
    let scrolls = 0
    return { image, count: () => scrolls, querySelector: () => ({ textContent: label }),
      querySelectorAll: (selector: string) => selector === 'dd img' ? [image] : [],
      scrollIntoView: () => { scrolls++; image.complete = true; image.naturalWidth = 100; image.currentSrc = `https://www.streetfighter.com/6/buckler/assets/images/material/character/character_${characterId}_l.png` } }
  }
  const rows = [row('ryu', 'リュウ', 'RYU'), row('arjun', 'アージュン', 'ARJUN'), row('random', 'ランダム', 'RANDOM')]
  const modal = { querySelectorAll: () => rows }
  const heading = { textContent: 'キャラクターセレクト', parentElement: null, hasAttribute: () => false,
    getBoundingClientRect: () => ({ width: 100, height: 20 }), closest: () => modal }
  const globals: Record<string, unknown> = { document: { querySelectorAll: () => [heading] },
    window: { getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }) }, location: { origin: 'https://www.streetfighter.com' } }
  const previous = Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const)
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value })
  t.mock.method(globalThis, 'setTimeout', ((callback: () => void) => { callback(); return 0 }) as unknown as typeof setTimeout)
  t.after(() => { for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key) } })
  const observed = await observeLegendAnalysisRoster()
  assert.deepEqual(observed.roster, [{ characterId: 'arjun', name: 'アージュン' }, { characterId: 'ryu', name: 'リュウ' }])
  assert.equal(observed.diagnostics.liCount, 3)
  assert.equal(observed.diagnostics.randomCount, 1)
  assert.equal(observed.diagnostics.reason, null)
  assert.deepEqual(rows.map(value => value.count()), [2, 1, 1])
  assert.deepEqual(sanitizeLegendRosterDiagnostics(observed.diagnostics), observed.diagnostics)
  assert.equal(sanitizeLegendRosterDiagnostics({ ...observed.diagnostics, items: [{ ...observed.diagnostics.items[0], label: '<private HTML>' }] }), null)
  assert.equal(JSON.stringify(observed.diagnostics).includes('https://'), false)
})
