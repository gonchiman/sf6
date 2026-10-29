import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { isAllowedLegendDailyExecution, legendDailyIncludesPlayers, LEGEND_DAILY_OUTPUT, LegendDailyError, runLegendDaily } from './collect-legend-analysis-daily.ts'
import { LEGEND_DAILY_HISTORY, LEGEND_DAILY_INCOMING, publishLegendDaily } from './publish-legend-analysis-daily.ts'
import { publishLegendDailyBundle, validateLegendDailyBundle } from './lib/legend-analysis-daily-bundle.ts'
import { legendAnalysisPathWithin } from './lib/legend-analysis-files.ts'
import { LEGEND_ANALYSIS_SOURCE, LEGEND_ANALYSIS_VALIDATION_CHECKS, summarizeLegendMr } from '../src/lib/legendAnalysis.ts'
import { createLegendPlayersDescriptor, parseLegendPlayersDataset } from '../src/lib/legendPlayers.ts'

const PRIVATE = 'synthetic-legend-session'
const now = new Date('2026-10-16T13:30:00.000Z')
const session = JSON.stringify({ schemaVersion: 1, capturedAt: '2026-10-15T01:00:00.000Z', uploadedAt: '2026-10-15T01:01:00.000Z',
  storageState: { cookies: [{ name: 'session', value: PRIVATE, domain: '.streetfighter.com', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' }], origins: [] } })
function environment(): Record<string, string | undefined> {
  return { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Windows', GITHUB_REPOSITORY: 'gonchiman/sf6',
    GITHUB_REF: 'refs/heads/main', GITHUB_WORKFLOW_REF: 'gonchiman/sf6/.github/workflows/legend-analysis-daily.yml@refs/heads/main',
    GITHUB_EVENT_NAME: 'schedule', LEGEND_PLAYERS_ENABLED: 'false', BUCKLER_WEEKLY_SESSION: session, GH_TOKEN: 'not-for-browser', PATH: 'test-path' }
}
function result(succeeded: boolean) {
  return { succeeded, report: { status: succeeded ? 'succeeded' as const : 'failed' as const, reason: succeeded ? null : 'access-unavailable' as const,
    startedAt: now.toISOString(), endedAt: now.toISOString(), requestCount: 30, retryCount: 0, datasetId: succeeded ? 'legend-test' : null, browserClosed: true,
    lastAttemptedPage: 26, successfulReadCount: 28, captureAttempt: 1, collectionPhase: 'listing' as const } }
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
      assert.equal(options.includePlayers, false)
      assert.deepEqual(options.browserEnvironment, { PATH: 'test-path' })
      return result(succeeded)
    }, logReport: report => { calls.push('report'); assert.equal(report.lastAttemptedPage, 26); assert.equal(report.captureAttempt, 1); assert.equal(report.successfulReadCount, 28); assert.equal(report.collectionPhase, 'listing') },
    validate: async (path, includePlayers) => { calls.push('validate'); assert.ok(path.endsWith('public')); assert.equal(includePlayers, false); return { datasets: succeeded ? 1 : 0, entries: succeeded ? 500 : 0 } },
    artifactReady: async () => { calls.push('artifact') } })
    assert.deepEqual(actual, { succeeded })
    assert.deepEqual(calls, ['collect', 'report', 'validate', 'artifact'])
    assert.ok(!JSON.stringify(actual).includes(PRIVATE))
  }
})

test('invalid sessions, browser errors and failed output validation never authorize uploads or expose supplied secrets', async () => {
  const env = { ...environment(), BUCKLER_WEEKLY_SESSION: PRIVATE }
  await assert.rejects(runLegendDaily({ env, now: () => now }), (e: unknown) => e instanceof LegendDailyError && e.code === 'session' && !e.message.includes(PRIVATE))
  let marked = false
  await assert.rejects(runLegendDaily({ env: environment(), now: () => now, collect: async () => { throw new Error(PRIVATE) }, artifactReady: async () => { marked = true } }), /取得を完了/)
  await assert.rejects(runLegendDaily({ env: environment(), now: () => now, collect: async () => result(true), logReport: () => {}, validate: async () => { throw new Error(PRIVATE) }, artifactReady: async () => { marked = true } }), /集計出力/)
  assert.equal(marked, false)
})

