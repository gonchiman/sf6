export type WafAction = 'captcha' | 'challenge'

/** Read synchronously so evidence belongs to this response. Never retain raw headers. */
export function readWafAction(response: { headers(): Record<string, string> }): { checked: boolean; action: WafAction | null } {
  try {
    const value = response.headers()['x-amzn-waf-action']
    return { checked: true, action: value === 'captcha' || value === 'challenge' ? value : null }
  } catch { return { checked: false, action: null } }
}
