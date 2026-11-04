import assert from 'node:assert/strict'
import test from 'node:test'
import { chromium } from 'playwright'
import { runSampleSurveyCloud, SampleSurveyCloudError } from './collect-sample-survey-cloud.ts'
import { createSampleSurveyCheckpoint, parseSampleSurveyCheckpoint, runSampleSurvey } from './lib/sample-survey-runner.ts'
import type { SampleSurveyCheckpoint } from './lib/sample-survey-runner.ts'
import { SampleSurveyReadError, SampleSurveyRetryableReadError } from './lib/sample-survey-reader.ts'
import { createSampleSurveyCheckpointManifest, decryptSampleSurveyCheckpoint, encryptSampleSurveyCheckpoint } from './lib/sample-survey-cloud-checkpoint.ts'
import type { SampleSurveyCheckpointContext } from './lib/sample-survey-cloud-checkpoint.ts'
import type { SampleSurveyPlan, SampleSurveyRun } from '../src/types/sampleSurvey.ts'
import { parseSampleSurveyRun } from '../src/lib/sampleSurvey.ts'

const EPOCH = Date.parse('2026-11-02T00:00:00.000Z'), SOURCE = 'a'.repeat(40), KEY = Buffer.alloc(32, 53).toString('base64')
const COOKIE = 'synthetic-buckler-session-private-value', TOKEN = 'synthetic-github-private-token'
const SESSION = JSON.stringify({ schemaVersion: 1, capturedAt: new Date(EPOCH - 60_000).toISOString(), uploadedAt: new Date(EPOCH - 30_000).toISOString(),
  storageState: { cookies: [{ name: 'session', value: COOKIE, domain: '.streetfighter.com', path: '/', expires: -1,
    httpOnly: true, secure: true, sameSite: 'Lax' }], origins: [] } })
const CONFIG = { ranks: ['MASTER'] as const, rankSampleSize: 200, includeMr: false, mrSampleSize: 100, maxDurationMinutes: 120 }
function env(runId = '10001', resumeRunId = ''): Record<string, string | undefined> {
  return { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Windows', GITHUB_REPOSITORY: 'gonchiman/sf6',
    GITHUB_REF: 'refs/heads/main', GITHUB_WORKFLOW_REF: 'gonchiman/sf6/.github/workflows/sample-survey.yml@refs/heads/main',
    GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_SHA: SOURCE, SAMPLE_SURVEY_SOURCE_SHA: SOURCE, GITHUB_RUN_ID: runId, GITHUB_RUN_ATTEMPT: '1',
    SAMPLE_SURVEY_RANKS: 'MASTER', SAMPLE_SURVEY_RANK_SAMPLE_SIZE: '200', SAMPLE_SURVEY_MR_SAMPLE_SIZE: '100', SAMPLE_SURVEY_INCLUDE_MR: 'false',
    SAMPLE_SURVEY_MAX_DURATION_MINUTES: '120', SAMPLE_SURVEY_RESUME_RUN_ID: resumeRunId, SAMPLE_SURVEY_CHECKPOINT_KEY: KEY,
    BUCKLER_WEEKLY_SESSION: SESSION, GH_TOKEN: TOKEN, PATH: process.env.PATH }
}
function stoppedCheckpoint(): SampleSurveyCheckpoint {
  const plan: SampleSurveyPlan = { schemaVersion: 1, id: 'integration-plan', seed: 'f'.repeat(32), createdAt: new Date(EPOCH).toISOString(),
    config: { ...CONFIG, ranks: [...CONFIG.ranks] } }
  const value = createSampleSurveyCheckpoint(plan, EPOCH), stoppedAt = new Date(EPOCH + 60_000).toISOString()
  Object.assign(value.report, { state: 'error', updatedAt: stoppedAt, finishedAt: stoppedAt, elapsedMs: 60_000,
    attempts: 4, successfulPages: 0, stopReason: 'server-error', resumeAllowed: true })
  value.transientFailure = { httpStatus: 502, at: stoppedAt }
  return parseSampleSurveyCheckpoint(value)
}
const OWNER: SampleSurveyCheckpointContext = { sourceSha: SOURCE, runId: '10001', runAttempt: 1, resumeDepth: 0 }

