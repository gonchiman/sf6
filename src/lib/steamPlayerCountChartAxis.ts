/** Step-first zero-based axis, following the existing count/expected-matches charts. */
export function steamPlayerCountPeopleAxis(values: readonly (number | null)[]): {
  maximum: number
  ticks: number[]
} {
  const largest = values.reduce<number>((maximum, value) => value !== null && Number.isFinite(value)
    ? Math.max(maximum, value) : maximum, 0)
  if (largest === 0) return { maximum: 1, ticks: [0, 1] }

  const padded = largest * 1.05
  const desiredStep = padded / 7
  const magnitude = 10 ** Math.floor(Math.log10(desiredStep))
  // Keep whole-person labels evenly spaced, including very small averages.
  const step = [1, 2, 2.5, 5, 10].map(value => Math.max(1, value * magnitude))
    .find(value => value >= desiredStep && Number.isInteger(value))!
  const count = Math.ceil(padded / step)
  return { maximum: count * step, ticks: Array.from({ length: count + 1 }, (_, index) => index * step) }
}
