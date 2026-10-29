import { readWafAction } from './waf-action.ts'
import type { WafAction } from './waf-action.ts'

export interface DistributionHumanVerificationDiagnostics {
  wafHeaderChecked: boolean
  wafAction: WafAction | null
  domDetected: boolean | null
}

export const emptyDistributionHumanVerification = (): DistributionHumanVerificationDiagnostics => ({
  wafHeaderChecked: false, wafAction: null, domDetected: null,
})

/** Inspect only the current main document from the fixed Buckler/CAPCOM origins. */
export function readDistributionHumanVerificationResponse(response?: {
  url(): string
  headers(): Record<string, string>
} | null): DistributionHumanVerificationDiagnostics {
  try {
    if (response && ['https://www.streetfighter.com', 'https://cid.capcom.com', 'https://auth.cid.capcom.com'].includes(new URL(response.url()).origin)) {
      const evidence = readWafAction(response)
      return { wafHeaderChecked: evidence.checked, wafAction: evidence.action, domDetected: null }
    }
  } catch { /* Missing evidence remains unchecked; never expose raw headers, URLs or errors. */ }
  return emptyDistributionHumanVerification()
}

/** Fixed scalar evidence only; normalization cannot turn an unchecked action into a claim. */
export function normalizeDistributionHumanVerification(value: unknown): DistributionHumanVerificationDiagnostics {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return emptyDistributionHumanVerification()
    const input = value as Record<string, unknown>
    const wafHeaderChecked = input.wafHeaderChecked === true
    return {
      wafHeaderChecked,
      wafAction: wafHeaderChecked && (input.wafAction === 'captcha' || input.wafAction === 'challenge') ? input.wafAction : null,
      domDetected: typeof input.domDetected === 'boolean' ? input.domDetected : null,
    }
  } catch { return emptyDistributionHumanVerification() }
}

/** Strict parsing for published records; callers decide whether this optional field existed. */
export function parseDistributionHumanVerification(value: unknown): DistributionHumanVerificationDiagnostics {
  const fail = (): never => { throw new Error('Invalid distribution human-verification diagnostics') }
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return fail()
    const input = value as Record<string, unknown>
    const keys = Object.keys(input)
    if (keys.length !== 3 || !['wafHeaderChecked', 'wafAction', 'domDetected'].every(key => Object.hasOwn(input, key))) return fail()
    if (typeof input.wafHeaderChecked !== 'boolean' || input.wafAction !== null && input.wafAction !== 'captcha' && input.wafAction !== 'challenge'
      || input.domDetected !== null && typeof input.domDetected !== 'boolean'
      || !input.wafHeaderChecked && input.wafAction !== null) return fail()
    return { wafHeaderChecked: input.wafHeaderChecked, wafAction: input.wafAction as WafAction | null,
      domDetected: input.domDetected as boolean | null }
  } catch { return fail() }
}

/** CAPTCHA is asserted only by its explicit header; other checks use the broader label. */
export function distributionHumanVerificationKind(evidence?: unknown, readFailureCode?: unknown): 'captcha' | 'human-verification' | null {
  const value = normalizeDistributionHumanVerification(evidence)
  if (value.wafAction === 'captcha') return 'captcha'
  return value.wafAction === 'challenge' || value.domDetected === true || readFailureCode === 'human-verification' ? 'human-verification' : null
}

/** Self-contained for page.evaluate: visible evidence only, with no challenge interaction. */
export function observeDistributionHumanVerification(): boolean {
  const visible = (element: Element): boolean => {
    const rect = element.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return false
    for (let parent: Element | null = element; parent; parent = parent.parentElement) {
      const style = window.getComputedStyle(parent)
      if (parent.hasAttribute('hidden') || style.display === 'none' || style.visibility === 'hidden'
        || style.visibility === 'collapse' || Number(style.opacity) === 0) return false
    }
    return true
  }
  return [...document.querySelectorAll('h1,h2')].filter(visible)
    .some(element => /^ユーザーが人間であることを確認する$|^Human Verification$|Verify.*human/i.test((element as HTMLElement).innerText?.trim() ?? ''))
    || [...document.querySelectorAll('#amzn-captcha-verify-button')].some(visible)
}
