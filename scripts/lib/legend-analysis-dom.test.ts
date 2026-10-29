import assert from 'node:assert/strict'
import test from 'node:test'
import type { Page } from 'playwright'
import { classifyLegendClickFailure, createLegendAnalysisPageReader, LegendAnalysisDomError, legendAnalysisPageUrl, legendAnalysisPageUrlMatches, observeLegendAnalysisDom, observeLegendAnalysisRoster, sanitizeLegendRosterDiagnostics } from './legend-analysis-dom.ts'

function fixture() {
  let url = '', clock = 0, actId = 13, status = 200, redirected = false, readyOnAttempt = 1, controlReads = 0, cookieOverlay = false, autoOpen = false
  let signedIn = true, loginRequired = false, authenticationEvidence = 'logout-control'
  let bodyPage: number | null = null, staleReads = 0, duplicateReads = 0, identicalRanks = false, rankingReads = 0, challenge = false
  let sharedChallenge = false, unavailableChallengeDom = false
  const headers: Record<string, string> = {}
  const statuses: number[] = []
  const navigations: string[] = [], salts: string[] = [], waits: number[] = [], controls: string[] = []
  const page = {
    goto: async (value: string) => { url = redirected ? 'https://example.com/unconfirmed' : value; navigations.push(value); const actual = statuses.shift() ?? status; return { status: () => actual, url: () => url, headers: () => ({ ...headers }) } },
    url: () => url,
    evaluate: async (operation: { name: string }, input?: { salt: string }) => {
      if (!operation.name || operation.name === 'observeDistributionHumanVerification') {
        if (unavailableChallengeDom) throw new Error('private-dom-failure-text')
        return operation.name ? sharedChallenge : challenge
      }
      if (operation.name === 'observeLegendAnalysisAct') return { id: `act-${actId}`, label: `Act ${actId}` }
      if (operation.name === 'observeLegendAnalysisRoster') return { roster: [{ characterId: 'arjun', name: 'アージュン' }, { characterId: 'ryu', name: 'リュウ' }],
        diagnostics: { h3Count: 1, liCount: 3, randomCount: 1, failedIndex: null, reason: null, items: [] } }
      if (operation.name === 'observeLegendAnalysisRosterControl') return { characterFilter: ++controlReads >= readyOnAttempt ? '4' : '1', visibleRosterButtonCount: controlReads >= readyOnAttempt ? 1 : 0, rosterModalVisible: autoOpen && controlReads >= readyOnAttempt }
      if (operation.name === 'observeLegendAnalysisClickTarget') return { hitKind: cookieOverlay ? 'cookie-consent' : 'ranking-control', hitTag: cookieOverlay ? 'div' : 'span', parentParagraph: true, pointerEventsNone: false }
      salts.push(input!.salt)
      const selectedPage = Number(new URL(url).searchParams.get('page'))
      const contentPage = bodyPage !== null && staleReads-- > 0 ? bodyPage : selectedPage
      const duplicate = duplicateReads-- > 0
      rankingReads++
      return { observedUrl: url, maintenance: false, accessChallenge: challenge, signedIn, authenticationEvidence, loginRequired, conditionsConfirmed: true, currentActConfirmed: true,
        selectedPage, range: { from: (selectedPage - 1) * 20 + 1, to: selectedPage * 20, total: 800000 },
        firstPlayUrl: 'https://www.streetfighter.com/6/buckler/ja-jp/profile/12345/play',
        entries: Array.from({ length: 20 }, (_, index) => ({ accountKey: String((contentPage - 1) * 20 + (duplicate && index === 1 ? 0 : index)).padStart(64, '0'), characterId: 'ryu', rank: identicalRanks ? 1 : (contentPage - 1) * 20 + index + 1,
          masterRating: identicalRanks ? 2400 : 2400 - ((contentPage - 1) * 20 + index), isLegend: true })) }
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
    staleBody: (page: number, reads: number) => { bodyPage = page; staleReads = reads }, duplicateBody: (reads: number) => { duplicateReads = reads }, tieAllRows: () => { identicalRanks = true }, readCount: () => rankingReads, showChallenge: () => { challenge = true },
    showLoginControl: () => { signedIn = false; authenticationEvidence = 'login-control' },
    showLoginHeading: () => { signedIn = false; authenticationEvidence = 'login-control'; loginRequired = true },
    showNoControls: () => { signedIn = false; authenticationEvidence = 'no-control' }, respond: (...values: number[]) => { statuses.push(...values) },
    setHeaders: (values: Record<string, string>) => { for (const key of Object.keys(headers)) delete headers[key]; Object.assign(headers, values) },
    showSharedChallenge: () => { sharedChallenge = true }, unavailableChallengeDom: () => { unavailableChallengeDom = true } }
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
  assert.deepEqual(Object.keys(data.reader.getDiagnostics()), ['requestCount', 'lastStep', 'lastErrorCode', 'characterFilter', 'visibleRosterButtonCount', 'clickFailure', 'clickHitKind', 'clickHitTag', 'parentParagraph', 'pointerEventsNone', 'rosterDiagnostics', 'lastLoginRequired', 'lastSignedIn', 'lastRankingReadable', 'readableWithoutSignInReadCount', 'lastHttpStatus', 'lastAttemptedPage', 'successfulReadCount', 'humanVerification'])
  assert.equal(data.reader.getDiagnostics().lastAttemptedPage, 1)
  assert.equal(data.reader.getDiagnostics().successfulReadCount, 4)
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
    assert.equal(data.reader.getDiagnostics().lastAttemptedPage, 1)
    assert.equal(data.reader.getDiagnostics().successfulReadCount, 2)
    assert.equal(data.reader.getDiagnostics().lastRankingReadable, null)
    assert.equal(data.reader.getDiagnostics().lastSignedIn, null)
    assert.equal(data.reader.getDiagnostics().lastLoginRequired, null)
  }
})

