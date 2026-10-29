import assert from 'node:assert/strict'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { distributionHumanVerificationKind, emptyDistributionHumanVerification, normalizeDistributionHumanVerification,
  observeDistributionHumanVerification, parseDistributionHumanVerification, readDistributionHumanVerificationResponse } from './distribution-human-verification.ts'

const PRIVATE = 'synthetic-private-header'
const response = (url: string, headers: Record<string, string> = {}) => ({ url: () => url, headers: () => headers })

test('first-party HTTPS response evidence keeps only the action enum and distinguishes absent from unchecked headers', () => {
  for (const origin of ['https://www.streetfighter.com', 'https://cid.capcom.com', 'https://auth.cid.capcom.com']) {
    for (const action of ['captcha', 'challenge'] as const) {
      const value = readDistributionHumanVerificationResponse(response(`${origin}/check`, { 'x-amzn-waf-action': action, 'set-cookie': PRIVATE }))
      assert.deepEqual(value, { wafHeaderChecked: true, wafAction: action, domDetected: null })
      assert.equal(JSON.stringify(value).includes(PRIVATE), false)
    }
    for (const headers of [{}, { 'x-amzn-waf-action': PRIVATE }, { 'x-amzn-waf-action': 'CAPTCHA' }]) {
      assert.deepEqual(readDistributionHumanVerificationResponse(response(`${origin}/check`, headers)), {
        wafHeaderChecked: true, wafAction: null, domDetected: null,
      })
    }
  }
  assert.deepEqual(readDistributionHumanVerificationResponse({ url: () => 'https://www.streetfighter.com/check',
    headers: () => { throw new Error(PRIVATE) } }), emptyDistributionHumanVerification())
})

test('untrusted, missing and malformed response URLs cannot establish WAF evidence or expose headers', () => {
  for (const url of ['https://example.com', 'https://www.streetfighter.com.example.com', 'http://www.streetfighter.com',
    'https://www.streetfighter.com:8443', 'not-a-url']) {
    assert.deepEqual(readDistributionHumanVerificationResponse({ url: () => url,
      headers: () => { assert.fail('do not inspect an unrelated response') } }), emptyDistributionHumanVerification())
  }
  assert.deepEqual(readDistributionHumanVerificationResponse(null), emptyDistributionHumanVerification())
  assert.deepEqual(readDistributionHumanVerificationResponse(), emptyDistributionHumanVerification())
  assert.deepEqual(readDistributionHumanVerificationResponse({ url: () => { throw new Error(PRIVATE) },
    headers: () => ({ 'x-amzn-waf-action': 'captcha' }) }), emptyDistributionHumanVerification())
})

test('normalization and strict parsing preserve separate header and DOM evidence without copying private fields', () => {
  for (const value of [emptyDistributionHumanVerification(),
    { wafHeaderChecked: true, wafAction: null, domDetected: false },
    { wafHeaderChecked: true, wafAction: 'captcha', domDetected: null },
    { wafHeaderChecked: true, wafAction: 'challenge', domDetected: null },
    { wafHeaderChecked: false, wafAction: null, domDetected: true }]) {
    assert.deepEqual(parseDistributionHumanVerification(value), value)
    assert.deepEqual(normalizeDistributionHumanVerification({ ...value, headers: PRIVATE, html: PRIVATE }), value)
  }
  assert.deepEqual(normalizeDistributionHumanVerification({ wafHeaderChecked: false, wafAction: 'captcha', domDetected: true }), {
    wafHeaderChecked: false, wafAction: null, domDetected: true,
  })
  for (const value of [null, undefined, [], PRIVATE, { wafHeaderChecked: 'true', wafAction: PRIVATE, domDetected: 'true' },
    { get wafHeaderChecked() { throw new Error(PRIVATE) } }]) {
    assert.deepEqual(normalizeDistributionHumanVerification(value), emptyDistributionHumanVerification())
  }
  const empty = emptyDistributionHumanVerification()
  const invalid = [null, undefined, [], {}, PRIVATE, { ...empty, headers: PRIVATE },
    { wafHeaderChecked: true, wafAction: 'captcha' }, { wafAction: null, domDetected: null },
    { ...empty, wafHeaderChecked: 'false' }, { ...empty, wafAction: PRIVATE },
    { ...empty, wafAction: 'captcha' }, { ...empty, wafAction: 'challenge' }, { ...empty, domDetected: 0 },
    Object.create(empty), { get wafHeaderChecked() { throw new Error(PRIVATE) }, wafAction: null, domDetected: null }]
  for (const value of invalid) assert.throws(() => parseDistributionHumanVerification(value), error =>
    error instanceof Error && error.message === 'Invalid distribution human-verification diagnostics')
})

test('display classification never treats HTTP 405, an unknown action or an unchecked claim as confirmed CAPTCHA', () => {
  const empty = emptyDistributionHumanVerification()
  assert.equal(distributionHumanVerificationKind({ ...empty, wafHeaderChecked: true, wafAction: 'captcha' }), 'captcha')
  assert.equal(distributionHumanVerificationKind({ ...empty, wafHeaderChecked: true, wafAction: 'challenge' }), 'human-verification')
  assert.equal(distributionHumanVerificationKind({ ...empty, domDetected: true }), 'human-verification')
  assert.equal(distributionHumanVerificationKind(undefined, 'human-verification'), 'human-verification')
  for (const evidence of [undefined, empty, { ...empty, wafAction: 'captcha' }, { ...empty, wafHeaderChecked: true, wafAction: PRIVATE }]) {
    assert.equal(distributionHumanVerificationKind(evidence, 'http-error'), null)
  }
})

function element(text = '') {
  return { innerText: text, parentElement: null as ReturnType<typeof element> | null,
    style: { display: 'block', visibility: 'visible', opacity: '1' }, hidden: false, width: 100, height: 20,
    hasAttribute(name: string) { return name === 'hidden' && this.hidden },
    getBoundingClientRect() { return { width: this.width, height: this.height } },
    click() { assert.fail('challenge controls must not be operated') },
  }
}

test('the serialized DOM detector is self-contained and matches only the existing visible headings or AWS control', () => {
  const headings: ReturnType<typeof element>[] = [], buttons: ReturnType<typeof element>[] = []
  const read = () => runInNewContext(`(${observeDistributionHumanVerification.toString()})()`, {
    document: { querySelectorAll: (selector: string) => selector === 'h1,h2' ? headings : selector === '#amzn-captcha-verify-button' ? buttons : [] },
    window: { getComputedStyle: (node: ReturnType<typeof element>) => node.style },
  })
  assert.equal(read(), false)
  for (const title of ['ユーザーが人間であることを確認する', 'Human Verification', 'Verify you are human']) {
    headings.splice(0, headings.length, element(title))
    assert.equal(read(), true)
  }
  headings.splice(0, headings.length, element('ログインしてください'))
  assert.equal(read(), false)
  buttons.push(element('開始'))
  assert.equal(read(), true)
  for (const patch of [{ hidden: true }, { width: 0 }, { height: 0 }, { style: { display: 'none', visibility: 'visible', opacity: '1' } },
    { style: { display: 'block', visibility: 'hidden', opacity: '1' } }, { style: { display: 'block', visibility: 'collapse', opacity: '1' } },
    { style: { display: 'block', visibility: 'visible', opacity: '0' } }]) {
    buttons[0] = Object.assign(element('開始'), patch)
    assert.equal(read(), false)
  }
  const parent = element(); parent.hidden = true
  buttons[0] = element('開始'); buttons[0].parentElement = parent
  assert.equal(read(), false)
})
