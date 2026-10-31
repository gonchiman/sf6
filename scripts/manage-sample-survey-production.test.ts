import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { deflateRawSync } from 'node:zlib'
import { readFile } from 'node:fs/promises'
import { createSampleSurveyCheckpoint } from './lib/sample-survey-runner.ts'
import { SAMPLE_SURVEY_RESULTS_SOURCE } from '../src/lib/sampleSurveyResults.ts'
import type { SampleSurveyRun } from '../src/types/sampleSurvey.ts'
import { productionStage, parseProductionRun, parseProductionDispatch, validateProductionReport,
  createProductionGitHub, runProductionStage, isAllowedProductionExecution, extractProductionArtifact,
  validateProductionParents } from './manage-sample-survey-production.ts'
import type { ProductionGitHub } from './manage-sample-survey-production.ts'
import type { CloudGhCommand } from './lib/parallel-fetch-github.ts'

const SHA = 'a'.repeat(40), FIRST_SHA = 'b'.repeat(40), PRIVATE = 'synthetic-private-value-never-log'
const START = '2026-10-31T03:00:00.000Z', END = '2026-10-31T04:00:00.000Z'
function rawRun(id = '123', sha = SHA) {
  return { id: Number(id), run_attempt: 1, event: 'workflow_dispatch', head_branch: 'main',
    path: '.github/workflows/sample-survey.yml', head_sha: sha, status: 'completed', conclusion: 'success',
    created_at: START, run_started_at: START, updated_at: END, html_url: `https://github.com/gonchiman/sf6/actions/runs/${id}`,
    repository: { full_name: 'gonchiman/sf6' }, head_repository: { full_name: 'gonchiman/sf6' } }
}
function report(stage = 1): SampleSurveyRun {
  const config = productionStage(stage).config
  const value = createSampleSurveyCheckpoint({ schemaVersion: 1, id: 'synthetic-plan', createdAt: START, seed: '1'.repeat(64), config }, Date.parse(START)).report
  Object.assign(value, { id: 'synthetic-result', state: 'complete', phase: 'complete', finishedAt: END, updatedAt: END,
    elapsedMs: 3600000, attempts: 430, successfulPages: 430, uniqueAccountCount: value.strata.reduce((total, row) => total + row.requested, 0) })
  for (let index = 0; index < value.strata.length; index++) {
    const row = value.strata[index], start = index * 1000, end = start + 1000
    Object.assign(row, { population: 1000, selected: row.requested, processed: row.requested, succeeded: row.requested, mean: 1500, min: 1000, max: 2000 })
    Object.assign(value.observation!.strata[index], { status: 'checked', startedAt: START, finishedAt: END,
      totalCountBefore: 10000, totalCountAfter: 10000, startBefore: start, endBefore: end, startAfter: start, endAfter: end,
      boundaryAcceptance: { mode: 'exact', referenceStart: start, referenceEnd: end, referenceCheckedAt: START,
        start, end, startObservedAt: START, endObservedAt: START } })
  }
  return value
}
function environment() {
  return { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Linux',
    GITHUB_REPOSITORY: 'gonchiman/sf6', GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_WORKFLOW_REF: 'gonchiman/sf6/.github/workflows/sample-survey-production.yml@refs/heads/main',
    GITHUB_SHA: SHA, GITHUB_RUN_ID: '456', GITHUB_RUN_ATTEMPT: '1', GH_TOKEN: PRIVATE }
}
function zip(entries: [string, string][]): Buffer {
  const locals: Buffer[] = [], centrals: Buffer[] = []; let offset = 0
  for (const [name, text] of entries) {
    const filename = Buffer.from(name), bytes = Buffer.from(text), packed = deflateRawSync(bytes)
    let crc = 0xffffffff
    for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0) }
    crc = (crc ^ 0xffffffff) >>> 0
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8)
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(bytes.length, 22); local.writeUInt16LE(filename.length, 26)
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6)
    central.writeUInt16LE(8, 10); central.writeUInt32LE(crc, 16); central.writeUInt32LE(packed.length, 20)
    central.writeUInt32LE(bytes.length, 24); central.writeUInt16LE(filename.length, 28); central.writeUInt32LE(offset, 42)
    locals.push(local, filename, packed); centrals.push(central, filename); offset += local.length + filename.length + packed.length
  }
  const central = Buffer.concat(centrals), end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, central, end])
}
function artifactEntries(value = report()): [string, string][] {
  const path = `runs/${value.id}.json`
  const manifest = { schemaVersion: 1, generatedAt: END, source: SAMPLE_SURVEY_RESULTS_SOURCE, datasets: [{ id: value.id,
    path, captureStartedAt: value.startedAt, captureEndedAt: value.finishedAt }] }
  return [['index.json', JSON.stringify(manifest)], [path, JSON.stringify(value)]]
}