test('diagnostics track the requested ranking page and accepted reads separately from Act navigations', async () => {
  const data = fixture()
  await data.reader.initialize()
  assert.equal(data.reader.getDiagnostics().successfulReadCount, 2)
  await data.reader.confirmAct()
  assert.equal(data.reader.getDiagnostics().lastAttemptedPage, null)
  assert.equal(data.reader.getDiagnostics().successfulReadCount, 2)
  data.respond(405)
  await assert.rejects(data.reader.fetchPage(14, legendAnalysisPageUrl(14)), /http-error/)
  assert.equal(data.reader.getDiagnostics().lastAttemptedPage, 14)
  assert.equal(data.reader.getDiagnostics().successfulReadCount, 2)
})

test('HTTP 405 records fixed WAF and DOM evidence before stopping, without retaining response secrets', async () => {
  for (const action of ['captcha', 'challenge']) {
    const data = fixture(); await data.reader.initialize()
    data.setHeaders({ 'x-amzn-waf-action': action, 'set-cookie': 'private-cookie-value', 'untrusted-header': 'private-header-value' })
    data.respond(405, 200)
    const requests = data.reader.getDiagnostics().requestCount
    await assert.rejects(data.reader.fetchPage(22, legendAnalysisPageUrl(22)), /http-denied/)
    assert.equal(data.reader.getDiagnostics().requestCount - requests, 1)
    assert.equal(data.reader.getDiagnostics().lastHttpStatus, 405)
    assert.deepEqual(data.reader.getDiagnostics().humanVerification, { wafHeaderChecked: true, wafAction: action, domDetected: false })
    assert.equal(/private-cookie-value|private-header-value|set-cookie|untrusted-header/.test(JSON.stringify(data.reader.getDiagnostics())), false)
  }
})

