import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { isAllowedLegendDailyExecution, LEGEND_DAILY_OUTPUT, LegendDailyError, runLegendDaily } from './collect-legend-analysis-daily.ts'
import { LEGEND_DAILY_HISTORY, LEGEND_DAILY_INCOMING, publishLegendDaily } from './publish-legend-analysis-daily.ts'

const PRIVATE = 'synthetic-legend-session'
const now = new Date('2026-10-16T13:30:00.000Z')
const session = JSON.stringify({ schemaVersion: 1, capturedAt: '2026-10-15T01:00:00.000Z', uploadedAt: '2026-10-15T01:01:00.000Z',
  storageState: { cookies: [{ name: 'session', value: PRIVATE, domain: '.streetfighter.com', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' }], origins: [] } })
function environment(): Record<string, string | undefined> {
  return { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Windows', GITHUB_REPOSITORY: 'gonchiman/sf6',
    GITHUB_REF: 'refs/heads/main', GITHUB_WORKFLOW_REF: 'gonchiman/sf6/.github/workflows/legend-analysis-daily.yml@refs/heads/main',
    GITHUB_EVENT_NAME: 'schedule', BUCKLER_WEEKLY_SESSION: session, GH_TOKEN: 'not-for-browser', PATH: 'test-path' }
}
function result(succeeded: boolean) {
  return { succeeded, report: { status: succeeded ? 'succeeded' as const : 'failed' as const, reason: succeeded ? null : 'access-unavailable' as const,
    startedAt: now.toISOString(), endedAt: now.toISOString(), requestCount: 30, retryCount: 0, datasetId: succeeded ? 'legend-test' : null, browserClosed: true } }
}

test('daily collection is restricted to this main workflow and consumes the Secret before every guard', async () => {
  for (const patch of [{ RUNNER_OS: 'Linux' }, { GITHUB_REF: 'refs/heads/other' }, { GITHUB_EVENT_NAME: 'pull_request' },
    { GITHUB_WORKFLOW_REF: 'gonchiman/sf6/.github/workflows/rank-distribution-weekly.yml@refs/heads/main' }]) {
    const env: Record<string, string | undefined> = { ...environment(), ...patch }
    assert.equal(isAllowedLegendDailyExecution(env), false)
    await assert.rejects(runLegendDaily({ env, now: () => now, collect: async () => { throw new Error('must not launch') } }),
      (error: unknown) => error instanceof LegendDailyError && error.code === 'runner' && !error.message.includes(PRIVATE))
    assert.equal(env.BUCKLER_WEEKLY_SESSION, undefined)
  }
})

test('daily collection validates the aggregate directory before allowing an artifact, including safe failure reports', async () => {
  for (const succeeded of [true, false]) {
    const env = environment(), calls: string[] = []
    const actual = await runLegendDaily({ env, now: () => now, collect: async options => {
      calls.push('collect')
      assert.equal(env.BUCKLER_WEEKLY_SESSION, undefined)
      assert.equal(options.storageState.cookies[0].value, PRIVATE)
      assert.equal(options.outputDirectory, LEGEND_DAILY_OUTPUT)
      assert.deepEqual(options.browserEnvironment, { PATH: 'test-path' })
      return result(succeeded)
    }, validate: async path => { calls.push('validate'); assert.ok(path.endsWith('public')); return { datasets: succeeded ? 1 : 0, entries: succeeded ? 500 : 0 } },
    artifactReady: async () => { calls.push('artifact') } })
    assert.deepEqual(actual, { succeeded })
    assert.deepEqual(calls, ['collect', 'validate', 'artifact'])
    assert.ok(!JSON.stringify(actual).includes(PRIVATE))
  }
})

test('invalid sessions, browser errors and failed output validation never authorize uploads or expose supplied secrets', async () => {
  const env = { ...environment(), BUCKLER_WEEKLY_SESSION: PRIVATE }
  await assert.rejects(runLegendDaily({ env, now: () => now }), (e: unknown) => e instanceof LegendDailyError && e.code === 'session' && !e.message.includes(PRIVATE))
  let marked = false
  await assert.rejects(runLegendDaily({ env: environment(), now: () => now, collect: async () => { throw new Error(PRIVATE) }, artifactReady: async () => { marked = true } }), /取得を完了/)
  await assert.rejects(runLegendDaily({ env: environment(), now: () => now, collect: async () => result(true), validate: async () => { throw new Error(PRIVATE) }, artifactReady: async () => { marked = true } }), /集計出力/)
  assert.equal(marked, false)
})

test('publisher uses fixed isolated aggregate paths and the same workflow gate', async () => {
  let called = false
  await publishLegendDaily({ env: environment(), publish: async (input, output) => {
    called = true; assert.equal(input, LEGEND_DAILY_INCOMING); assert.equal(output, LEGEND_DAILY_HISTORY)
    return { datasets: 1, entries: 500 }
  } })
  assert.equal(called, true)
  await assert.rejects(publishLegendDaily({ env: {}, publish: async () => { throw new Error('must not publish') } }), /固定main/)
})

test('daily workflow isolates authentication from write access and uploads only the strict aggregate files', async () => {
  const workflow = await readFile(new URL('../.github/workflows/legend-analysis-daily.yml', import.meta.url), 'utf8')
  const [collect, publish] = workflow.split('  save-history:')
  assert.match(workflow, /cron: '45 13 \* \* \*'/)
  assert.match(collect, /contents: read/)
  assert.doesNotMatch(collect, /contents: write/)
  assert.match(collect, /secrets\.BUCKLER_WEEKLY_SESSION/)
  assert.doesNotMatch(publish, /BUCKLER_WEEKLY_SESSION/)
  assert.match(collect, /output\/public\/legend-\*\.json/)
  assert.match(publish, /git add -- public/)
  assert.doesNotMatch(publish, /--force/)
})