test('daily stdout emits only a sanitized capture report, including when collection failed', async t => {
  const lines: unknown[] = []
  t.mock.method(console, 'log', (...values: unknown[]) => { lines.push(...values) })
  const supplied = result(false)
  Object.assign(supplied.report, { lastAttemptedPage: Number.MAX_SAFE_INTEGER, successfulReadCount: 99999,
    captureAttempt: 999, collectionPhase: PRIVATE, lastStep: PRIVATE, datasetId: `legend-${PRIVATE}`,
    profileUrl: `https://example.com/${PRIVATE}`, storageState: { cookies: [PRIVATE] }, localPath: `C:/Users/${PRIVATE}`,
    collectionErrorCode: PRIVATE, validationCheck: PRIVATE, recheckChangeKinds: ['metadata', PRIVATE] })
  await runLegendDaily({ env: environment(), now: () => now, collect: async () => supplied,
    validate: async () => ({ datasets: 0, entries: 0 }), artifactReady: async () => {} })
  assert.equal(lines.length, 1)
  const text = String(lines[0]), emitted = JSON.parse(text).capture
  assert.equal(emitted.status, 'failed')
  assert.equal(emitted.lastAttemptedPage, null)
  assert.equal(emitted.captureAttempt, null)
  assert.equal(emitted.collectionPhase, 'preparation')
  assert.equal(emitted.successfulReadCount, 0)
  assert.equal(emitted.collectionErrorCode, null)
  assert.equal(emitted.validationCheck, null)
  assert.equal(emitted.recheckChangeKinds, null)
  for (const value of [PRIVATE, 'storageState', 'cookies', 'profileUrl', 'localPath', 'C:/Users']) assert.equal(text.includes(value), false)
})

test('publisher uses fixed isolated bundle paths and the same workflow gate', async () => {
  let called = false
  await publishLegendDaily({ env: environment(), publish: async (input, output, includePlayers) => {
    called = true; assert.equal(input, LEGEND_DAILY_INCOMING); assert.equal(output, LEGEND_DAILY_HISTORY)
    assert.equal(includePlayers, false)
  } })
  assert.equal(called, true)
  await assert.rejects(publishLegendDaily({ env: {}, publish: async () => { throw new Error('must not publish') } }), /固定main/)
})

test('daily workflow isolates authentication and gates player files behind explicit manual or schedule opt-in', async () => {
  const workflow = await readFile(new URL('../.github/workflows/legend-analysis-daily.yml', import.meta.url), 'utf8')
  const [collect, publish] = workflow.split('  save-history:')
  assert.match(workflow, /cron: '45 13 \* \* \*'/)
  assert.match(collect, /contents: read/)
  assert.doesNotMatch(collect, /contents: write/)
  assert.match(collect, /secrets\.BUCKLER_WEEKLY_SESSION/)
  assert.doesNotMatch(publish, /BUCKLER_WEEKLY_SESSION/)
  assert.match(collect, /output\/public\/legend-\*\.json/)
  assert.match(collect, /output\/public\/players\/index\.json/)
  assert.match(collect, /output\/public\/players\/legend-\*\.json/)
  assert.match(workflow, /include_players:[\s\S]*type: boolean[\s\S]*default: false/)
  assert.match(workflow, /github\.event_name == 'workflow_dispatch' && inputs\.include_players/)
  assert.match(workflow, /github\.event_name == 'schedule' && vars\.LEGEND_PLAYERS_DAILY_ENABLED == 'true'/)
  assert.match(publish, /git add -- public/)
  assert.doesNotMatch(publish, /--force/)
})

