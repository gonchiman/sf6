import { leagueSeriesStyle, UNKNOWN_LEAGUE_SERIES_STYLE } from './leagueSeriesColors.ts'
import type { ExpectedMatchRank } from '../types/expectedMatches.ts'

export interface ExpectedMatchLpRankStyle {
  readonly league: string
  readonly number: string
  readonly name: string
  readonly color: string
}

/** LP-only fill: retain 20% of the league color and mix with 80% #707070. */
function lpColor(color: string): string {
  return `#${[1, 3, 5].map(offset => Math.round(Number.parseInt(color.slice(offset, offset + 2), 16) * 0.2 + 112 * 0.8)
    .toString(16).padStart(2, '0')).join('')}`
}

const rankStyles: ReadonlyMap<string, ExpectedMatchLpRankStyle> = new Map([
  ['ROOKIE', '1', 'ルーキー'],
  ['IRON', '2', 'アイアン'],
  ['BRONZE', '3', 'ブロンズ'],
  ['SILVER', '4', 'シルバー'],
  ['GOLD', '5', 'ゴールド'],
  ['PLATINUM', '6', 'プラチナ'],
  ['DIAMOND', '7', 'ダイヤ'],
  ['MASTER', 'M', 'マスター'],
].map(([league, number, name]) => [league, Object.freeze({
  league, number, name, color: lpColor(leagueSeriesStyle(league).color),
})]))

export function expectedMatchLpRankStyle(rankId: string): ExpectedMatchLpRankStyle {
  const league = rankId === 'PLATINUM_STAR_3_5' ? 'PLATINUM' : rankId
  return rankStyles.get(league) ?? Object.freeze({
    league: rankId,
    number: '?',
    name: rankId,
    color: lpColor(UNKNOWN_LEAGUE_SERIES_STYLE.color),
  })
}

/** Keep the model's ascending rank order. Endpoints are exclusive LP boundaries. */
export function expectedMatchLpBands(ranks: readonly ExpectedMatchRank[], targetLp: number): {
  id: string
  minimumLp: number
  endLp: number
  style: ReturnType<typeof expectedMatchLpRankStyle>
}[] {
  if (!Number.isFinite(targetLp) || targetLp <= 0) return []
  return ranks.flatMap((rank, index) => {
    const endLp = Math.min(ranks[index + 1]?.minimumLp ?? targetLp, targetLp)
    if (!Number.isFinite(rank.minimumLp) || !Number.isFinite(endLp) || endLp <= rank.minimumLp) return []
    return [{ id: rank.id, minimumLp: rank.minimumLp, endLp, style: expectedMatchLpRankStyle(rank.id) }]
  })
}