test('client errors distinguish visible human verification, no detected evidence, and unavailable DOM', async () => {
  for (const status of [401, 403, 404, 405, 429]) {
    for (const mode of ['visible', 'absent', 'unavailable'] as const) {
      const data = fixture(); await data.reader.initialize(); data.respond(status, 200)
      if (mode === 'visible') data.showSharedChallenge()
      if (mode === 'unavailable') data.unavailableChallengeDom()
      const requests = data.reader.getDiagnostics().requestCount
      await assert.rejects(data.reader.fetchPage(22, legendAnalysisPageUrl(22)), error => error instanceof LegendAnalysisDomError
        && error.code === (mode === 'visible' || [401, 403, 429].includes(status) ? 'http-denied' : 'http-error'))
      assert.equal(data.reader.getDiagnostics().requestCount - requests, 1)
      assert.deepEqual(data.reader.getDiagnostics().humanVerification, {
        wafHeaderChecked: true, wafAction: null, domDetected: mode === 'visible' ? true : mode === 'absent' ? false : null,
      })
      assert.equal(JSON.stringify(data.reader.getDiagnostics()).includes('private-dom-failure-text'), false)
    }
  }
})

test('header-confirmed human verification stops once even on success/server statuses and evidence resets per navigation', async () => {
  for (const status of [200, 503]) {
    const data = fixture(); await data.reader.initialize(); data.setHeaders({ 'x-amzn-waf-action': 'captcha' }); data.respond(status, 200)
    data.unavailableChallengeDom()
    const requests = data.reader.getDiagnostics().requestCount
    await assert.rejects(data.reader.fetchPage(1, legendAnalysisPageUrl(1)), /http-denied/)
    assert.equal(data.reader.getDiagnostics().requestCount - requests, 1)
    assert.deepEqual(data.reader.getDiagnostics().humanVerification, { wafHeaderChecked: true, wafAction: 'captcha', domDetected: null })
  }
  const data = fixture(); await data.reader.initialize()
  assert.deepEqual(data.reader.getDiagnostics().humanVerification, { wafHeaderChecked: true, wafAction: null, domDetected: false })
  const external = data.reader.getDiagnostics().humanVerification; external.domDetected = true
  assert.equal(data.reader.getDiagnostics().humanVerification.domDetected, false)
  await data.reader.confirmAct()
  assert.deepEqual(data.reader.getDiagnostics().humanVerification, { wafHeaderChecked: true, wafAction: null, domDetected: null })
  data.redirect()
  await assert.rejects(data.reader.fetchPage(2, legendAnalysisPageUrl(2)), /condition-mismatch/)
  assert.deepEqual(data.reader.getDiagnostics().humanVerification, { wafHeaderChecked: false, wafAction: null, domDetected: null })
})

test('canonical ranking URLs accept query order alone and reject changed origin, Act, conditions or multiplicities', () => {
  const canonical = legendAnalysisPageUrl(2), url = new URL(canonical)
  url.search = [...url.searchParams.entries()].reverse().map(([key, value]) => `${key}=${value}`).join('&')
  assert.equal(legendAnalysisPageUrlMatches(url.href, 2), true)
  for (const mutate of [
    (url: URL) => { url.hostname = 'example.com' }, (url: URL) => { url.pathname += '/other' },
    (url: URL) => { url.searchParams.set('season_type', '2') }, (url: URL) => { url.searchParams.set('character_filter', '4') },
    (url: URL) => { url.searchParams.append('page', '2') }, (url: URL) => { url.searchParams.set('unknown', '1') },
    (url: URL) => { url.searchParams.delete('character_id') }, (url: URL) => { url.hash = 'unconfirmed' },
  ]) { const changed = new URL(canonical); mutate(changed); assert.equal(legendAnalysisPageUrlMatches(changed.href, 2), false) }
})

test('every ranking fetch uses fixed goto, including consecutive pages, rechecks and Act return', async () => {
  const data = fixture(); await data.reader.initialize()
  await data.reader.fetchPage(1, legendAnalysisPageUrl(1))
  const gotoCount = data.navigations.length
  const page2 = await data.reader.fetchPage(2, legendAnalysisPageUrl(2))
  assert.equal(data.navigations.length, gotoCount + 1)
  assert.equal(data.navigations.at(-1), legendAnalysisPageUrl(2))
  assert.equal(page2.sourceUrl, legendAnalysisPageUrl(2))
  await data.reader.fetchPage(1, legendAnalysisPageUrl(1))
  assert.equal(data.navigations.length, gotoCount + 2)
  await data.reader.confirmAct()
  await data.reader.fetchPage(2, legendAnalysisPageUrl(2))
  assert.equal(data.navigations.length, gotoCount + 4)
  assert.equal(data.navigations.at(-1), legendAnalysisPageUrl(2))
  assert.deepEqual(data.controls, ['select:visible:1', 'select:visible:4', 'span[class*="ranking_search_character_btn"]:visible'])
})

