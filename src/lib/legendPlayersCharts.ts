import { summarizeLegendMr } from './legendAnalysis.ts'
import { sampleSurveyBarAxis } from './sampleSurveyBarChart.ts'
import type { LegendPlayerRow } from '../types/legendPlayers.ts'

export type LegendPlayerCharacterCount = {
  characterId: string
  name: string
  count: number
  /** Share of all listed account-character entries, before display rounding. */
  percent: number
}

/** Names and tied ranks never identify unique accounts: every supplied row counts once. */
export function createLegendPlayerCharacterCounts(
  rows: readonly LegendPlayerRow[], names: ReadonlyMap<string, string> | null = null,
): LegendPlayerCharacterCount[] {
  const counts = new Map<string, number>()
  for (const row of rows) counts.set(row.characterId, (counts.get(row.characterId) ?? 0) + 1)
  return [...counts].map(([characterId, count]) => ({
    characterId, name: names?.get(characterId) ?? characterId, count, percent: count / rows.length * 100,
  })).sort((a, b) => b.count - a.count || a.characterId.localeCompare(b.characterId))
}

/** Retain empty interior bins; bin boundaries follow the shared 50-MR definition. */
export function createLegendPlayerMrBins(rows: readonly LegendPlayerRow[]) {
  const distribution = summarizeLegendMr(rows.map(row => row.masterRating))
  return distribution.bins.map(bin => ({ ...bin, percent: bin.count / distribution.count * 100 }))
}

/** Reuse the existing zero-based scale with integer count ticks. */
export function legendPlayerCountAxis(counts: readonly number[]): { maximum: number; ticks: number[] } {
  const { maximum } = sampleSurveyBarAxis(counts)
  const step = Math.max(1, Math.ceil(maximum / 5))
  const ticks = Array.from({ length: Math.floor(maximum / step) + 1 }, (_, index) => index * step)
  if (ticks.at(-1) !== maximum) ticks.push(maximum)
  return { maximum, ticks }
}
