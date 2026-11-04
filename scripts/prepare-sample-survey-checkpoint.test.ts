import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { prepareSampleSurveyCheckpoint, SAMPLE_SURVEY_CHECKPOINT_INPUT } from './prepare-sample-survey-checkpoint.ts'
import { createSampleSurveyCheckpoint } from './lib/sample-survey-runner.ts'
import { encryptSampleSurveyCheckpoint, createSampleSurveyCheckpointManifest } from './lib/sample-survey-cloud-checkpoint.ts'
import type { CloudGhCommand } from './lib/parallel-fetch-github.ts'

const SHA = 'a'.repeat(40), START = '2026-11-02T01:00:00.000Z', END = '2026-11-02T01:20:00.000Z'
function env() {
  return { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Windows', GITHUB_REPOSITORY: 'gonchiman/sf6',
    GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_WORKFLOW_REF: 'gonchiman/sf6/.github/workflows/sample-survey.yml@refs/heads/main',
    GITHUB_SHA: SHA, SAMPLE_SURVEY_SOURCE_SHA: SHA, GITHUB_RUN_ID: '999', GITHUB_RUN_ATTEMPT: '1', SAMPLE_SURVEY_RESUME_RUN_ID: '123' }
}
function archive(files: [string, Buffer][]) {
  const local: Buffer[] = [], central: Buffer[] = []; let offset = 0
  for (const [name, bytes] of files) {
    const filename = Buffer.from(name); let crc = 0xffffffff
    for (const byte of bytes) { crc ^= byte; for (let i = 0; i < 8; i++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0) }
    crc = (crc ^ 0xffffffff) >>> 0
    const a = Buffer.alloc(30), b = Buffer.alloc(46)
    a.writeUInt32LE(0x04034b50); a.writeUInt32LE(crc, 14); a.writeUInt32LE(bytes.length, 18); a.writeUInt32LE(bytes.length, 22); a.writeUInt16LE(filename.length, 26)
    b.writeUInt32LE(0x02014b50); b.writeUInt32LE(crc, 16); b.writeUInt32LE(bytes.length, 20); b.writeUInt32LE(bytes.length, 24); b.writeUInt16LE(filename.length, 28); b.writeUInt32LE(offset, 42)
    local.push(a, filename, bytes); central.push(b, filename); offset += 30 + filename.length + bytes.length
  }
  const c = Buffer.concat(central), end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(c.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, c, end])
}
function fixture(resumeDepth = 0, resumable = true, authenticationStop = false) {
  const config = { ranks: ['MASTER' as const], rankSampleSize: 10, includeMr: false, mrSampleSize: 10, maxDurationMinutes: 10 }
  const cp = createSampleSurveyCheckpoint({ schemaVersion: 1, id: 'plan', createdAt: START, config, seed: '1'.repeat(64) }, Date.parse(START))
  Object.assign(cp.report, { state: 'error', stopReason: resumable ? 'server-error' : 'human-verification', resumeAllowed: resumable,
    updatedAt: END, finishedAt: END, elapsedMs: 1200000 })
  if (resumable) cp.transientFailure = { httpStatus: 502, at: END }
  if (authenticationStop) { cp.report.stopReason = 'authentication-unconfirmed'; cp.report.resumeAllowed = false; delete cp.transientFailure }
  const encrypted = encryptSampleSurveyCheckpoint(cp, { sourceSha: SHA, runId: '123', runAttempt: 1, resumeDepth }, Buffer.alloc(32, 7).toString('base64'))
  const manifest = createSampleSurveyCheckpointManifest(encrypted), bytes = archive([
    ['manifest.json', Buffer.from(JSON.stringify(manifest))], ['checkpoint.enc.json', encrypted],
  ])
  const calls: string[][] = []
  const command: CloudGhCommand = async args => {
    calls.push(args); const path = args.find(value => value.startsWith('repos/'))!
    if (path.endsWith('/zip')) return bytes
    const value = path.endsWith('/artifacts?per_page=100') ? { total_count: 1, artifacts: [{ id: 456, name: 'sample-survey-checkpoint-123-1',
      expired: false, size_in_bytes: bytes.length, digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`, workflow_run: { id: 123 } }] }
      : { id: 123, run_attempt: 1, event: 'workflow_dispatch', head_branch: 'main', path: '.github/workflows/sample-survey.yml', head_sha: SHA,
        display_title: `Sample survey source ${SHA}`, repository: { full_name: 'gonchiman/sf6' }, head_repository: { full_name: 'gonchiman/sf6' },
        status: 'completed', conclusion: 'failure', created_at: START }
    return Buffer.from(JSON.stringify(value))
  }
  return { command, calls, manifest, encrypted }
}

test('a fresh collection never downloads a checkpoint', async () => {
  const value = await prepareSampleSurveyCheckpoint({ env: { ...env(), SAMPLE_SURVEY_RESUME_RUN_ID: '' }, command: async () => { assert.fail('no network') } })
  assert.equal(value, null)
})

test('only an explicit manual request can restore an authentication-unconfirmed LP checkpoint across source revisions', async () => {
  const f = fixture(0, false, true), current = 'b'.repeat(40)
  const manual = { ...env(), GITHUB_SHA: current, SAMPLE_SURVEY_SOURCE_SHA: current,
    SAMPLE_SURVEY_RECOVER_AUTHENTICATION: 'true', SAMPLE_SURVEY_RESUME_SOURCE_SHA: SHA }
  let writes = 0
  const result = await prepareSampleSurveyCheckpoint({ env: manual, command: f.command, now: () => Date.parse(END) + 600000,
    write: async (_path, files) => { writes++; assert.deepEqual(files.get('checkpoint.enc.json'), f.encrypted) } })
  assert.equal(result?.sourceSha, SHA); assert.equal(result?.stopReason, 'authentication-unconfirmed'); assert.equal(writes, 1)
  for (const [environment, fixtureValue] of [[env(), f], [manual, fixture(0, false)],
    [{ ...manual, SAMPLE_SURVEY_RESUME_SOURCE_SHA: current }, f], [{ ...manual, SAMPLE_SURVEY_RECOVER_AUTHENTICATION: 'false' }, f]] as const) {
    await assert.rejects(prepareSampleSurveyCheckpoint({ env: environment, command: fixtureValue.command,
      metadataWait: async () => {}, now: () => Date.parse(END) + 600000, write: async () => assert.fail('not eligible') }))
  }
})
test('restoration verifies the exact failed run and encrypted artifact before writing only fixed filenames', async () => {
  const f = fixture(); let writes = 0
  const result = await prepareSampleSurveyCheckpoint({ env: env(), command: f.command, now: () => Date.parse(END) + 600000,
    write: async (path, files) => {
      writes++; assert.equal(path, SAMPLE_SURVEY_CHECKPOINT_INPUT)
      assert.deepEqual([...files.keys()].sort(), ['checkpoint.enc.json', 'manifest.json'])
      assert.deepEqual(files.get('checkpoint.enc.json'), f.encrypted)
      assert.doesNotMatch(files.get('checkpoint.enc.json')!.toString(), /"seed"|"accountId"|"slots"/)
    } })
  assert.deepEqual(result, f.manifest); assert.equal(writes, 1); assert.equal(f.calls.length, 3)
  assert.ok(f.calls.every(args => !args.includes('POST')))
})
test('foreign environments, reruns, malformed IDs and self-resume fail before any download', async () => {
  for (const patch of [{ GITHUB_REF: 'refs/heads/feature' }, { GITHUB_RUN_ATTEMPT: '2' }, { SAMPLE_SURVEY_RESUME_RUN_ID: '../123' },
    { SAMPLE_SURVEY_RESUME_RUN_ID: '999' }, { SAMPLE_SURVEY_SOURCE_SHA: 'main' }]) {
    await assert.rejects(prepareSampleSurveyCheckpoint({ env: { ...env(), ...patch }, command: async () => { assert.fail('no network') } }))
  }
})
test('stale, future, nonresumable and depth-exhausted inputs never reach disk', async () => {
  for (const [depth, resumable, time] of [[6, true, Date.parse(END)], [0, false, Date.parse(END)],
    [0, true, Date.parse(START) + 72 * 3600000 + 1], [0, true, Date.parse(START)]] as const) {
    const f = fixture(depth, resumable)
    await assert.rejects(prepareSampleSurveyCheckpoint({ env: env(), command: f.command, now: () => time, write: async () => { assert.fail('no write') } }))
  }
})
test('download and write failures do not expose response bytes or secret-bearing exception messages', async () => {
  const f = fixture(), secret = 'private-marker-never-log'
  for (const patch of [{ command: async () => { throw new Error(secret) } }, { write: async () => { throw new Error(secret) } }]) {
    await assert.rejects(prepareSampleSurveyCheckpoint({ env: env(), command: f.command, now: () => Date.parse(END), metadataWait: async () => {}, ...patch }),
      error => error instanceof Error && !error.message.includes(secret))
  }
})