test('consecutive goto waits for a new complete body and permits a tie spanning pages with new identities', async () => {
  const data = fixture(); data.tieAllRows(); await data.reader.initialize(); await data.reader.fetchPage(1, legendAnalysisPageUrl(1))
  data.staleBody(1, 2)
  const reads = data.readCount(), second = await data.reader.fetchPage(2, legendAnalysisPageUrl(2))
  assert.equal(data.readCount() - reads, 3)
  assert.equal(second.entries.every(entry => entry.rank === 1 && entry.masterRating === 2400), true)
  assert.equal(second.entries[0].accountKey, String(20).padStart(64, '0'))
  const stale = fixture(); await stale.reader.initialize(); await stale.reader.fetchPage(1, legendAnalysisPageUrl(1)); stale.staleBody(1, 100)
  await assert.rejects(stale.reader.fetchPage(2, legendAnalysisPageUrl(2)), /unsupported-dom/)
})

test('a duplicate within one observed page waits for hydration and fails closed if it persists', async () => {
  const data = fixture(); await data.reader.initialize(); data.duplicateBody(2)
  const reads = data.readCount(); await data.reader.fetchPage(1, legendAnalysisPageUrl(1))
  assert.equal(data.readCount() - reads, 3)
  data.duplicateBody(100)
  await assert.rejects(data.reader.fetchPage(1, legendAnalysisPageUrl(1)), /unsupported-dom/)
})

test('consecutive goto keeps one server retry and stops client faults or redirects', async () => {
  const recovered = fixture(); await recovered.reader.initialize(); await recovered.reader.fetchPage(1, legendAnalysisPageUrl(1)); recovered.respond(503, 200)
  const before = recovered.reader.getDiagnostics().requestCount
  await recovered.reader.fetchPage(2, legendAnalysisPageUrl(2))
  assert.equal(recovered.reader.getDiagnostics().requestCount - before, 2)
  assert.deepEqual(recovered.navigations.slice(-2), [legendAnalysisPageUrl(2), legendAnalysisPageUrl(2)])
  for (const status of [401, 403, 404, 405, 429]) {
    const data = fixture(); await data.reader.initialize(); await data.reader.fetchPage(1, legendAnalysisPageUrl(1)); data.respond(status, 200)
    const gotos = data.navigations.length
    await assert.rejects(data.reader.fetchPage(2, legendAnalysisPageUrl(2)))
    assert.equal(data.reader.getDiagnostics().lastHttpStatus, status)
    assert.equal(data.navigations.length, gotos + 1)
    assert.equal(data.navigations.at(-1), legendAnalysisPageUrl(2))
  }
  const redirect = fixture(); await redirect.reader.initialize(); await redirect.reader.fetchPage(1, legendAnalysisPageUrl(1)); redirect.redirect()
  await assert.rejects(redirect.reader.fetchPage(2, legendAnalysisPageUrl(2)), /condition-mismatch/)
})

test('goto stops a challenge without retry even when the document reports a server fault', async () => {
  const captcha = fixture(); await captcha.reader.initialize(); await captcha.reader.fetchPage(1, legendAnalysisPageUrl(1)); captcha.showChallenge(); captcha.respond(503, 200)
  const before = captcha.reader.getDiagnostics().requestCount
  await assert.rejects(captcha.reader.fetchPage(2, legendAnalysisPageUrl(2)), /http-denied/)
  assert.equal(captcha.reader.getDiagnostics().requestCount - before, 1)
  assert.equal(captcha.reader.getDiagnostics().humanVerification.domDetected, false)
})