test('player collection settings fail closed and valid opt-in reaches both collection and validation', async () => {
  for (const value of [undefined, '', 'TRUE', '1', 'unknown']) {
    const env = { ...environment(), LEGEND_PLAYERS_ENABLED: value }
    assert.throws(() => legendDailyIncludesPlayers(env), /取得設定/)
    await assert.rejects(runLegendDaily({ env, now: () => now, collect: async () => { throw new Error('must not launch') } }), /取得設定/)
    assert.equal(env.BUCKLER_WEEKLY_SESSION, undefined)
    await assert.rejects(publishLegendDaily({ env, publish: async () => { throw new Error('must not publish') } }), /取得設定/)
  }
  const calls: string[] = []
  await runLegendDaily({ env: { ...environment(), LEGEND_PLAYERS_ENABLED: 'true' }, now: () => now,
    collect: async options => { assert.equal(options.includePlayers, true); calls.push('collect'); return result(true) },
    validate: async (_path, includePlayers) => { assert.equal(includePlayers, true); calls.push('validate'); return { datasets: 1, entries: 500 } },
    logReport: () => {}, artifactReady: async () => { calls.push('artifact') } })
  assert.deepEqual(calls, ['collect', 'validate', 'artifact'])
})

const bundleGeneratedAt = '2026-10-29T01:00:00.000Z'
async function bundleFixture(t: test.TestContext) {
  const parent = resolve(tmpdir(), 'sf6-legend-daily-bundle-tests')
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(resolve(parent, 'case-'))
  t.after(async () => { if (legendAnalysisPathWithin(parent, root)) await rm(root, { recursive: true, force: true }) })
  return root
}
async function writeBundle(root: string, includePlayers: boolean, day = '27', failed = false) {
  const captured = `2026-10-${day}T00:00:00.000Z`
  const players = parseLegendPlayersDataset({ schemaVersion: 1, id: `legend-${captured.replace(/[:.]/g, '-')}`,
    captureStartedAt: captured, captureEndedAt: captured, generatedAt: captured,
    source: { ...LEGEND_ANALYSIS_SOURCE, population: '人工テスト', metric: '掲載プレイヤー一覧', unit: 'account-character', notes: ['人工テスト。'] },
    act: { id: 'act-13', label: 'Act 13' }, definitionVersion: 'legend-listed-v1', membershipRule: 'official-legend-badge',
    conditions: { region: 'all', platform: 'all', characters: 'all', users: 'source-default' }, totalCount: 1,
    players: [{ id: 'entry-1', playerName: '人工プレイヤー', characterId: 'ryu', rank: 1, masterRating: 2500 }],
    validation: { status: 'verified', coverage: 'all-listed-legend-entries', checks: [...LEGEND_ANALYSIS_VALIDATION_CHECKS], notes: ['人工テスト。'] } })
  const { players: _rows, ...metadata } = players
  const aggregate = { ...metadata, characterIds: ['ryu'],
    characters: [{ characterId: 'ryu', name: 'リュウ', count: 1, mr: summarizeLegendMr([2500]) }], mr: summarizeLegendMr([2500]) }
  const manifest = { schemaVersion: 1, generatedAt: bundleGeneratedAt, source: LEGEND_ANALYSIS_SOURCE,
    datasets: failed ? [] : [createLegendPlayersDescriptor(players)],
    ...(failed ? { availability: { status: 'collection-failed', checkedAt: bundleGeneratedAt, message: '取得失敗' } } : {}) }
  await mkdir(root, { recursive: true })
  await writeFile(resolve(root, 'index.json'), JSON.stringify(manifest))
  if (!failed) await writeFile(resolve(root, `${players.id}.json`), JSON.stringify(aggregate))
  if (includePlayers) {
    await mkdir(resolve(root, 'players'))
    await writeFile(resolve(root, 'players/index.json'), JSON.stringify(manifest))
    if (!failed) await writeFile(resolve(root, `players/${players.id}.json`), JSON.stringify(players))
  }
  return players.id
}
async function bundleSnapshot(root: string, prefix = ''): Promise<Record<string, string>> {
  const result: Record<string, string> = {}
  for (const file of await readdir(root, { withFileTypes: true })) {
    if (file.isDirectory()) Object.assign(result, await bundleSnapshot(resolve(root, file.name), `${prefix}${file.name}/`))
    else result[`${prefix}${file.name}`] = await readFile(resolve(root, file.name), 'utf8')
  }
  return result
}

