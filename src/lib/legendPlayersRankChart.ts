import type { LegendPlayerRow } from '../types/legendPlayers.ts'
import { chartTextWidth } from './chartTextWidth.ts'

export interface LegendRankAxis {
  start: number
  end: number
  ticks: number[]
}
export interface LegendRankPoint {
  row: LegendPlayerRow
  x: number
  y: number
}

const integerFormat = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 0 })
const niceStep = (value: number) => {
  const magnitude = 10 ** Math.floor(Math.log10(Math.max(1, value)))
  return ([1, 2, 5, 10].find(step => step * magnitude >= value) ?? 10) * magnitude
}

/** Match the existing scatter chart's padded numeric axis, with integer MR ticks. */
export function legendMasterRatingAxis(values: readonly number[]): LegendRankAxis {
  const finite = values.filter(value => Number.isFinite(value) && value >= 0)
  if (!finite.length) return { start: 0, end: 1, ticks: [0, 1] }
  const minimum = Math.min(...finite), maximum = Math.max(...finite)
  const padding = Math.max(10, (maximum - minimum) * .08)
  const low = Math.max(0, minimum - padding), high = maximum + padding
  const step = niceStep((high - low) / 5)
  const start = Math.max(0, Math.floor(low / step) * step)
  const end = Math.max(start + step, Math.ceil(high / step) * step)
  const ticks = Array.from({ length: Math.round((end - start) / step) + 1 }, (_, index) => start + index * step)
  return { start, end, ticks }
}

export function createLegendRankChart(rows: readonly LegendPlayerRow[], availableWidth: number) {
  const ordered = rows.map((row, index) => ({ row, index }))
    .filter(({ row }) => Number.isSafeInteger(row.rank) && row.rank >= 1 && Number.isSafeInteger(row.masterRating) && row.masterRating >= 0)
    .sort((a, b) => a.row.rank - b.row.rank || a.index - b.index).map(({ row }) => row)
  const width = Number.isFinite(availableWidth) ? Math.max(1, availableWidth) : 320
  const height = width < 420 ? 300 : 340
  const yAxis = legendMasterRatingAxis(ordered.map(row => row.masterRating))
  const left = Math.min(width * .45, Math.max(48, ...yAxis.ticks.map(tick => chartTextWidth(integerFormat.format(tick)) + 10)))
  const right = Math.max(left + 1, width - 16), top = 28, bottom = height - 48
  const firstRank = ordered[0]?.rank ?? 1, lastRank = ordered.at(-1)?.rank ?? firstRank
  const xAxis: LegendRankAxis = { start: firstRank, end: lastRank, ticks: [] }
  // A single distinct rank remains its real value and is centered, without invented rank labels.
  const x = (rank: number) => firstRank === lastRank ? (left + right) / 2
    : left + 8 + (rank - firstRank) / (lastRank - firstRank) * Math.max(1, right - left - 16)
  const y = (mr: number) => bottom - 8 - (mr - yAxis.start) / (yAxis.end - yAxis.start) * Math.max(1, bottom - top - 16)
  if (firstRank === lastRank) xAxis.ticks = [firstRank]
  else {
    const step = niceStep((lastRank - firstRank) / (width < 420 ? 3 : 5))
    const candidates = [firstRank]
    for (let tick = Math.ceil(firstRank / step) * step; tick < lastRank; tick += step) {
      if (tick > firstRank) candidates.push(tick)
    }
    // Reserve the full inward-facing endpoint labels before choosing intermediate ticks.
    const lastLabelLeft = x(lastRank) - chartTextWidth(integerFormat.format(lastRank))
    let previousRight = x(firstRank) + chartTextWidth(integerFormat.format(firstRank))
    xAxis.ticks = [firstRank]
    for (const tick of candidates.slice(1)) {
      const half = chartTextWidth(integerFormat.format(tick)) / 2
      if (x(tick) - half < previousRight + 10 || x(tick) + half > lastLabelLeft - 10) continue
      xAxis.ticks.push(tick)
      previousRight = x(tick) + half
    }
    xAxis.ticks.push(lastRank)
  }
  const points: LegendRankPoint[] = ordered.map(row => ({ row, x: x(row.rank), y: y(row.masterRating) }))
  const path = points.map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x},${point.y}`).join(' ')
  return { width, height, left, right, top, bottom, xAxis, yAxis, x, y, points, path }
}

/** Repeated activation at an identical coordinate cycles entries, rather than losing tied rows. */
export function nearestLegendRankRow(points: readonly LegendRankPoint[], x: number, y: number,
  selectedId: string | null, radius = 32): string | null {
  let nearest: LegendRankPoint | null = null
  let distance = radius
  for (const point of points) {
    const nextDistance = Math.hypot(point.x - x, point.y - y)
    if (nextDistance <= distance && (!nearest || nextDistance < distance)) {
      nearest = point
      distance = nextDistance
    }
  }
  if (!nearest) return null
  const tied = points.filter(point => point.row.rank === nearest.row.rank && point.row.masterRating === nearest.row.masterRating)
  const selected = tied.findIndex(point => point.row.id === selectedId)
  return tied[(selected + 1) % tied.length].row.id
}

/** Navigate the complete ranking order, including each entry at coincident coordinates. */
export function legendRankKeyboardSelection(points: readonly LegendRankPoint[], selectedId: string | null, key: string): string | null {
  if (!points.length) return null
  const current = points.findIndex(point => point.row.id === selectedId)
  if (key === 'Home') return points[0].row.id
  if (key === 'End') return points.at(-1)!.row.id
  if (key === 'ArrowRight' || key === 'ArrowDown') return points[current < 0 ? 0 : Math.min(points.length - 1, current + 1)].row.id
  if (key === 'ArrowLeft' || key === 'ArrowUp') return points[current < 0 ? points.length - 1 : Math.max(0, current - 1)].row.id
  return null
}