test('separate cloud invocations decrypt a fixed production sample and process only its remaining slots', async () => {
  let clock = EPOCH, sampled = 0, sampling = false, faults = 0, launchCount = 0, closeCount = 0
  const ciphertexts = new Map<string, Buffer>(), checkpoints = new Map<string, SampleSurveyCheckpoint>()
  const contexts: SampleSurveyCheckpointContext[] = [], writes: SampleSurveyRun[] = [], reports: SampleSurveyRun[] = [], retryLogs: string[] = []
  const browserEnvironments: Record<string, string | undefined>[] = []
  const rows = Array.from({ length: 2000 }, (_, i) => ({ accountId: String(8765400000 + i), value: 50000 - i, rankId: 36 }))
  const originalLaunch = chromium.launch
  chromium.launch = async options => {
    browserEnvironments.push(options?.env ?? {})
    return {} as never
  }
  const acquire = async (runId: string, previous = '') => {
    const environment = env(runId, previous)
    return runSampleSurveyCloud({ env: environment, now: () => new Date(clock),
      createReader: async (_options, dependencies) => {
        launchCount++
        assert.equal(environment.SAMPLE_SURVEY_CHECKPOINT_KEY, undefined)
        assert.equal(environment.BUCKLER_WEEKLY_SESSION, undefined)
        assert.equal((await dependencies!.browser!.loadSession!()).cookies[0].value, COOKIE)
        await dependencies!.browser!.launch!()
        return { async readPage(target, page) {
          if (!previous && sampling && faults < 4 && sampled >= [20, 45, 70, 92][faults]) {
            faults++; throw new SampleSurveyRetryableReadError('server-error', 502)
          }
          clock += 100
          return { target, page, pageSize: 20, totalCount: rows.length, totalPages: Math.ceil(rows.length / 20),
            observedAt: new Date(clock).toISOString(), entries: rows.slice((page - 1) * 20, page * 20).map(row => ({ ...row })) }
        }, async close() { closeCount++ } }
      },
      collect: (plan, options) => runSampleSurvey(plan, { ...options, wait: async ms => { clock += ms } }),
      saveCheckpoint: async (checkpoint, owner, secret) => {
        sampled = checkpoint.report.uniqueAccountCount; sampling = checkpoint.report.phase === 'sampling'
        const encoded = encryptSampleSurveyCheckpoint(checkpoint, owner, secret)
        ciphertexts.set(owner.runId, encoded); checkpoints.set(owner.runId, structuredClone(checkpoint)); contexts.push(owner)
        return createSampleSurveyCheckpointManifest(encoded)
      },
      loadCheckpoint: async (_path, secret, expected) => {
        const encoded = ciphertexts.get(expected.runId)!
        return { checkpoint: decryptSampleSurveyCheckpoint(encoded, secret, expected), manifest: createSampleSurveyCheckpointManifest(encoded) }
      },
      write: async values => { writes.push(...values.map(parseSampleSurveyRun)); return { datasets: values.length } }, validate: async () => ({ datasets: 1 }),
      artifactReady: async () => {}, logReport: report => { reports.push(report) }, logReadRetry: line => { retryLogs.push(line) },
    })
  }
  try {
    const first = await acquire('10001'), saved = structuredClone(checkpoints.get('10001')!)
    assert.equal(first.succeeded, false); assert.equal(first.report.stopReason, 'server-error'); assert.equal(faults, 4)
    assert.equal(first.report.resumeAllowed, true); assert.ok(first.report.strata[0].processed >= 92 && first.report.strata[0].processed < 200)
    assert.equal(writes.length, 0); assert.equal(retryLogs.length, 3)
    const encryptedFirst = ciphertexts.get('10001')!
    const savedSlots = structuredClone(saved.slots)
    clock += 5 * 60_000
    const second = await acquire('10002', '10001'), final = checkpoints.get('10002')!
    assert.equal(second.succeeded, true); assert.equal(second.report.id, first.report.id); assert.equal(second.report.planId, first.report.planId)
    assert.equal(second.report.strata[0].processed, 200); assert.equal(second.report.strata[0].succeeded, 200)
    assert.equal(second.report.strata[0].duplicates, 0)
    assert.deepEqual(final.plan, saved.plan); assert.deepEqual(final.slots.map(slot => slot.id), savedSlots.map(slot => slot.id))
    for (const prior of savedSlots.filter(slot => slot.status !== 'pending')) assert.deepEqual(final.slots.find(slot => slot.id === prior.id), prior)
    assert.equal(createSampleSurveyCheckpointManifest(encryptedFirst).resumeDepth, 0)
    assert.equal(createSampleSurveyCheckpointManifest(ciphertexts.get('10002')!).resumeDepth, 1)
    assert.equal(writes.length, 1); assert.equal(launchCount, 2); assert.equal(closeCount, 2)
    const safeOutput = JSON.stringify({ writes, reports, retryLogs, browserEnvironments, contexts })
    const encryptedOutput = [...ciphertexts.values()].map(bytes => bytes.toString('utf8')).join('\n')
    for (const sensitive of [KEY, COOKIE, TOKEN, 'accountId', 'cookies', 'storageState', 'slots', ...savedSlots.map(slot => slot.accountId).filter(Boolean) as string[]]) {
      assert.equal(safeOutput.includes(sensitive), false, sensitive)
      assert.equal(encryptedOutput.includes(sensitive), false, sensitive)
    }
    for (const environment of browserEnvironments) {
      assert.equal(environment.SAMPLE_SURVEY_CHECKPOINT_KEY, undefined)
      assert.equal(environment.BUCKLER_WEEKLY_SESSION, undefined)
      assert.equal(environment.GH_TOKEN, undefined)
    }
  } finally { chromium.launch = originalLaunch }
})

