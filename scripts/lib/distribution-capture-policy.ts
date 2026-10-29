/** Shared LP/MR estimate policy. A protection response never triggers retry or restart. */
export const DISTRIBUTION_START_INTERVAL_MS = 5000
export const DISTRIBUTION_SESSION_REFRESH_MS = 20 * 60_000
export const DISTRIBUTION_MAX_READ_ATTEMPTS = 2

export function distributionReadRetryDelay(code: unknown): number | null {
  if (code === 'server-error') return 5000
  return code === 'timeout' || code === 'read-failed' || code === 'authentication-unconfirmed' ? 500 : null
}
