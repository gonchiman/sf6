import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { isAllowedSampleSurveyCloudExecution, parseSampleSurveyCloudConfig, runSampleSurveyCloud, SAMPLE_SURVEY_CLOUD_OUTPUT, SampleSurveyCloudError } from './collect-sample-survey-cloud.ts'
import { publishSampleSurveyCloud, SAMPLE_SURVEY_CLOUD_HISTORY, SAMPLE_SURVEY_CLOUD_INCOMING } from './publish-sample-survey-cloud.ts'
import { createSampleSurveyCheckpoint, runSampleSurvey } from './lib/sample-survey-runner.ts'
import type { SampleSurveyPlan } from '../src/types/sampleSurvey.ts'
import { SampleSurveyReadError, SampleSurveyRetryableReadError } from './lib/sample-survey-reader.ts'

const PRIVATE = 'synthetic-private-cookie-do-not-publish'
const now = new Date('2026-10-27T00:00:00.000Z')
const session = JSON.stringify({ schemaVersion: 1, capturedAt: '2026-10-15T01:00:00.000Z', uploadedAt: '2026-10-15T01:01:00.000Z',
  storageState: { cookies: [{ name: 'session', value: PRIVATE, domain: '.streetfighter.com', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' }], origins: [] } })
function environment(): Record<string, string | undefined> {
  return { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Windows', GITHUB_REPOSITORY: 'gonchiman/sf6',
    GITHUB_REF: 'refs/heads/main', GITHUB_WORKFLOW_REF: 'gonchiman/sf6/.github/workflows/sample-survey.yml@refs/heads/main',
    GITHUB_EVENT_NAME: 'workflow_dispatch', BUCKLER_WEEKLY_SESSION: session, GH_TOKEN: 'private-github-token', PATH: 'test-path' }
}
function completed(plan: SampleSurveyPlan) {
  const checkpoint = createSampleSurveyCheckpoint(plan, now.getTime())
  Object.assign(checkpoint.report, { schemaVersion: 1, state: 'complete', phase: 'complete', finishedAt: now.toISOString(), attempts: 3, successfulPages: 3, uniqueAccountCount: 10 })
  delete checkpoint.report.observation
  Object.assign(checkpoint.report.strata[0], { population: 20, selected: 10, processed: 10, succeeded: 10, mean: 30000, min: 30000, max: 30000 })
  return checkpoint
}
function intervalCompleted(plan: SampleSurveyPlan, review = false) {
  const checkpoint = completed(plan), report = checkpoint.report
  report.schemaVersion = 2
  report.observation = { method: 'rank-position-interval-v1', omittedChanges: 0,
    strata: [{ id: 'lp-MASTER', status: review ? 'review-required' : 'checked', startedAt: now.toISOString(), finishedAt: now.toISOString(),
      totalCountBefore: 20, totalCountAfter: 21, startBefore: 0, endBefore: 20, startAfter: 0, endAfter: 20, boundaryChanged: false }],
    changes: [{ kind: 'total-count', target: 'lp', stratumId: 'lp-MASTER', at: now.toISOString(), before: 20, after: 21 }] }
  if (review) {
    report.frameChanged = true; report.uniqueAccountCount = 8
    Object.assign(report.strata[0], { succeeded: 8, missing: 1, duplicates: 1 })
    report.observation.changes.push(
      { kind: 'row-outside-stratum', target: 'lp', stratumId: 'lp-MASTER', at: now.toISOString(), before: 0, after: 1 },
      { kind: 'duplicate', target: 'lp', stratumId: 'lp-MASTER', at: now.toISOString(), before: 0, after: 1 })
  }
  return checkpoint
}
test('cloud entry is restricted to hosted Windows manual main workflow and consumes the secret before guards', async () => {
  for (const patch of [{ RUNNER_OS: 'Linux' }, { RUNNER_ENVIRONMENT: 'self-hosted' }, { GITHUB_REF: 'refs/heads/other' },
    { GITHUB_EVENT_NAME: 'schedule' }, { GITHUB_EVENT_NAME: 'pull_request' }, { GITHUB_REPOSITORY: 'other/sf6' },
    { GITHUB_WORKFLOW_REF: 'gonchiman/sf6/.github/workflows/parallel-fetch-test.yml@refs/heads/main' }]) {
    const env = { ...environment(), ...patch }
    assert.equal(isAllowedSampleSurveyCloudExecution(env), false)
    await assert.rejects(runSampleSurveyCloud({ env, createReader: async () => { throw new Error('must not launch') } }),
      (error: unknown) => error instanceof SampleSurveyCloudError && error.code === 'runner' && !error.message.includes(PRIVATE))
    assert.equal(env.BUCKLER_WEEKLY_SESSION, undefined)
  }
})
test('cloud inputs reuse rank/sample validation and cap wall time without accepting shell-like text', () => {
  assert.deepEqual(parseSampleSurveyCloudConfig({}), { ranks: ['MASTER'], rankSampleSize: 10, includeMr: false, mrSampleSize: 10, maxDurationMinutes: 10 })
  assert.deepEqual(parseSampleSurveyCloudConfig({ SAMPLE_SURVEY_RANKS: 'MASTER,GOLD', SAMPLE_SURVEY_INCLUDE_MR: 'true' }).ranks, ['GOLD', 'MASTER'])
  assert.deepEqual(parseSampleSurveyCloudConfig({ SAMPLE_SURVEY_RANKS: '', SAMPLE_SURVEY_INCLUDE_MR: 'true' }).ranks, [])
  for (const patch of [{ SAMPLE_SURVEY_RANKS: 'MASTER,MASTER' }, { SAMPLE_SURVEY_RANKS: '' }, { SAMPLE_SURVEY_RANKS: '$(secret)' },
    { SAMPLE_SURVEY_RANK_SAMPLE_SIZE: '11' }, { SAMPLE_SURVEY_RANK_SAMPLE_SIZE: '1e2' }, { SAMPLE_SURVEY_INCLUDE_MR: 'True' },
    { SAMPLE_SURVEY_MAX_DURATION_MINUTES: '121' }, { SAMPLE_SURVEY_MAX_DURATION_MINUTES: '0' }]) {
    assert.throws(() => parseSampleSurveyCloudConfig(patch), SampleSurveyCloudError)
  }
})
test('real synthetic collection uses the existing serial runner, closes reader and publishes only aggregates', async () => {
  let clock = now.getTime(), closed = false, artifact = false
  const env = environment(), requests: number[] = [], written: unknown[] = [], logs: unknown[] = [], failures: string[] = []
  const rows = Array.from({ length: 20 }, (_, index) => ({ accountId: String(987650000 + index), value: 30020 - index, rankId: 36 }))
  const result = await runSampleSurveyCloud({ env, now: () => new Date(clock), createReader: async (options, dependencies) => {
    assert.equal(options.signal.aborted, false)
    assert.equal(env.BUCKLER_WEEKLY_SESSION, undefined)
    assert.equal((await dependencies!.browser!.loadSession!()).cookies[0].value, PRIVATE)
    return { async readPage(target, page) { requests.push(clock); return { target, page, pageSize: 20, totalCount: 20, totalPages: 1,
      observedAt: new Date(clock).toISOString(), entries: rows } }, async close() { closed = true } }
  }, collect: (plan, options) => runSampleSurvey(plan, { ...options, wait: async ms => { clock += ms } }),
  write: async (runs, path) => { assert.equal(closed, true); assert.equal(path, SAMPLE_SURVEY_CLOUD_OUTPUT); written.push(...runs); return { datasets: 1 } },
  validate: async path => { assert.equal(path, SAMPLE_SURVEY_CLOUD_OUTPUT); return { datasets: 1 } },
  artifactReady: async () => { artifact = true }, logReport: report => logs.push(report), logFailureDiagnostic: line => { failures.push(line) } })
  assert.equal(result.succeeded, true); assert.equal(result.report.strata[0].succeeded, 10)
  assert.equal(closed, true); assert.equal(artifact, true); assert.equal(written.length, 1)
  assert.deepEqual(failures, [])
  for (let i = 1; i < requests.length; i++) assert.ok(requests[i] - requests[i - 1] >= 10000)
  const text = JSON.stringify({ result, written, logs })
  for (const secret of [PRIVATE, 'accountId', 'cookies', 'slots', 'private-github-token', ...rows.map(row => row.accountId)]) assert.equal(text.includes(secret), false)
})

function failureDiagnostic() {
  return { schemaVersion: 1 as const, capturedAt: now.toISOString(), innerCode: 'authentication-unconfirmed', httpStatus: 200,
    failureKind: 'other' as const, capture: 'not-started' as const, events: [], droppedEvents: 0,
    diagnostics: { authenticationEvidence: 'login-control' as const, loginRequiredHeading: false, rankingReadable: false,
      cookie: PRIVATE }, rawHtml: PRIVATE, message: PRIVATE, accountId: PRIVATE }
}

test('cloud reports a bounded retry separately and can publish an actual runner recovery', async () => {
  for (const sinkThrows of [false, true]) {
    let clock = now.getTime(), requests = 0, closed = false, marked = false
    const retryLogs: string[] = [], failures: string[] = []
    const result = await runSampleSurveyCloud({ env: environment(), now: () => new Date(clock),
      createReader: async () => ({ readPage: async (target, page) => {
        requests++
        if (requests === 2) throw new SampleSurveyRetryableReadError('authentication-unconfirmed', 502)
        assert.equal(target, 'lp'); assert.equal(page, 1)
        return { target, page, pageSize: 20, totalCount: 20, totalPages: 1, observedAt: new Date(clock).toISOString(),
          entries: Array.from({ length: 20 }, (_, i) => ({ accountId: String(100000 + i), value: 30000, rankId: 36 })) }
      }, close: async () => { closed = true } }),
      collect: (plan, options) => runSampleSurvey(plan, { ...options, wait: async ms => { clock += ms } }),
      write: async () => ({ datasets: 1 }), validate: async () => ({ datasets: 1 }), artifactReady: async () => { marked = true },
      logReport: () => {}, logFailureDiagnostic: line => { failures.push(line) },
      logReadRetry: line => { retryLogs.push(line); if (sinkThrows) throw new Error(PRIVATE) },
    })
    assert.equal(result.succeeded, true); assert.equal(result.report.strata[0].succeeded, 10)
    assert.equal(result.report.attempts, requests); assert.equal(result.report.successfulPages, requests - 1)
    assert.ok(closed && marked); assert.deepEqual(failures, []); assert.equal(retryLogs.length, 1)
    const event = JSON.parse(retryLogs[0]).sampleSurveyReadRetry
    assert.equal(event.attempt, 2); assert.equal(event.page, 1); assert.equal(event.delayMs, 30000)
    assert.equal(event.httpStatus, 502); assert.equal(event.code, 'authentication-unconfirmed')
    assert.doesNotMatch(JSON.stringify({ retryLogs, report: result.report }), /100000|accountId|cookie|synthetic-private|private-github-token/)
  }
})

test('retry logging keeps the later terminal diagnostic and ignores invalid or duplicate retry events', async () => {
  const retryLines: string[] = [], failures: string[] = []
  const result = await runSampleSurveyCloud({ env: environment(), now: () => now,
    createReader: async options => ({ readPage: async () => {
      await options.onReadFailure!({ ...failureDiagnostic(), httpStatus: 403, innerCode: 'http-denied' })
      throw new SampleSurveyReadError('http-denied')
    }, close: async () => {} }),
    collect: async (plan, options) => {
      const event = { at: now.toISOString(), target: 'lp', page: 1, attempt: 1, retryNumber: 1,
        code: 'server-error', httpStatus: 502, delayMs: 30000 }
      options.onReadRetry!({ ...event, code: PRIVATE } as never)
      options.onReadRetry!({ ...event, cookie: PRIVATE } as never)
      options.onReadRetry!(event as never)
      return runSampleSurvey(plan, options)
    }, logReport: () => {}, logReadRetry: line => { retryLines.push(line) }, logFailureDiagnostic: line => { failures.push(line) },
  })
  assert.equal(result.succeeded, false); assert.equal(result.report.stopReason, 'http-denied')
  assert.equal(retryLines.length, 1); assert.equal(failures.length, 1)
  assert.equal(JSON.parse(failures[0]).sampleSurveyFailureDiagnostic.httpStatus, 403)
  assert.ok(!JSON.stringify({ retryLines, failures }).includes(PRIVATE))
})

test('cloud records only the first safe failure diagnostic and retains the collection stop reason', async () => {
  const lines: string[] = []
  let closed = false, reads = 0
  const result = await runSampleSurveyCloud({ env: environment(), now: () => now,
    createReader: async options => ({
      readPage: async () => {
        reads++
        await options.onReadFailure!(failureDiagnostic())
        await options.onReadFailure!({ ...failureDiagnostic(), httpStatus: 503 })
        throw new SampleSurveyReadError('authentication-unconfirmed')
      }, close: async () => { closed = true },
    }), logReport: () => {}, logFailureDiagnostic: line => { lines.push(line) },
    write: async () => { assert.fail('failed collection must not publish') },
    artifactReady: async () => { assert.fail('failed collection must not upload') },
  })
  assert.equal(result.succeeded, false); assert.equal(result.report.stopReason, 'authentication-unconfirmed')
  assert.equal(reads, 1); assert.equal(closed, true); assert.equal(lines.length, 1)
  const diagnostic = JSON.parse(lines[0]).sampleSurveyFailureDiagnostic
  assert.equal(diagnostic.httpStatus, 200)
  assert.deepEqual(diagnostic.diagnostics, { authenticationEvidence: 'login-control', loginRequiredHeading: false, rankingReadable: false })
  assert.ok(!lines[0].includes(PRIVATE)); assert.ok(!JSON.stringify(result.report).includes('diagnostics'))
})

test('malformed diagnostics and failing log sinks never replace the original stop reason', async () => {
  for (const kind of ['null', 'getter', 'throwing-log', 'rejecting-log']) {
    let logCalls = 0, reads = 0
    const result = await runSampleSurveyCloud({ env: environment(), now: () => now,
      createReader: async options => ({
        readPage: async () => {
          reads++
          const value = kind === 'null' ? null : kind === 'getter' ? { get schemaVersion() { throw new Error(PRIVATE) } } : failureDiagnostic()
          await options.onReadFailure!(value as never)
          await options.onReadFailure!(failureDiagnostic())
          throw new SampleSurveyReadError('authentication-unconfirmed')
        }, close: async () => {},
      }), logReport: () => {}, logFailureDiagnostic: () => {
        logCalls++
        if (kind === 'rejecting-log') return Promise.reject(new Error(PRIVATE))
        throw new Error(PRIVATE)
      },
    })
    assert.equal(result.succeeded, false); assert.equal(result.report.stopReason, 'authentication-unconfirmed')
    assert.equal(reads, 1); assert.equal(logCalls, kind === 'null' || kind === 'getter' ? 0 : 1)
    assert.ok(!JSON.stringify(result).includes(PRIVATE))
  }
})
test('legacy partial, frame-changed, missing and duplicate results fail without writing or authorizing uploads', async () => {
  for (const failure of ['partial', 'changed', 'missing', 'duplicates']) {
    let closed = false, writes = 0
    const result = await runSampleSurveyCloud({ env: environment(), now: () => now,
      createReader: async () => ({ readPage: async () => { throw new Error('unused') }, close: async () => { closed = true } }),
      collect: async plan => {
        const value = completed(plan)
        if (failure === 'partial') Object.assign(value.report, { state: 'stopped', stopReason: 'limit-reached' })
        if (failure === 'changed') value.report.frameChanged = true
        if (failure === 'missing' || failure === 'duplicates') {
          Object.assign(value.report.strata[0], { succeeded: 9, [failure]: 1 }); value.report.uniqueAccountCount = 9
        }
        return value
      }, write: async () => { writes++; throw new Error('must not write') }, artifactReady: async () => { throw new Error('must not upload') }, logReport: () => {} })
    assert.equal(result.succeeded, false); assert.equal(writes, 0); assert.equal(closed, true)
  }
})

test('completed interval quality evidence reaches the artifact unchanged without private state', async () => {
  for (const review of [false, true]) {
    let closed = false, marked = false
    const written: unknown[] = [], logs: unknown[] = []
    const result = await runSampleSurveyCloud({ env: environment(), now: () => now,
      createReader: async () => ({ readPage: async () => { throw new Error('unused') }, close: async () => { closed = true } }),
      collect: async plan => intervalCompleted(plan, review),
      write: async runs => { assert.equal(closed, true); written.push(...runs); return { datasets: 1 } },
      validate: async () => ({ datasets: 1 }), artifactReady: async () => { marked = true }, logReport: report => logs.push(report) })
    assert.equal(result.succeeded, true); assert.equal(marked, true)
    assert.deepEqual(written, [result.report]); assert.deepEqual(logs, written)
    assert.equal(result.report.observation!.strata[0].status, review ? 'review-required' : 'checked')
    assert.equal(result.report.strata[0].succeeded, review ? 8 : 10)
    assert.equal(result.report.observation!.changes[0].kind, 'total-count')
    for (const secret of [PRIVATE, 'accountId', 'cookies', 'slots', 'private-github-token']) assert.equal(JSON.stringify(written).includes(secret), false)
  }
})

test('unestablished frames and incomplete interval collections never authorize public artifacts', async () => {
  for (const kind of ['unestablished', 'stopped', 'authentication-error']) {
    let writes = 0, marked = false
    const result = await runSampleSurveyCloud({ env: environment(), now: () => now,
      createReader: async () => ({ readPage: async () => { throw new Error('unused') }, close: async () => {} }),
      collect: async plan => {
        const value = intervalCompleted(plan, true), report = value.report
        if (kind === 'unestablished') {
          report.uniqueAccountCount = 0
          Object.assign(report.strata[0], { population: null, selected: 0, processed: 0, succeeded: 0, missing: 0, duplicates: 0, mean: null, min: null, max: null })
          Object.assign(report.observation!.strata[0], { totalCountBefore: null, totalCountAfter: null, startBefore: null, endBefore: null, startAfter: null, endAfter: null })
          report.observation!.changes = []
        } else Object.assign(report, { state: kind === 'stopped' ? 'stopped' : 'error', phase: 'sampling', stopReason: kind === 'stopped' ? 'limit-reached' : 'login-required' })
        return value
      }, write: async () => { writes++; return { datasets: 1 } }, validate: async () => ({ datasets: 1 }),
      artifactReady: async () => { marked = true }, logReport: () => {} })
    assert.equal(result.succeeded, false); assert.equal(writes, 0); assert.equal(marked, false)
  }
})
test('invalid session and raw failures produce fixed errors and never mark artifact-ready', async () => {
  let marked = false, closed = false
  for (const kind of ['session', 'collection', 'output']) {
    const env = environment()
    if (kind === 'session') env.BUCKLER_WEEKLY_SESSION = PRIVATE
    await assert.rejects(runSampleSurveyCloud({ env, now: () => now,
      createReader: async () => ({ readPage: async () => { throw new Error(PRIVATE) }, close: async () => { closed = true } }),
      collect: async plan => { if (kind === 'collection') throw new Error(PRIVATE); return completed(plan) },
      write: async () => { throw new Error(PRIVATE) }, artifactReady: async () => { marked = true }, logReport: () => {} }),
    (error: unknown) => error instanceof SampleSurveyCloudError && error.code === kind && !error.message.includes(PRIVATE))
    assert.equal(env.BUCKLER_WEEKLY_SESSION, undefined)
  }
  assert.equal(closed, true); assert.equal(marked, false)
})
test('publisher fixes both aggregate paths and applies the workflow environment guard', async () => {
  let called = false
  await publishSampleSurveyCloud({ env: environment(), publish: async (input, output) => {
    called = true; assert.equal(input, SAMPLE_SURVEY_CLOUD_INCOMING); assert.equal(output, SAMPLE_SURVEY_CLOUD_HISTORY); return { datasets: 1 }
  } })
  assert.equal(called, true)
  await assert.rejects(publishSampleSurveyCloud({ env: {}, publish: async () => { throw new Error('must not publish') } }), SampleSurveyCloudError)
})
test('workflow keeps secrets out of publishing and uploads no private state; collection remains headed and serial', async () => {
  const workflow = await readFile(new URL('../.github/workflows/sample-survey.yml', import.meta.url), 'utf8')
  const [collect, publish] = workflow.split('  save-history:')
  assert.match(workflow, /workflow_dispatch:/); assert.doesNotMatch(workflow, /schedule:|cron:/)
  assert.match(workflow, /group: rank-distribution-weekly-gonchiman-sf6/)
  assert.match(collect, /contents: read/); assert.doesNotMatch(collect, /contents: write/)
  assert.match(collect, /secrets\.BUCKLER_WEEKLY_SESSION/); assert.doesNotMatch(publish, /BUCKLER_WEEKLY_SESSION/)
  assert.match(collect, /sample-survey\/runs\/\*\.json/); assert.doesNotMatch(collect, /checkpoint|sqlite|private-session|\.html/)
  assert.match(publish, /git add -- public\/data\/sample-survey/); assert.doesNotMatch(publish, /--force/)
  const code = await readFile(new URL('./collect-sample-survey-cloud.ts', import.meta.url), 'utf8')
  assert.match(code, /headless: false/); assert.doesNotMatch(code, /createSampleSurveyStore|sample-survey-store/)
})