test('a visible human-verification control on a successful HTTP page stops before ranking reads', async () => {
  const data = fixture(); await data.reader.initialize(); data.showSharedChallenge()
  const reads = data.readCount(), requests = data.reader.getDiagnostics().requestCount
  await assert.rejects(data.reader.fetchPage(2, legendAnalysisPageUrl(2)), /http-denied/)
  assert.equal(data.reader.getDiagnostics().requestCount - requests, 1)
  assert.equal(data.readCount(), reads)
  assert.deepEqual(data.reader.getDiagnostics().humanVerification, { wafHeaderChecked: true, wafAction: null, domDetected: true })
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

test('ranking observation freezes both rows and header before asynchronous identity hashing', async t => {
  // Simulate a later hydration update; this regression does not establish a cause for any live duplicate.
  function element(value = '', children: Record<string, unknown[]> = {}, attributes: Record<string, string> = {}) {
    return { innerText: value, textContent: value, innerHTML: value, parentElement: null,
      getBoundingClientRect: () => ({ width: 100, height: 20 }), hasAttribute: () => false,
      getAttribute: (name: string) => attributes[name] ?? null, closest: () => null,
      querySelectorAll: (selector: string) => children[selector] ?? [], scrollIntoView: () => {} }
  }
  const select = (value: string, label: string) => Object.assign(element(), { value, options: [element(label)], selectedOptions: [element(label)] })
  const asset = (path: string) => Object.assign(element(), { complete: true, naturalWidth: 100,
    currentSrc: `https://www.streetfighter.com${path}` })
  const makeRow = (profile: string, character: string, rank: number, mr: number) => {
    const attributes = { href: `/6/buckler/ja-jp/profile/${profile}` }
    const rankNode = element(`${rank}位`), mrNode = element(`${mr}MR`)
    const nameNode = element(`Synthetic ${profile}`)
    const characterImage = asset(`/6/buckler/assets/images/material/character/character_${character}_l.png`)
    const badgeImage = asset('/6/buckler/assets/images/material/rank/rank37_l.png')
    const row = element('private display name', {
      'div[class*="ranking_page_data"]': [element()],
      'p[class*="ranking_fighter__"] span[class*="ranking_name__"]': [nameNode],
      '[class*="ranking_time"]': [element('', { 'dl dt': [rankNode], 'dl dd': [mrNode] })],
      'div[class*="ranking_character"]': [element('', { img: [characterImage] })],
      'div[class*="ranking_league_rank_icon"] p[class*="ranking_master_rating_icon"]': [element('', { img: [badgeImage] })],
    }, attributes)
    return { row, setName: (name: string) => { nameNode.innerText = name },
      setLegend: () => { badgeImage.currentSrc = 'https://www.streetfighter.com/6/buckler/assets/images/material/rank/rank37_l.png' },
      replace: (profile: string, character: string, rank: number, mr: number) => {
      attributes.href = `/6/buckler/ja-jp/profile/${profile}`
      rankNode.innerText = `${rank}位`; mrNode.innerText = `${mr}MR`
      characterImage.currentSrc = `https://www.streetfighter.com/6/buckler/assets/images/material/character/character_${character}_l.png`
      badgeImage.currentSrc = 'https://www.streetfighter.com/6/buckler/assets/images/material/rank/rank42_l.png'
    } }
  }
  const rows = [makeRow('987654321', 'ryu', 1, 2430), makeRow('987654322', 'ken', 2, 2420)]
  const pageSelectors = [select('1', '1'), select('1', '1')]
  const counter = element('1 - 2/ 800000')
  const controls = [element('ログアウト')]
  const nodes: Record<string, unknown[]> = {
    'a,button': controls, 'h1,h2': [],
    select: [select('1', '総合'), select('0', 'すべて'), select('1', 'すべて'), ...pageSelectors],
    'aside[class*="ranking_act_nav"] li[class*="active"]': [element('今Act')],
    'p[class*="ranking_ranking_now"]': [counter],
    'ul[class*="ranking_ranking_list"]:not([class*="ranking__my__list"])': [element('', { 'a[href*="/profile/"]': rows.map(value => value.row) })],
  }
  const globals: Record<string, unknown> = {
    document: { querySelectorAll: (selector: string) => nodes[selector] ?? [] },
    window: { scrollTo: () => {}, getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }) },
    location: { origin: 'https://www.streetfighter.com' },
  }
  const previous = Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const)
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value })
  t.mock.method(globalThis, 'setTimeout', ((callback: () => void) => { callback(); return 0 }) as unknown as typeof setTimeout)
  t.after(() => { for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key) } })

  const originalDigest = crypto.subtle.digest.bind(crypto.subtle)
  const salt = 'atomic-observation-regression'
  const expectedInputs = ['987654321', '987654322'].map(profile => `${salt}:/6/buckler/ja-jp/profile/${profile}`)
  const expectedKeys = await Promise.all(expectedInputs.map(async value => [...new Uint8Array(await originalDigest('SHA-256', new TextEncoder().encode(value)))].map(byte => byte.toString(16).padStart(2, '0')).join('')))
  let markHashStarted!: () => void, releaseHash!: () => void
  const hashStarted = new Promise<void>(resolve => { markHashStarted = resolve })
  const hashGate = new Promise<void>(resolve => { releaseHash = resolve })
  const hashedInputs: string[] = []
  t.mock.method(crypto.subtle, 'digest', async (algorithm: AlgorithmIdentifier, data: BufferSource) => {
    hashedInputs.push(new TextDecoder().decode(data))
    markHashStarted()
    await hashGate
    return originalDigest(algorithm, data)
  })
  const pending = observeLegendAnalysisDom({ salt, characterIds: ['ryu', 'ken', 'dhalsim', 'honda'] })
  try {
    await Promise.race([hashStarted, pending.then(() => { throw new Error('The valid observation must reach identity hashing.') })])
    rows[0].replace('777777771', 'dhalsim', 21, 2100)
    rows[1].replace('777777772', 'honda', 22, 2090)
    counter.innerText = '21 - 22/ 800001'
    for (const selector of pageSelectors) selector.value = '2'
    controls[0].innerText = 'ログイン'
  } finally { releaseHash() }
  const observed = await pending
  assert.equal(observed.signedIn, true)
  assert.equal(observed.authenticationEvidence, 'logout-control')
  assert.equal(observed.selectedPage, 1)
  assert.deepEqual(observed.range, { from: 1, to: 2, total: 800000 })
  assert.equal(observed.firstPlayUrl, 'https://www.streetfighter.com/6/buckler/ja-jp/profile/987654321/play')
  assert.deepEqual(observed.entries, [
    { accountKey: expectedKeys[0], characterId: 'ryu', rank: 1, masterRating: 2430, isLegend: true },
    { accountKey: expectedKeys[1], characterId: 'ken', rank: 2, masterRating: 2420, isLegend: true },
  ])
  assert.deepEqual(hashedInputs, expectedInputs)
  const { firstPlayUrl: _privateNavigation, ...safeObservation } = observed
  assert.doesNotMatch(JSON.stringify(safeObservation), /987654321|987654322|777777771|777777772|private display name/)
  const withNames = await observeLegendAnalysisDom({ salt, characterIds: ['ryu', 'ken', 'dhalsim', 'honda'], includePlayers: true })
  assert.deepEqual(withNames.entries?.map(row => row.playerName), ['Synthetic 987654321', 'Synthetic 987654322'])
  assert.equal(withNames.entries?.some(row => row.playerName === 'private display name'), false)
  // A blank label is rejected only for listed Legend entries; non-Legend rows are never projected.
  rows[0].replace('987654321', 'ryu', 1, 2430)
  rows[0].setLegend()
  rows[0].setName('')
  const noNameOptIn = await observeLegendAnalysisDom({ salt, characterIds: ['ryu', 'ken', 'dhalsim', 'honda'], includePlayers: true })
  assert.equal(noNameOptIn.entries, null)
  const noNameDefault = await observeLegendAnalysisDom({ salt, characterIds: ['ryu', 'ken', 'dhalsim', 'honda'] })
  assert.ok(noNameDefault.entries)
})