test('production plan covers eight LP ranks at 200 and six MR bands at 100 exactly once', () => {
  const stages = [1, 2, 3, 4, 5].map(productionStage)
  assert.deepEqual(stages.flatMap(row => row.config.ranks), ['ROOKIE', 'IRON', 'BRONZE', 'SILVER', 'GOLD', 'PLATINUM', 'DIAMOND', 'MASTER'])
  for (const row of stages.slice(0, 4)) {
    assert.equal(row.config.ranks.length, 2); assert.equal(row.config.rankSampleSize, 200)
    assert.equal(row.config.includeMr, false); assert.equal(row.config.maxDurationMinutes, 120)
  }
  assert.deepEqual(stages[4].config.ranks, []); assert.equal(stages[4].config.includeMr, true)
  assert.equal(stages[4].config.mrSampleSize, 100); assert.equal(stages[4].config.maxDurationMinutes, 180)
  for (const stage of [0, 6, -1, 1.5, NaN, Infinity]) assert.throws(() => productionStage(stage))
})

test('parent execution requires its own manual main hosted workflow', () => {
  assert.equal(isAllowedProductionExecution(environment()), true)
  for (const patch of [{ GITHUB_ACTIONS: 'false' }, { GITHUB_REPOSITORY: 'other/sf6' }, { GITHUB_REF: 'refs/heads/feature' },
    { GITHUB_EVENT_NAME: 'pull_request' }, { GITHUB_EVENT_NAME: 'workflow_run' }, { RUNNER_ENVIRONMENT: 'self-hosted' },
    { RUNNER_OS: 'Windows' }, { GITHUB_RUN_ATTEMPT: '2' },
    { GITHUB_WORKFLOW_REF: 'gonchiman/sf6/.github/workflows/sample-survey.yml@refs/heads/main' }]) {
    assert.equal(isAllowedProductionExecution({ ...environment(), ...patch }), false)
  }
})

test('child identity rejects other repositories, refs, workflow, revision, ID and reruns', () => {
  const expected = { runId: '123', sha: SHA }
  assert.equal(parseProductionRun(rawRun(), expected).id, '123')
  for (const patch of [{ repository: { full_name: 'other/sf6' } }, { head_repository: { full_name: 'other/sf6' } },
    { head_branch: 'feature' }, { event: 'pull_request' }, { path: '.github/workflows/parallel-fetch-test.yml' },
    { id: 124 }, { head_sha: FIRST_SHA }, { run_attempt: 2 }, { created_at: 'bad' }, { status: 'unknown' }]) {
    assert.throws(() => parseProductionRun({ ...rawRun(), ...patch }, expected))
  }
  for (const runId of ['0', '-1', '1e2', '../123', '123?token=private']) assert.throws(() => parseProductionRun(rawRun(), { ...expected, runId }))
})

