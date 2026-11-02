import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { link, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { SampleSurveyPlan } from '../../src/types/sampleSurvey.ts'
import { createSampleSurveyCheckpoint, parseSampleSurveyCheckpoint } from './sample-survey-runner.ts'
import { createSampleSurveyCheckpointManifest, decryptSampleSurveyCheckpoint, encryptSampleSurveyCheckpoint,
  finalizeSampleSurveyCloudCheckpoint, loadSampleSurveyCloudCheckpoint, loadSampleSurveyCloudCheckpointBundle,
  parseSampleSurveyCheckpointManifest, SAMPLE_SURVEY_CHECKPOINT_ENVELOPE_LIMIT, SampleSurveyCloudCheckpointError,
  saveSampleSurveyCloudCheckpoint } from './sample-survey-cloud-checkpoint.ts'

const key = randomBytes(32).toString('base64')
const owner = { sourceSha: 'a'.repeat(40), runId: '41269981687', runAttempt: 1 as const, resumeDepth: 0 }
const at = '2026-11-02T00:00:00.000Z'
const config = { ranks: ['MASTER' as const], rankSampleSize: 10, includeMr: false, mrSampleSize: 10, maxDurationMinutes: 120 }
const expected = { ...owner, config }
const privateId = '9876543210123456789'
function fixture() {
  const plan: SampleSurveyPlan = { schemaVersion: 1, id: 'plan-test', seed: 'deafbeef'.repeat(8), createdAt: at, config }
  const cp = createSampleSurveyCheckpoint(plan, Date.parse(at))
  cp.frames.push({ target: 'lp', totalCount: 20, pageSize: 20, totalPages: 1, checkedAt: at,
    ranges: [{ stratumId: 'lp-MASTER', start: 0, end: 20 }] })
  cp.slots = Array.from({ length: 10 }, (_, i) => ({ id: `lp-MASTER:${i}`, target: 'lp', stratumId: 'lp-MASTER', position: i,
    page: 1, rowIndex: i, status: i < 3 ? 'collected' : 'pending', accountId: i < 3 ? i === 0 ? privateId : `900000000000000000${i}` : null,
    value: i < 3 ? 30000 + i : null, rankId: i < 3 ? 36 : null, observedAt: i < 3 ? at : null, reason: null }))
  Object.assign(cp.report, { state: 'stopped', phase: 'sampling', finishedAt: at, stopReason: 'cancelled', resumeAllowed: true,
    attempts: 3, successfulPages: 3, uniqueAccountCount: 3 })
  Object.assign(cp.report.strata[0], { population: 20, selected: 10, processed: 3, succeeded: 3, mean: 30001, min: 30000, max: 30002 })
  Object.assign(cp.report.observation!.strata[0], { status: 'collecting', startedAt: at, totalCountBefore: 20, startBefore: 0, endBefore: 20,
    boundaryAcceptance: { mode: 'exact', referenceStart: 0, referenceEnd: 20, referenceCheckedAt: at,
      start: 0, end: 20, startObservedAt: at, endObservedAt: at } })
  return parseSampleSurveyCheckpoint(cp)
}
async function directory(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'sample-survey-encrypted-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}
const rejected = (error: unknown): boolean => error instanceof SampleSurveyCloudCheckpointError
  && error.message === '標本調査の暗号化された途中記録を確認・保存できません。'

test('round-trip preserves the selected positions and observations without exposing them in the artifact', () => {
  const cp = fixture(), bytes = encryptSampleSurveyCheckpoint(cp, owner, key)
  assert.deepEqual(decryptSampleSurveyCheckpoint(bytes, key, expected), cp)
  const text = bytes.toString('utf8')
  for (const privateValue of [privateId, cp.plan.seed, 'accountId', 'rowIndex', 'slots', 'cookies']) assert.equal(text.includes(privateValue), false)
  assert.equal(key.length, 44)
  assert.equal(text.includes(key), false)
})

test('every update uses a fresh nonce and all metadata is authenticated', () => {
  const cp = fixture(), a = encryptSampleSurveyCheckpoint(cp, owner, key), b = encryptSampleSurveyCheckpoint(cp, owner, key)
  assert.notDeepEqual(a, b)
  const raw = JSON.parse(a.toString())
  assert.notEqual(raw.iv, JSON.parse(b.toString()).iv)
  for (const [field, value] of Object.entries({ sourceSha: 'b'.repeat(40), runId: '12', resumeDepth: 1, reportId: 'other', planId: 'other',
    startedAt: '2026-11-01T00:00:00.000Z', checkpointAt: '2026-11-03T00:00:00.000Z', state: 'error', stopReason: 'server-error', resumeAllowed: false, processed: 2 })) {
    const edited = { ...raw, [field]: value }
    assert.throws(() => decryptSampleSurveyCheckpoint(Buffer.from(JSON.stringify(edited)), key, {
      ...expected, ...(field === 'sourceSha' ? { sourceSha: value as string } : {}), ...(field === 'runId' ? { runId: value as string } : {}),
      ...(field === 'resumeDepth' ? { resumeDepth: value as number } : {}),
    }), rejected, field)
  }
})

test('ciphertext, tag, nonce or a different secret cannot be substituted', () => {
  const bytes = encryptSampleSurveyCheckpoint(fixture(), owner, key), raw = JSON.parse(bytes.toString())
  assert.throws(() => decryptSampleSurveyCheckpoint(bytes, randomBytes(32).toString('base64'), expected), rejected)
  for (const field of ['ciphertext', 'tag', 'iv']) {
    const changed = Buffer.from(raw[field], 'base64'); changed[0] ^= 1
    assert.throws(() => decryptSampleSurveyCheckpoint(Buffer.from(JSON.stringify({ ...raw, [field]: changed.toString('base64') })), key, expected), rejected)
  }
})

test('a checkpoint cannot resume under another config, source, parent run or depth', () => {
  const cp = fixture(), bytes = encryptSampleSurveyCheckpoint(cp, owner, key)
  for (const patch of [{ config: { ...config, rankSampleSize: 20 } }, { sourceSha: 'b'.repeat(40) }, { runId: '22' }, { runAttempt: 2 }, { resumeDepth: 1 }]) {
    assert.throws(() => decryptSampleSurveyCheckpoint(bytes, key, { ...expected, ...patch } as typeof expected), rejected)
  }
  const { resumeDepth: _, ...withoutDepth } = expected
  assert.deepEqual(decryptSampleSurveyCheckpoint(bytes, key, withoutDepth), cp)
})

test('only canonical 256-bit base64 keys and bounded strict envelopes are accepted', () => {
  const cp = fixture(), bytes = encryptSampleSurveyCheckpoint(cp, owner, key), raw = JSON.parse(bytes.toString())
  for (const secret of ['', key.trimEnd() + '\n', key.slice(0, -1), randomBytes(31).toString('base64'), randomBytes(33).toString('base64'), 'private-secret']) {
    assert.throws(() => encryptSampleSurveyCheckpoint(cp, owner, secret), rejected)
    assert.throws(() => decryptSampleSurveyCheckpoint(bytes, secret, expected), rejected)
  }
  for (const patch of [{ other: 'private-cookie' }, { schemaVersion: 2 }, { algorithm: 'none' }, { ciphertext: '' }, { iv: raw.iv.slice(0, -1) }, { runAttempt: 2 }, { resumeDepth: 7 }]) {
    assert.throws(() => decryptSampleSurveyCheckpoint(Buffer.from(JSON.stringify({ ...raw, ...patch })), key, expected), rejected)
  }
  assert.throws(() => decryptSampleSurveyCheckpoint(Buffer.alloc(SAMPLE_SURVEY_CHECKPOINT_ENVELOPE_LIMIT + 1), key, expected), rejected)
  assert.throws(() => decryptSampleSurveyCheckpoint(Buffer.from('{broken-private-text'), key, expected), rejected)
  assert.throws(() => encryptSampleSurveyCheckpoint(cp, { ...owner, runId: '../escape' }, key), rejected)
})

test('unknown private caller properties are reconstructed away before encryption', () => {
  const cp = fixture(), extra = { ...cp, cookies: [{ value: 'cookie-secret' }], token: 'token-secret' }
  const roundTrip = decryptSampleSurveyCheckpoint(encryptSampleSurveyCheckpoint(extra, owner, key), key, expected)
  assert.deepEqual(roundTrip, cp)
  assert.equal(JSON.stringify(roundTrip).includes('cookie-secret'), false)
})

test('public manifest is a deterministic summary and digest of exactly the encrypted file', () => {
  const cp = fixture(), bytes = encryptSampleSurveyCheckpoint(cp, owner, key), manifest = createSampleSurveyCheckpointManifest(bytes)
  assert.deepEqual(parseSampleSurveyCheckpointManifest(manifest), manifest)
  assert.equal(manifest.sha256, createHash('sha256').update(bytes).digest('hex'))
  assert.equal(manifest.bytes, bytes.length); assert.equal(manifest.processed, 3)
  assert.equal(manifest.planId, cp.plan.id); assert.equal(manifest.reportId, cp.report.id)
  assert.equal(manifest.startedAt, at); assert.equal(manifest.checkpointAt, at)
  const text = JSON.stringify(manifest)
  for (const value of [privateId, cp.plan.seed, 'ciphertext', 'cookies', 'accountId']) assert.equal(text.includes(value), false)
  for (const patch of [{ accountId: privateId }, { bytes: 0 }, { sha256: 'f' }, { processed: -1 }, { state: 'invented' }, { stopReason: 'invented' }]) {
    assert.throws(() => parseSampleSurveyCheckpointManifest({ ...manifest, ...patch }), rejected)
  }
})

test('atomic ciphertext saving and keyless metadata finalization can load in a new invocation', async t => {
  const root = await directory(t), file = join(root, 'nested', 'checkpoint.enc.json'), manifestPath = join(root, 'nested', 'manifest.json'), cp = fixture()
  const first = await saveSampleSurveyCloudCheckpoint(cp, owner, key, file)
  const loaded = await loadSampleSurveyCloudCheckpointBundle(file, key, expected)
  assert.deepEqual(loaded.checkpoint, cp); assert.deepEqual(loaded.manifest, first)
  assert.deepEqual(await loadSampleSurveyCloudCheckpoint(file, key, expected), cp)
  assert.deepEqual(await finalizeSampleSurveyCloudCheckpoint(file, manifestPath), first)
  assert.deepEqual(JSON.parse(await readFile(manifestPath, 'utf8')), first)
  const second = await saveSampleSurveyCloudCheckpoint(cp, { ...owner, resumeDepth: 1 }, key, file)
  assert.notEqual(second.sha256, first.sha256)
  await finalizeSampleSurveyCloudCheckpoint(file, manifestPath)
  assert.equal(JSON.parse(await readFile(manifestPath, 'utf8')).sha256, second.sha256)
  assert.deepEqual((await readdir(join(root, 'nested'))).sort(), ['checkpoint.enc.json', 'manifest.json'])
  await assert.rejects(loadSampleSurveyCloudCheckpoint(file, key, expected), rejected)
  assert.deepEqual(await loadSampleSurveyCloudCheckpoint(file, key, { ...expected, resumeDepth: 1 }), cp)
})

test('invalid updates retain the last usable ciphertext and expose only a fixed error', async t => {
  const root = await directory(t), file = join(root, 'checkpoint.enc.json'), cp = fixture()
  await saveSampleSurveyCloudCheckpoint(cp, owner, key, file)
  const before = await readFile(file)
  await assert.rejects(saveSampleSurveyCloudCheckpoint({ ...cp, slots: [] }, owner, key, file), rejected)
  assert.deepEqual(await readFile(file), before)
  await assert.rejects(finalizeSampleSurveyCloudCheckpoint(file, file), rejected)
  assert.deepEqual(await loadSampleSurveyCloudCheckpoint(file, key, expected), cp)
})

test('private path checks reject public directories, git data and directory destinations', async t => {
  const root = await directory(t), cp = fixture()
  for (const file of [join(root, 'public', 'x.json'), join(root, '.git', 'x.json'), root]) {
    await assert.rejects(saveSampleSurveyCloudCheckpoint(cp, owner, key, file), rejected)
    await assert.rejects(loadSampleSurveyCloudCheckpoint(file, key, expected), rejected)
  }
})

test('ancestor junctions and hard-linked destinations are rejected before use', async t => {
  const root = await directory(t), real = join(root, 'real'), alias = join(root, 'alias'), cp = fixture()
  await mkdir(real); await symlink(real, alias, process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(saveSampleSurveyCloudCheckpoint(cp, owner, key, join(alias, 'checkpoint.enc.json')), rejected)
  const original = join(real, 'original.json'), other = join(real, 'linked.json')
  await saveSampleSurveyCloudCheckpoint(cp, owner, key, original)
  await link(original, other)
  const before = await readFile(original)
  await assert.rejects(loadSampleSurveyCloudCheckpoint(other, key, expected), rejected)
  await assert.rejects(saveSampleSurveyCloudCheckpoint(cp, owner, key, other), rejected)
  assert.deepEqual(await readFile(original), before)
})

test('truncated on-disk data cannot replace a valid resume record', async t => {
  const root = await directory(t), file = join(root, 'checkpoint.enc.json')
  await writeFile(file, '{"private":"incomplete"}')
  await assert.rejects(loadSampleSurveyCloudCheckpoint(file, key, expected), rejected)
  await assert.rejects(finalizeSampleSurveyCloudCheckpoint(file, join(root, 'manifest.json')), rejected)
})
