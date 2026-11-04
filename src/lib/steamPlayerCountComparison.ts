import {
  buildSteamPlayerCountHourlyComparison, filterSteamPlayerCountObservations, STEAM_PLAYER_COUNT_SLOT_MS,
} from './steamPlayerCount.ts'
import type { SteamPlayerCountDateRange, SteamPlayerCountDayType } from '../types/steamPlayerCount.ts'
import type {
  SteamPlayerCountComparisonInput, SteamPlayerCountComparisonSeries, SteamPlayerCountGameComparison,
} from '../types/steamPlayerCountComparison.ts'

const HOUR_MS = 4 * STEAM_PLAYER_COUNT_SLOT_MS
const JST_OFFSET_MS = 9 * HOUR_MS

/** All games use exactly the same complete date/hour groups and equally weighted dates. */
export function buildSteamPlayerCountGameComparison(inputs: readonly SteamPlayerCountComparisonInput[],
  range: SteamPlayerCountDateRange | null, dayType: SteamPlayerCountDayType = 'all', now = new Date()): SteamPlayerCountGameComparison {
  if (new Set(inputs.map(input => input.game.appId)).size !== inputs.length) {
    throw new Error('Steam同時接続数の比較ゲームが重複しています。')
  }
  const hourly = buildSteamPlayerCountHourlyComparison([], inputs.length ? range : null, dayType, now)
  const series: SteamPlayerCountComparisonSeries[] = inputs.map(input => ({
    game: input.game, hourly: hourly.map(row => ({ ...row })), periodMean: null, peak: null,
  }))
  const empty = { series, hourly, commonDays: 0, commonHours: 0, commonSlots: 0,
    expectedSlots: hourly.reduce((sum, row) => sum + row.expectedSlots, 0), totalDays: hourly[0].totalDays }
  if (!range || !inputs.length) return empty

  const slotsByGame = inputs.map(input => new Map(filterSteamPlayerCountObservations(input.observations, range, dayType)
    .filter(observation => Date.parse(observation.observedAt) <= now.getTime())
    .map(observation => [Math.floor(Date.parse(observation.observedAt) / STEAM_PLAYER_COUNT_SLOT_MS), observation])))
  const commonByHour = new Map<number, number[]>()
  for (const slot of slotsByGame[0].keys()) {
    if (!slotsByGame.every(slots => slots.has(slot))) continue
    const hourKey = Math.floor(slot / 4)
    const slots = commonByHour.get(hourKey) ?? []
    slots.push(slot)
    commonByHour.set(hourKey, slots)
  }

  const commonDates = new Set<string>()
  const hourlyMeans = inputs.map(() => Array.from({ length: 24 }, () => [] as number[]))
  const dailyHours = inputs.map(() => new Map<string, number[]>())
  let commonHours = 0
  for (const [hourKey, slots] of commonByHour) {
    const jst = new Date(hourKey * HOUR_MS + JST_OFFSET_MS)
    const date = jst.toISOString().slice(0, 10), hour = jst.getUTCHours()
    hourly[hour].observedSlots += slots.length
    if (slots.length !== 4) continue
    commonHours++
    commonDates.add(date)
    hourly[hour].validDays++
    slotsByGame.forEach((gameSlots, index) => {
      const values = slots.map(slot => gameSlots.get(slot)!.playerCount)
      const mean = values.reduce((sum, value) => sum + value / 4, 0)
      hourlyMeans[index][hour].push(mean)
      const dateMeans = dailyHours[index].get(date) ?? []
      dateMeans.push(mean)
      dailyHours[index].set(date, dateMeans)
      const peak = Math.max(...values)
      series[index].peak = series[index].peak === null ? peak : Math.max(series[index].peak, peak)
    })
  }
  series.forEach((item, index) => {
    item.hourly = hourly.map(row => {
      const means = hourlyMeans[index][row.hour]
      return { ...row, mean: means.length ? means.reduce((sum, value) => sum + value / means.length, 0) : null }
    })
    const dateMeans = [...dailyHours[index].values()].map(values => values.reduce((sum, value) => sum + value / values.length, 0))
    item.periodMean = dateMeans.length ? dateMeans.reduce((sum, value) => sum + value / dateMeans.length, 0) : null
  })
  return { ...empty, series, hourly, commonDays: commonDates.size, commonHours, commonSlots: commonHours * 4 }
}
