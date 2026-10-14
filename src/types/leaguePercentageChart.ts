import type { HistoryControlType } from './winRateHistory.ts'

export interface LeaguePercentageChartPoint {
  /** Published percentage; missing states retain their label and have no geometry. */
  readonly value: number | null
  readonly label: string
  readonly lowSample?: boolean
  readonly percentHundredths?: number
  readonly percentThousandths?: number
}

export interface LeaguePercentageChartComparison {
  readonly characterName: string
  readonly leagues: readonly string[]
  readonly series: readonly {
    readonly controlType: HistoryControlType
    readonly points: readonly LeaguePercentageChartPoint[]
  }[]
}
