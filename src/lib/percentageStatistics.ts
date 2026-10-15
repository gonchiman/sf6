/** Describe equally weighted published percentage values in their original integer precision. */
export function calculatePercentageStatistics(values: readonly number[], unitsPerPercent: number) {
  if (values.length === 0) {
    return {
      meanPercent: null, medianPercent: null, standardDeviationPoints: null,
      minimumPercent: null, maximumPercent: null,
    }
  }
  const sorted = [...values].sort((left, right) => left - right)
  const count = sorted.length
  const mean = sorted.reduce((sum, value) => sum + value, 0) / count
  const middle = Math.floor(count / 2)
  const median = count % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
  // N describes the retained published characters; it is not an iid sample estimate.
  const variance = sorted.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / count
  return {
    meanPercent: mean / unitsPerPercent,
    medianPercent: median / unitsPerPercent,
    standardDeviationPoints: count < 2 ? null : Math.sqrt(variance) / unitsPerPercent,
    minimumPercent: sorted[0] / unitsPerPercent,
    maximumPercent: sorted[count - 1] / unitsPerPercent,
  }
}