test('fully processed plans retain near-boundary quality, missing positions and duplicates without replacement', () => {
  for (const stage of [1, 2, 3, 4, 5]) assert.deepEqual(validateProductionReport(report(stage), stage), report(stage))
  const value = report(), row = value.strata[0], obs = value.observation!.strata[0]
  value.frameChanged = true
  obs.status = 'review-required'; obs.boundaryChanged = true; obs.startAfter = null
  const accepted = validateProductionReport(value, 1)
  assert.equal(accepted.strata[0].selected, 200); assert.equal(accepted.strata[0].succeeded, 200)
  assert.equal(accepted.observation!.strata[0].status, 'review-required')
  row.succeeded -= 2; row.missing = 1; row.duplicates = 1; value.uniqueAccountCount -= 2
  const missing = validateProductionReport(value, 1)
  assert.equal(missing.strata[0].succeeded, 198); assert.equal(missing.strata[0].missing, 1); assert.equal(missing.strata[0].duplicates, 1)
})

test('aggregate validation rejects wrong config, unprocessed slots, invalid schema and private fields', () => {
  const variations: ((value: SampleSurveyRun) => void)[] = [
    value => { value.config.maxDurationMinutes = 10 }, value => { value.config.includeMr = true },
    value => { value.config.rankSampleSize = 10 }, value => { value.state = 'error'; value.stopReason = 'login-required' },
    value => { value.strata[0].processed-- }, value => { value.strata[0].succeeded-- },
    value => { value.resumeAllowed = true }, value => { Object.assign(value, { accountId: PRIVATE }) },
    value => { Object.assign(value.strata[0], { cookies: PRIVATE }) },
  ]
  for (const mutate of variations) { const value = report(); mutate(value); assert.throws(() => validateProductionReport(value, 1)) }
  assert.throws(() => validateProductionReport(report(2), 1))
  const unavailable = report(), row = unavailable.strata[0], observation = unavailable.observation!.strata[0]
  Object.assign(row, { population: null, selected: 0, processed: 0, succeeded: 0, mean: null, min: null, max: null })
  Object.assign(observation, { status: 'review-required', startBefore: null, endBefore: null, startAfter: null, endAfter: null })
  delete observation.boundaryAcceptance; unavailable.uniqueAccountCount = 200
  assert.throws(() => validateProductionReport(unavailable, 1))
})

test('dispatch correlation requires the returned exact API and HTML run URLs', () => {
  const value = { workflow_run_id: 123, run_url: 'https://api.github.com/repos/gonchiman/sf6/actions/runs/123',
    html_url: 'https://github.com/gonchiman/sf6/actions/runs/123' }
  assert.equal(parseProductionDispatch(value), '123')
  for (const input of [null, {}, { ...value, workflow_run_id: 0 }, { ...value, workflow_run_id: 124 },
    { ...value, run_url: value.run_url + '/logs' }, { ...value, html_url: value.html_url.replace('gonchiman', 'other') }]) {
    assert.throws(() => parseProductionDispatch(input))
  }
})

