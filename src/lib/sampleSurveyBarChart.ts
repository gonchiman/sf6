/** Missing and invalid observations never become zero-length measurements. */
export function sampleSurveyBarValue(value: number | null, percent = false): number | null {
  return value !== null && Number.isFinite(value) && value >= 0 && (!percent || value <= 100)
    ? value === 0 ? 0 : value : null
}

/** A zero-based common scale; percentages retain the full 0–100 range. */
export function sampleSurveyBarAxis(values: readonly (number | null)[], percent = false): {
  maximum: number
  ticks: readonly number[]
} {
  if (percent) return { maximum: 100, ticks: [0, 50, 100] }
  const largest = values.reduce<number>((max, value) => Math.max(max, sampleSurveyBarValue(value) ?? 0), 0)
  if (largest === 0) return { maximum: 1, ticks: [0, .5, 1] }
  const magnitude = Math.max(Number.MIN_VALUE, 10 ** Math.floor(Math.log10(largest)))
  const multiple = [1, 2, 5, 10].find(value => value * magnitude >= largest) ?? 10
  const ceiling = Number((multiple * magnitude).toPrecision(15))
  const maximum = Number.isFinite(ceiling) ? Math.max(largest, ceiling) : largest
  return { maximum, ticks: [0, maximum / 2, maximum] }
}

const numberFormat = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 1 })
const smallFormat = new Intl.NumberFormat('ja-JP', { maximumSignificantDigits: 3 })

export function sampleSurveyBarNumber(value: number): string {
  if (value !== 0 && (value < .001 || value >= 1e10)) return value.toExponential(2)
  return value !== 0 && value < .1 ? smallFormat.format(value) : numberFormat.format(value)
}
