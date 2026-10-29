export type AppRoute =
  | { page: 'win-rates' }
  | { page: 'usage-rates' }
  | { page: 'win-rate-history' }
  | { page: 'expected-matches' }
  | { page: 'monthly-win-rate-statistics' }
  | { page: 'monthly-usage-rate-statistics' }
  | { page: 'win-usage-correlation' }
  | { page: 'control-type-ratio' }
  | { page: 'rank-distribution' }
  | { page: 'legend-analysis' }
  | { page: 'legend-analysis-2' }
  | { page: 'new-account-observation' }
  | { page: 'parallel-fetch-test' }
  | { page: 'sample-survey' }
  | { page: 'characters'; characterId: string | null }
  | { page: 'character-releases' }
  | { page: 'character-traits' }
  | { page: 'balance-adjustments' }
  | { page: 'balance-adjustment-detail'; adjustmentId: string; scope: string | null }

export function characterHash(characterId: string): string {
  return `#characters/${encodeURIComponent(characterId)}`
}

export function balanceAdjustmentDetailHash(adjustmentId: string, scope: string | null = null): string {
  const base = `#balance-adjustments/${encodeURIComponent(adjustmentId)}`
  return scope ? `${base}?scope=${encodeURIComponent(scope)}` : base
}

export function parseHashRoute(hash: string): AppRoute {
  if (hash === '#sample-survey' || hash === '#sample-survey/') {
    return { page: 'sample-survey' }
  }
  if (hash === '#parallel-fetch-test' || hash === '#parallel-fetch-test/') {
    return { page: 'parallel-fetch-test' }
  }
  if (hash === '#legend-analysis' || hash === '#legend-analysis/') {
    return { page: 'legend-analysis' }
  }
  if (hash === '#legend-analysis-2' || hash === '#legend-analysis-2/') {
    return { page: 'legend-analysis-2' }
  }
  if (hash === '#character-releases' || hash === '#character-releases/') {
    return { page: 'character-releases' }
  }
  if (hash === '#win-usage-correlation' || hash === '#win-usage-correlation/') {
    return { page: 'win-usage-correlation' }
  }
  if (hash === '#monthly-usage-rate-statistics' || hash === '#monthly-usage-rate-statistics/') {
    return { page: 'monthly-usage-rate-statistics' }
  }
  if (hash === '#balance-adjustments' || hash === '#balance-adjustments/') {
    return { page: 'balance-adjustments' }
  }
  const adjustmentDetail = /^#balance-adjustments\/([^/?#]+)(?:\?([^#]*))?$/.exec(hash)
  if (adjustmentDetail) {
    const encodedId = adjustmentDetail[1]
    let adjustmentId: string
    try {
      adjustmentId = decodeURIComponent(encodedId)
    } catch {
      adjustmentId = encodedId
    }
    const scope = new URLSearchParams(adjustmentDetail[2]).get('scope') || null
    return { page: 'balance-adjustment-detail', adjustmentId, scope }
  }
  if (hash === '#usage-rates' || hash === '#usage-rates/') {
    return { page: 'usage-rates' }
  }
  if (hash === '#new-account-observation' || hash === '#new-account-observation/') {
    return { page: 'new-account-observation' }
  }
  if (hash === '#rank-distribution' || hash === '#rank-distribution/') {
    return { page: 'rank-distribution' }
  }
  if (hash === '#expected-matches' || hash === '#expected-matches/') {
    return { page: 'expected-matches' }
  }
  if (hash === '#control-type-ratio' || hash === '#control-type-ratio/') {
    return { page: 'control-type-ratio' }
  }
  if (hash === '#monthly-win-rate-statistics' || hash === '#monthly-win-rate-statistics/') {
    return { page: 'monthly-win-rate-statistics' }
  }
  if (hash === '#win-rate-history' || hash === '#win-rate-history/') {
    return { page: 'win-rate-history' }
  }
  if (hash === '#character-traits' || hash === '#character-traits/') {
    return { page: 'character-traits' }
  }
  if (hash === '#characters' || hash === '#characters/') {
    return { page: 'characters', characterId: null }
  }
  if (hash.startsWith('#characters/')) {
    const encodedId = hash.slice('#characters/'.length)
    try {
      return { page: 'characters', characterId: decodeURIComponent(encodedId) }
    } catch {
      return { page: 'characters', characterId: encodedId }
    }
  }
  return { page: 'win-rates' }
}
