import type { Browser, BrowserContextOptions, Page } from 'playwright'

type StorageState = Exclude<NonNullable<BrowserContextOptions['storageState']>, string>
type DistributionBrowserLaunchOptions = { channel: 'msedge'; headless: false; env: Record<string, string>; timeout: 30000 }
type DistributionBrowserLauncher = (options: DistributionBrowserLaunchOptions) => Promise<Pick<Browser, 'newContext' | 'close'>>

/** The caller supplies an already filtered environment and validated, in-memory session. */
export async function launchDistributionEdge<T extends object>(options: {
  storageState: StorageState
  signal: AbortSignal
  env: Record<string, string>
  createReader: (page: Page) => T
}, dependencies: { launch?: DistributionBrowserLauncher } = {}): Promise<T & { close(): Promise<void> }> {
  options.signal.throwIfAborted()
  const launch: DistributionBrowserLauncher = dependencies.launch ?? (async launchOptions => {
    const { chromium } = await import('playwright')
    return chromium.launch(launchOptions)
  })
  const browser = await launch({ channel: 'msedge', headless: false, env: options.env, timeout: 30000 })
  try {
    options.signal.throwIfAborted()
    const context = await browser.newContext({ locale: 'ja-JP', acceptDownloads: false, storageState: options.storageState })
    options.signal.throwIfAborted()
    const page = await context.newPage()
    options.signal.throwIfAborted()
    return { ...options.createReader(page), close: () => browser.close() }
  } catch (error) {
    await browser.close().catch(() => {})
    throw error
  }
}