function mocked(answer: (args: string[]) => unknown | Buffer) {
  const calls: { args: string[]; limit: number }[] = []
  const command: CloudGhCommand = async (args, limit) => {
    calls.push({ args, limit }); const value = answer(args)
    return Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value))
  }
  return { github: createProductionGitHub(command), calls }
}
function archiveMock(stage = 1, change?: { entries?: [string, string][]; metadata?: Record<string, unknown>; history?: SampleSurveyRun; index?: unknown }) {
  const value = report(stage), entries = change?.entries ?? artifactEntries(value), bytes = zip(entries)
  const index = JSON.parse(artifactEntries(value)[0][1])
  return { value, bytes, ...mocked(args => {
    const path = args.find(arg => arg.startsWith('repos/'))!
    if (path.endsWith('/zip')) return bytes
    if (path.endsWith('/artifacts?per_page=100')) return { total_count: 1, artifacts: [{ id: 456,
      name: 'sample-survey-123-1', expired: false, size_in_bytes: bytes.length,
      digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`, workflow_run: { id: 123 }, ...change?.metadata }] }
    if (path.includes('/contents/')) return { encoding: 'base64', content: Buffer.from(JSON.stringify(path.includes('/index.json?')
      ? change?.index ?? index : change?.history ?? value)).toString('base64') }
    assert.fail('Unexpected command')
  }) }
}

test('GitHub adapter pins dispatch to main and bounded numeric plan inputs', async () => {
  const f = mocked(() => ({ workflow_run_id: 123, run_url: 'https://api.github.com/repos/gonchiman/sf6/actions/runs/123',
    html_url: 'https://github.com/gonchiman/sf6/actions/runs/123' }))
  assert.equal(await f.github.dispatch(2), '123')
  assert.equal(f.calls.length, 1)
  const args = f.calls[0].args
  for (const value of ['github.com', 'repos/gonchiman/sf6/actions/workflows/sample-survey.yml/dispatches', 'POST', 'ref=main',
    'return_run_details=true', 'inputs[ranks]=BRONZE,SILVER', 'inputs[rank_sample_size]=200', 'inputs[include_mr]=false',
    'inputs[mr_sample_size]=100', 'inputs[max_duration_minutes]=120']) assert.ok(args.includes(value))
  assert.ok(f.calls[0].limit <= 1024 * 1024)
  await assert.rejects(f.github.dispatch(6)); assert.equal(f.calls.length, 1)
})

test('GitHub adapter does not repeat ambiguous dispatches or expose command errors', async () => {
  let calls = 0
  const github = createProductionGitHub(async () => { calls++; throw new Error(PRIVATE) })
  await assert.rejects(github.dispatch(2), (error: Error) => !error.message.includes(PRIVATE))
  assert.equal(calls, 1)
  const f = mocked(() => Buffer.alloc(0))
  await assert.rejects(f.github.dispatch(2)); assert.equal(f.calls.length, 1)
})

test('GitHub adapter validates current main and rejects wrong child revision', async () => {
  const f = mocked(args => args.some(arg => arg.endsWith('/commits/main')) ? { sha: SHA } : rawRun())
  assert.equal(await f.github.mainSha(), SHA)
  assert.equal((await f.github.run('123', SHA)).id, '123')
  await assert.rejects(f.github.run('123', FIRST_SHA))
  const before = f.calls.length
  await assert.rejects(f.github.run('../secret', SHA)); assert.equal(f.calls.length, before)
})

test('a production result requires matching archive digest, aggregate schema and published history', async () => {
  for (const stage of [1, 5]) {
    const f = archiveMock(stage)
    assert.deepEqual(await f.github.report(parseProductionRun(rawRun(), { runId: '123', sha: SHA }), stage), f.value)
    assert.equal(f.calls.length, 4)
    assert.ok(f.calls.every(call => call.limit <= 1024 * 1024))
    assert.doesNotMatch(JSON.stringify(f.calls), /BUCKLER|cookie|storageState|session|synthetic-private/)
  }
})

for (const [label, metadata] of Object.entries({ expired: { expired: true }, renamed: { name: 'sample-survey-124-1' },
  otherRun: { workflow_run: { id: 124 } }, digest: { digest: `sha256:${'0'.repeat(64)}` }, huge: { size_in_bytes: 1048577 },
  empty: { size_in_bytes: 0 }, id: { id: '../456' } })) {
  test(`artifact metadata rejects ${label} without accepting another run`, async () => {
    const f = archiveMock(1, { metadata })
    await assert.rejects(f.github.report(parseProductionRun(rawRun(), { runId: '123', sha: SHA }), 1))
  })
}

test('artifact validation rejects missing or ambiguous listing before download', async () => {
  for (const listing of [{ total_count: 0, artifacts: [] }, { total_count: 2, artifacts: [] },
    { total_count: 1, artifacts: [{}, {}] }, { artifacts: [] }]) {
    const f = mocked(() => listing)
    await assert.rejects(f.github.report(parseProductionRun(rawRun(), { runId: '123', sha: SHA }), 1))
    assert.equal(f.calls.length, 1)
  }
})

test('a changed or unregistered published report cannot advance production', async () => {
  const different = report(); different.strata[0].mean = 1550
  for (const changes of [{ history: different }, { index: { schemaVersion: 1, generatedAt: END, source: SAMPLE_SURVEY_RESULTS_SOURCE, datasets: [] } }]) {
    const f = archiveMock(1, changes)
    await assert.rejects(f.github.report(parseProductionRun(rawRun(), { runId: '123', sha: SHA }), 1))
  }
  const old = rawRun(); old.created_at = '2026-10-31T03:00:01.000Z'
  const f = archiveMock()
  await assert.rejects(f.github.report(parseProductionRun(old, { runId: '123', sha: SHA }), 1))
})

test('archive validation accepts only the manifest, one bounded report and optional empty runs directory', () => {
  const entries = artifactEntries(), good = zip(entries)
  assert.equal(extractProductionArtifact(good).get('index.json')!.toString(), entries[0][1])
  assert.equal(extractProductionArtifact(zip([['runs/', ''], ...entries])).size, 3)
  for (const bad of [Buffer.alloc(0), Buffer.alloc(1048577), zip([['../outside.json', '{}'], entries[1]]),
    zip([entries[0], entries[0], entries[1]]), zip([...entries, ['secret.txt', PRIVATE]]),
    zip([entries[0], ['runs/' + 'x'.repeat(81) + '.json', '{}']]), zip([entries[0], ['runs/synthetic-result.json', ' '.repeat(262145)]]),
    zip([entries[0], ['runs/synthetic-result.json', '']]), zip([['runs/', PRIVATE], ...entries]),
    zip([entries[0], ['runs/a.json', '{}'], ['runs/b.json', '{}']])]) assert.throws(() => extractProductionArtifact(bad))
  const corrupt = Buffer.from(good); corrupt[42] ^= 1; assert.throws(() => extractProductionArtifact(corrupt))
})

function stageFixture(stage: number, overrides: Partial<ProductionGitHub> = {}) {
  let clock = Date.parse(END)
  const calls: string[] = [], waits: number[] = [], logs: unknown[] = []
  const github: ProductionGitHub = {
    mainSha: async () => { calls.push('main'); return SHA },
    dispatch: async value => { calls.push(`dispatch:${value}`); return '123' },
    run: async (runId, expectedSha) => { calls.push(`run:${runId}:${expectedSha}`); return parseProductionRun(rawRun(runId, expectedSha), { runId, sha: expectedSha }) },
    report: async () => { calls.push('report'); return report(stage) }, ...overrides,
  }
  return { calls, waits, logs, dependencies: { github, now: () => clock,
    sleep: async (ms: number) => { waits.push(ms); clock += ms }, log: (value: unknown) => { logs.push(value) } },
    advance: (ms: number) => { clock += ms } }
}

test('first stage adopts only its supplied run and does not dispatch again', async () => {
  const f = stageFixture(1)
  const result = await runProductionStage({ stage: 1, sha: SHA, firstRunId: '123', firstRunSha: FIRST_SHA }, f.dependencies)
  assert.equal(result.report.strata[0].succeeded, 200)
  assert.deepEqual(f.calls, [`run:123:${FIRST_SHA}`, 'report']); assert.deepEqual(f.waits, [])
  assert.doesNotMatch(JSON.stringify(f.logs), /synthetic-private|accountId|cookie|storageState/)
})

test('later stages dispatch once only after main matches the pinned parent revision', async () => {
  for (const stage of [2, 3, 4, 5]) {
    const f = stageFixture(stage)
    await runProductionStage({ stage, sha: SHA }, f.dependencies)
    assert.deepEqual(f.calls, ['main', `dispatch:${stage}`, `run:123:${SHA}`, 'report'])
  }
  const f = stageFixture(2, { mainSha: async () => FIRST_SHA })
  await assert.rejects(runProductionStage({ stage: 2, sha: SHA }, f.dependencies)); assert.deepEqual(f.calls, [])
})

test('invalid first-run options and stale or future runs stop before publication', async () => {
  for (const options of [{ stage: 1, sha: SHA }, { stage: 1, sha: SHA, firstRunId: '123', firstRunSha: 'bad' },
    { stage: 2, sha: SHA, firstRunId: '123', firstRunSha: FIRST_SHA }, { stage: 2, sha: 'bad' }]) {
    const f = stageFixture(options.stage)
    await assert.rejects(runProductionStage(options, f.dependencies)); assert.deepEqual(f.calls, [])
  }
  for (const time of ['2026-10-30T03:59:59.999Z', '2026-10-31T04:00:00.001Z']) {
    const f = stageFixture(1, { run: async () => ({ id: '123', attempt: 1, status: 'completed', conclusion: 'success', createdAt: time }) })
    await assert.rejects(runProductionStage({ stage: 1, sha: SHA, firstRunId: '123', firstRunSha: FIRST_SHA }, f.dependencies))
    assert.ok(!f.calls.includes('report'))
  }
})

test('queued and running statuses are polled once a minute before validating success', async () => {
  let poll = 0
  const f = stageFixture(2, { run: async () => ({ id: '123', attempt: 1, createdAt: START,
    status: poll === 0 ? 'queued' : poll === 1 ? 'in_progress' : 'completed', conclusion: poll++ < 2 ? null : 'success' }) })
  await runProductionStage({ stage: 2, sha: SHA }, f.dependencies)
  assert.equal(poll, 3); assert.deepEqual(f.waits, [60000, 60000])
  assert.equal(f.calls.filter(value => value.startsWith('dispatch')).length, 1)
  assert.equal(f.calls.filter(value => value === 'report').length, 1)
})

for (const conclusion of ['failure', 'cancelled', 'timed_out', 'action_required', 'stale', 'neutral', 'skipped']) {
  test(`child ${conclusion} stops without reading or accepting its artifact`, async () => {
    const f = stageFixture(2, { run: async () => ({ id: '123', attempt: 1, createdAt: START, status: 'completed', conclusion }) })
    await assert.rejects(runProductionStage({ stage: 2, sha: SHA }, f.dependencies))
    assert.deepEqual(f.calls, ['main', 'dispatch:2']); assert.deepEqual(f.waits, [])
  })
}

test('monitoring has finite per-stage time budgets and never redispatches stalled children', async () => {
  for (const stage of [2, 5]) {
    let polls = 0
    const f = stageFixture(stage, { run: async () => { polls++; return { id: '123', attempt: 1, createdAt: START, status: 'queued', conclusion: null } } })
    await assert.rejects(runProductionStage({ stage, sha: SHA }, f.dependencies))
    assert.equal(f.waits.length, productionStage(stage).waitMinutes)
    assert.ok(f.waits.every(ms => ms === 60000)); assert.equal(polls, productionStage(stage).waitMinutes + 1)
    assert.deepEqual(f.calls, ['main', `dispatch:${stage}`])
  }
})

test('dispatch, run or publication failures propagate without retrying or logging untrusted payloads', async () => {
  for (const method of ['dispatch', 'run', 'report'] as const) {
    let failures = 0
    const f = stageFixture(2, { [method]: async () => { failures++; throw new Error(PRIVATE) } })
    await assert.rejects(runProductionStage({ stage: 2, sha: SHA }, f.dependencies))
    assert.equal(failures, 1); assert.deepEqual(f.waits, [])
    assert.ok(!JSON.stringify(f.logs).includes(PRIVATE))
  }
})

test('a known population below the planned count and a wholly missing stratum stop continuation', () => {
  const small = report(), row = small.strata[0], observation = small.observation!.strata[0]
  Object.assign(row, { population: 190, selected: 190, processed: 190, succeeded: 190 }); small.uniqueAccountCount = 390
  observation.endBefore = 190; observation.endAfter = 190
  observation.boundaryAcceptance!.end = 190; observation.boundaryAcceptance!.referenceEnd = 190
  assert.throws(() => validateProductionReport(small, 1))
  const missing = report(), missingRow = missing.strata[0]
  Object.assign(missingRow, { succeeded: 0, missing: 200, mean: null, min: null, max: null })
  missing.uniqueAccountCount = 200; missing.frameChanged = true; missing.observation!.strata[0].status = 'review-required'
  assert.throws(() => validateProductionReport(missing, 1))
})

test('a reused first run, duplicate parent, parent rerun or incomplete listing cannot dispatch another chain', () => {
  const parent = { ...rawRun('456'), display_title: 'Sample survey production 123', path: '.github/workflows/sample-survey-production.yml' }
  const good = { total_count: 1, workflow_runs: [parent] }
  assert.doesNotThrow(() => validateProductionParents(good, '456', '123'))
  for (const value of [
    { total_count: 0, workflow_runs: [] }, { total_count: 2, workflow_runs: [parent] },
    { total_count: 2, workflow_runs: [parent, { ...parent, id: 789 }] },
    { total_count: 101, workflow_runs: [parent] }, { ...good, workflow_runs: [{ ...parent, run_attempt: 2 }] },
    { ...good, workflow_runs: [{ ...parent, id: 789 }] }, { ...good, workflow_runs: [{ ...parent, head_branch: 'feature' }] },
    { ...good, workflow_runs: [{ ...parent, event: 'push' }] },
    { ...good, workflow_runs: [{ ...parent, repository: { full_name: 'other/sf6' } }] },
    { ...good, workflow_runs: [{ ...parent, head_repository: { full_name: 'other/sf6' } }] },
  ]) assert.throws(() => validateProductionParents(value, '456', '123'))
  assert.throws(() => validateProductionParents(good, '456', '124'))
  assert.throws(() => validateProductionParents(good, '../456', '123'))
})

test('a slow status call finishing after the monitor deadline cannot publish as an on-time success', async () => {
  const f = stageFixture(2)
  f.dependencies.github.run = async () => {
    f.advance((productionStage(2).waitMinutes + 1) * 60000)
    return parseProductionRun(rawRun(), { runId: '123', sha: SHA })
  }
  await assert.rejects(runProductionStage({ stage: 2, sha: SHA }, f.dependencies))
  assert.ok(!f.calls.includes('report')); assert.deepEqual(f.waits, [])
})

test('workflow jobs wait in sequence and never hold the child collection lock or receive its session', async () => {
  const workflow = await readFile(new URL('../.github/workflows/sample-survey-production.yml', import.meta.url), 'utf8')
  const child = await readFile(new URL('../.github/workflows/sample-survey.yml', import.meta.url), 'utf8')
  assert.match(workflow, /workflow_dispatch:/); assert.doesNotMatch(workflow, /schedule:|workflow_run:/)
  assert.match(workflow, /actions: write/); assert.match(workflow, /contents: read/)
  assert.doesNotMatch(workflow, /secrets\.|BUCKLER_WEEKLY_SESSION|continue-on-error:|always\(\)/)
  const group = workflow.match(/^  group: (.+)$/m)![1]
  assert.notEqual(group, child.match(/^  group: (.+)$/m)![1])
  assert.match(workflow, /cancel-in-progress: false/)
  for (let stage = 1; stage <= 5; stage++) {
    const section = workflow.split(`  stage-${stage}:`)[1].split(/\n  stage-\d:/)[0]
    if (stage > 1) assert.match(section, new RegExp(`needs: stage-${stage - 1}`))
    assert.match(section, /github\.run_attempt == 1/)
    assert.match(section, /ref: \$\{\{ github.sha \}\}/); assert.match(section, /persist-credentials: false/)
    const jobMinutes = Number(section.match(/timeout-minutes: (\d+)/)![1])
    assert.ok(jobMinutes > productionStage(stage).waitMinutes && jobMinutes <= 360)
    assert.match(section, new RegExp(`PRODUCTION_STAGE: '${stage}'`))
    assert.match(section, /node --test scripts\/manage-sample-survey-production.test.ts/)
  }
})
