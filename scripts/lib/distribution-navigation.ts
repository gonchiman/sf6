import type { Page } from 'playwright'

export interface DistributionNavigationOptions {
  minIntervalMs: number
  now: () => number
  wait: (milliseconds: number) => Promise<void>
  check: () => void
  navigateWithPacing?: <T>(navigate: () => Promise<T>) => Promise<T>
}

/** Share navigation timing without changing either reader's acceptance or retry policy. */
export function createDistributionNavigation(page: Pick<Page, 'goto'>, options: DistributionNavigationOptions) {
  let lastNavigation: number | null = null
  return async (url: string, beforeNavigate: () => void) => {
    if (!options.navigateWithPacing && lastNavigation !== null) {
      await options.wait(Math.max(0, options.minIntervalMs - (options.now() - lastNavigation)))
    }
    const navigate = () => {
      options.check()
      lastNavigation = options.now()
      // Reset per-request evidence in the same stack as the actual navigation.
      beforeNavigate()
      return page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
    }
    return options.navigateWithPacing ? options.navigateWithPacing(navigate) : navigate()
  }
}