test('cloud continuation rejects invalid checkpoint provenance and eligibility before starting a browser', async () => {
  for (const scenario of ['corrupt', 'wrong-config', 'expired', 'depth-limit', 'cooldown', 'wrong-source', 'auth-stop'] as const) {
    const checkpoint = stoppedCheckpoint(), environment = env('10002', '10001')
    const owner = { ...OWNER, resumeDepth: scenario === 'depth-limit' ? 6 : 0 }
    if (scenario === 'wrong-config') environment.SAMPLE_SURVEY_RANK_SAMPLE_SIZE = '100'
    if (scenario === 'wrong-source') environment.SAMPLE_SURVEY_SOURCE_SHA = 'b'.repeat(40)
    if (scenario === 'auth-stop') {
      checkpoint.report.stopReason = 'login-required'; checkpoint.report.resumeAllowed = false
      delete checkpoint.transientFailure
    }
    let bytes = encryptSampleSurveyCheckpoint(checkpoint, owner, KEY)
    if (scenario === 'corrupt') {
      const encoded = JSON.parse(bytes.toString('utf8'))
      encoded.ciphertext = (encoded.ciphertext[0] === 'A' ? 'B' : 'A') + encoded.ciphertext.slice(1)
      bytes = Buffer.from(JSON.stringify(encoded))
    }
    const time = scenario === 'expired' ? EPOCH + 72 * 60 * 60_000 + 1
      : Date.parse(checkpoint.report.updatedAt) + 5 * 60_000 - (scenario === 'cooldown' ? 1 : 0)
    let reads = 0, saves = 0
    await assert.rejects(runSampleSurveyCloud({ env: environment, now: () => new Date(time),
      loadCheckpoint: async (_path, secret, expected) => ({ checkpoint: decryptSampleSurveyCheckpoint(bytes, secret, expected),
        manifest: createSampleSurveyCheckpointManifest(bytes) }),
      createReader: async () => { reads++; throw new Error('unexpected browser launch') },
      saveCheckpoint: async () => { saves++ }, logReport: () => {},
    }), (error: unknown) => error instanceof SampleSurveyCloudError && error.code === 'collection', scenario)
    assert.equal(reads, 0, scenario); assert.equal(saves, 0, scenario)
    assert.equal(environment.SAMPLE_SURVEY_CHECKPOINT_KEY, undefined); assert.equal(environment.BUCKLER_WEEKLY_SESSION, undefined)
  }
})

test('an actual authentication stop is encrypted for diagnosis but cannot be automatically resumed', async () => {
  let bytes: Buffer | undefined, launches = 0
  const checkpointing = async (checkpoint: SampleSurveyCheckpoint, context: SampleSurveyCheckpointContext, key: string) => {
    bytes = encryptSampleSurveyCheckpoint(checkpoint, context, key)
  }
  const first = await runSampleSurveyCloud({ env: env(), now: () => new Date(EPOCH),
    createReader: async () => ({ async readPage() { throw new SampleSurveyReadError('human-verification') }, async close() {} }),
    saveCheckpoint: checkpointing, logReport: () => {},
  })
  assert.equal(first.succeeded, false); assert.equal(first.report.stopReason, 'human-verification'); assert.equal(first.report.resumeAllowed, false)
  assert.equal(createSampleSurveyCheckpointManifest(bytes!).resumeAllowed, false)
  await assert.rejects(runSampleSurveyCloud({ env: env('10002', '10001'), now: () => new Date(EPOCH + 5 * 60_000),
    loadCheckpoint: async (_path, secret, expected) => ({ checkpoint: decryptSampleSurveyCheckpoint(bytes!, secret, expected),
      manifest: createSampleSurveyCheckpointManifest(bytes!) }),
    createReader: async () => { launches++; throw new Error('unexpected browser launch') }, saveCheckpoint: checkpointing,
  }), SampleSurveyCloudError)
  assert.equal(launches, 0)
})

