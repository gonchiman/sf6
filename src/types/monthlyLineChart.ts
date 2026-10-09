export interface MonthlyLineChartPoint {
  readonly month: string
  /** A real percentage or percentage-point value; null is a missing observation. */
  readonly value: number | null
}

export interface MonthlyLineChartSeries {
  readonly id: string
  readonly label: string
  readonly points: readonly MonthlyLineChartPoint[]
  readonly style: {
    readonly color: string
    readonly dashArray?: string
    readonly marker: 'circle' | 'square' | 'triangle' | 'diamond'
  }
}

export interface MonthlyLineChartAxis {
  readonly start: number
  readonly end: number
  readonly ticks: readonly number[]
}
