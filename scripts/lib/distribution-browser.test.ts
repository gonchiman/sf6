import assert from 'node:assert/strict'
import test from 'node:test'
import type { Browser, BrowserContext, Page } from 'playwright'
import { launchDistributionEdge } from './distribution-browser.ts'

const state = { cookies: [], origins: [] }
const env = { PATH: 'synthetic-path', TEMP: 'synthetic-temp' }

function fixture(failure?: 'context' | 'page' | 'reader', controller = new AbortController()) {
  const calls: Array<{ name: string; value?: unknown }> = []
  const expectedError = new Error('synthetic setup failure')
  const page = {} as Page
  const reader = { fetchPage: async () => 42 }
  const context = { newPage: async () => {
    calls.push({ name: 'page' })
    if (failure === 'page') throw expectedError
    return page
  } } as BrowserContext
  const browser = {
    newContext: async (value: unknown) => {
      calls.push({ name: 'context', value })
      if (failure === 'context') throw expectedError
      return context
    },
    close: async () => { calls.push({ name: 'close' }) },
  } as Pick<Browser, 'newContext' | 'close'>
  const options = { storageState: state, signal: controller.signal, env, createReader: (value: Page) => {
    calls.push({ name: 'reader', value })
    if (failure === 'reader') throw expectedError
    return reader
  } }
  const dependencies = { launch: async (value: unknown) => { calls.push({ name: 'launch', value }); return browser } }
  return { options, dependencies, calls, browser, page, reader, expectedError }
}

test('distribution browser uses the fixed Edge contract and only the supplied environment and memory state', async () => {
  const setup = fixture()
  const result = await launchDistributionEdge(setup.options, setup.dependencies)
  assert.deepEqual(setup.calls.map(call => call.name), ['launch', 'context', 'page', 'reader'])
  assert.deepEqual(setup.calls[0].value, { channel: 'msedge', headless: false, env, timeout: 30000 })
  assert.deepEqual(setup.calls[1].value, { locale: 'ja-JP', acceptDownloads: false, storageState: state })
  assert.equal((setup.calls[1].value as { storageState: unknown }).storageState, state)
  assert.equal(setup.calls[3].value, setup.page)
  assert.equal(result.fetchPage, setup.reader.fetchPage)
  await result.close()
  assert.equal(setup.calls.at(-1)?.name, 'close')
})

test('context, page and reader setup failures close the owned browser and preserve the original failure', async () => {
  for (const stage of ['context', 'page', 'reader'] as const) {
    const setup = fixture(stage)
    await assert.rejects(launchDistributionEdge(setup.options, setup.dependencies), error => error === setup.expectedError)
    assert.equal(setup.calls.filter(call => call.name === 'close').length, 1)
    assert.equal(setup.calls.at(-1)?.name, 'close')
  }
  const setup = fixture('reader')
  setup.browser.close = async () => { throw new Error('secondary close failure') }
  await assert.rejects(launchDistributionEdge(setup.options, setup.dependencies), error => error === setup.expectedError)
})

test('cancellation before launch opens nothing and cancellation during context setup closes before creating a reader', async () => {
  const controller = new AbortController()
  const setup = fixture(undefined, controller)
  controller.abort()
  await assert.rejects(launchDistributionEdge(setup.options, setup.dependencies), error => error === controller.signal.reason)
  assert.deepEqual(setup.calls, [])

  const during = new AbortController()
  const pending = fixture(undefined, during)
  const createContext = pending.browser.newContext
  pending.browser.newContext = async value => {
    const context = await createContext(value)
    during.abort()
    return context
  }
  await assert.rejects(launchDistributionEdge(pending.options, pending.dependencies), error => error === during.signal.reason)
  assert.deepEqual(pending.calls.map(call => call.name), ['launch', 'context', 'close'])
})