test('manual auth recovery preserves encrypted observations across a code update and requires a new successful read', async () => {
  let clock = EPOCH, sampled = 0, stopAfterSample = true, saved: SampleSurveyCheckpoint | undefined, bytes: Buffer | undefined
  const rows = Array.from({ length: 2000 }, (_, i) => ({ accountId: String(7654300000 + i), value: 50000 - i, rankId: 36 }))
  const createReader = async () => ({ async readPage(target: 'lp' | 'mr', page: number) {
    if (stopAfterSample && sampled >= 40) throw new SampleSurveyReadError('authentication-unconfirmed')
    clock += 100
    return { target, page, pageSize: 20, totalCount: rows.length, totalPages: 100, observedAt: new Date(clock).toISOString(),
      entries: rows.slice((page - 1) * 20, page * 20).map(row => ({ ...row })) }
  }, async close() {} })
  const first = await runSampleSurveyCloud({ env: env(), now: () => new Date(clock), createReader,
    collect: (plan, options) => runSampleSurvey(plan, { ...options, wait: async ms => { clock += ms } }),
    saveCheckpoint: async (cp, owner, key) => { saved = structuredClone(cp); sampled = cp.report.uniqueAccountCount; bytes = encryptSampleSurveyCheckpoint(cp, owner, key) },
    logReport: () => {},
  })
  assert.equal(first.succeeded, false); assert.equal(first.report.stopReason, 'authentication-unconfirmed')
  assert.ok(sampled >= 40); assert.equal(first.report.resumeAllowed, false)
  const old = structuredClone(saved!), oldBytes = Buffer.from(bytes!), newSource = 'b'.repeat(40)
  const manualEnv = () => ({ ...env('10002', '10001'), GITHUB_SHA: newSource, SAMPLE_SURVEY_SOURCE_SHA: newSource,
    SAMPLE_SURVEY_RECOVER_AUTHENTICATION: 'true', SAMPLE_SURVEY_RESUME_SOURCE_SHA: SOURCE })
  const loadCheckpoint: NonNullable<Parameters<typeof runSampleSurveyCloud>[0]>['loadCheckpoint'] = async (_path, key, expected) => {
    assert.equal(expected.sourceSha, SOURCE)
    return { checkpoint: decryptSampleSurveyCheckpoint(oldBytes, key, expected), manifest: createSampleSurveyCheckpointManifest(oldBytes) }
  }
  clock += 5 * 60_000
  let deniedReads = 0
  await assert.rejects(runSampleSurveyCloud({ env: manualEnv(), now: () => new Date(clock), loadCheckpoint,
    createReader: async () => ({ async readPage() { deniedReads++; throw new SampleSurveyReadError('authentication-unconfirmed') }, async close() {} }),
    saveCheckpoint: async () => assert.fail('must preserve old checkpoint before positive authentication'),
    write: async () => assert.fail('cannot publish a failed authentication check'),
  }), SampleSurveyCloudError)
  assert.equal(deniedReads, 1); assert.deepEqual(bytes, oldBytes)
  stopAfterSample = false
  let verifiedRead = false, final: SampleSurveyCheckpoint | undefined
  const second = await runSampleSurveyCloud({ env: manualEnv(), now: () => new Date(clock), loadCheckpoint,
    createReader: async () => {
      const reader = await createReader()
      return { ...reader, async readPage(target, page) { const result = await reader.readPage(target, page); verifiedRead = true; return result } }
    },
    collect: (plan, options) => runSampleSurvey(plan, { ...options, wait: async ms => { clock += ms } }),
    saveCheckpoint: async (cp, owner, key) => {
      assert.equal(verifiedRead, true); assert.equal(owner.sourceSha, newSource); assert.equal(owner.resumeDepth, 1)
      final = decryptSampleSurveyCheckpoint(encryptSampleSurveyCheckpoint(cp, owner, key), key, { ...owner, config: cp.plan.config })
    },
    write: async () => ({ datasets: 1 }), validate: async () => ({ datasets: 1 }), artifactReady: async () => {}, logReport: () => {},
  })
  assert.equal(second.succeeded, true); assert.equal(second.report.strata[0].succeeded, 200)
  assert.equal(second.report.id, first.report.id); assert.deepEqual(final!.plan, old.plan)
  assert.deepEqual(final!.slots.map(slot => slot.id), old.slots.map(slot => slot.id))
  for (const slot of old.slots.filter(slot => slot.status !== 'pending')) assert.deepEqual(final!.slots.find(row => row.id === slot.id), slot)
})
