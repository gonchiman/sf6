import type { SteamPlayerCountGame, SteamPlayerCountHourlyRow, SteamPlayerCountObservation } from './steamPlayerCount.ts'

export interface SteamPlayerCountComparisonInput {
  game: SteamPlayerCountGame
  observations: readonly SteamPlayerCountObservation[]
}

export interface SteamPlayerCountComparisonSeries {
  game: SteamPlayerCountGame
  hourly: SteamPlayerCountHourlyRow[]
  /** Mean of each date's complete common hours, then an equally weighted mean of dates. */
  periodMean: number | null
  /** Largest individual observation within a complete common hour. */
  peak: number | null
}

export interface SteamPlayerCountGameComparison {
  series: SteamPlayerCountComparisonSeries[]
  /** Shared coverage; mean is intentionally null because games have separate values. */
  hourly: SteamPlayerCountHourlyRow[]
  commonDays: number
  commonHours: number
  /** Slots included in the statistics (four per complete common hour). */
  commonSlots: number
  expectedSlots: number
  totalDays: number
}
