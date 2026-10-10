import { leagueLabel } from '../lib/winRateConditions'

export function usageRateLeagueLabel(league: string): string {
  return league === 'ALL' ? 'ALL（全体）' : leagueLabel(league)
}

export function ratioPercentLabel(ratio: number | null): string {
  return ratio === null ? '—' : (ratio * 100).toFixed(2)
}

/** Keep a nonzero residual visible even when it is below the display precision. */
export function ratioErrorLabel(points: number | null, signed = false): string {
  if (points === null) return '—'
  if (points !== 0 && Math.abs(points) < 0.00001) {
    if (!signed) return '< 0.00001'
    return points > 0 ? '0 < 差 < 0.00001' : '−0.00001 < 差 < 0'
  }
  const value = points.toFixed(5)
  return signed && points > 0 ? `+${value}` : value
}

export function officialUsageRateLabel(text: string): string {
  return /^\d+(?:\.\d+)?%?$/.test(text) ? `${text.replace(/%$/, '')}%` : text
}