test('bundle publication retains player history across aggregate-only days and failed player captures', async t => {
  const root = await bundleFixture(t), first = resolve(root, 'first'), second = resolve(root, 'second'), failed = resolve(root, 'failed'), output = resolve(root, 'public')
  const firstId = await writeBundle(first, true)
  assert.deepEqual(await validateLegendDailyBundle(first, true), { datasets: 1, entries: 1 })
  await publishLegendDailyBundle(first, output, true, bundleGeneratedAt)
  const initial = await bundleSnapshot(output)
  await writeBundle(second, false, '28')
  await publishLegendDailyBundle(second, output, false, bundleGeneratedAt)
  const aggregateOnly = await bundleSnapshot(output)
  assert.equal(aggregateOnly[`players/${firstId}.json`], initial[`players/${firstId}.json`])
  assert.equal(aggregateOnly['players/index.json'], initial['players/index.json'])
  assert.equal(JSON.parse(aggregateOnly['index.json']).datasets.length, 2)
  await writeBundle(failed, true, '29', true)
  await publishLegendDailyBundle(failed, output, true, bundleGeneratedAt)
  const after = await bundleSnapshot(output)
  assert.equal(after[`players/${firstId}.json`], initial[`players/${firstId}.json`])
  assert.equal(after[`${firstId}.json`], initial[`${firstId}.json`])
  assert.equal(JSON.parse(after['players/index.json']).availability.status, 'collection-failed')
  assert.equal(JSON.parse(after['players/index.json']).datasets.length, 1)
  assert.equal(JSON.parse(after['index.json']).datasets.length, 2)
})

test('bundle input mismatches and invalid player files cannot modify either existing history family', async t => {
  const root = await bundleFixture(t), first = resolve(root, 'first'), bad = resolve(root, 'bad'), noPlayers = resolve(root, 'no-players'), output = resolve(root, 'public')
  await writeBundle(first, true)
  await publishLegendDailyBundle(first, output, true, bundleGeneratedAt)
  const before = await bundleSnapshot(output)
  await assert.rejects(validateLegendDailyBundle(first, false), /設定と出力/)
  await writeBundle(noPlayers, false)
  await assert.rejects(publishLegendDailyBundle(noPlayers, output, true, bundleGeneratedAt), /設定と出力/)
  const id = await writeBundle(bad, true, '28')
  const manifestPath = resolve(bad, 'players/index.json'), originalManifest = await readFile(manifestPath, 'utf8')
  const mismatchedManifest = JSON.parse(originalManifest)
  mismatchedManifest.generatedAt = '2026-10-29T00:59:00.000Z'
  await writeFile(manifestPath, JSON.stringify(mismatchedManifest))
  await assert.rejects(publishLegendDailyBundle(bad, output, true, bundleGeneratedAt), /取得回/)
  assert.deepEqual(await bundleSnapshot(output), before)
  await writeFile(manifestPath, originalManifest)
  const invalid = JSON.parse(await readFile(resolve(bad, `players/${id}.json`), 'utf8'))
  invalid.players[0].cookies = 'must-not-publish'
  await writeFile(resolve(bad, `players/${id}.json`), JSON.stringify(invalid))
  await assert.rejects(publishLegendDailyBundle(bad, output, true, bundleGeneratedAt))
  assert.deepEqual(await bundleSnapshot(output), before)
})
