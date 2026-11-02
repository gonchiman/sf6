import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto'
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { parseSampleSurveyConfig } from '../../src/lib/sampleSurvey.ts'
import type { SampleSurveyConfig, SampleSurveyError, SampleSurveyRun } from '../../src/types/sampleSurvey.ts'
import { parseSampleSurveyCheckpoint } from './sample-survey-runner.ts'
import type { SampleSurveyCheckpoint } from './sample-survey-runner.ts'

export const SAMPLE_SURVEY_CHECKPOINT_KEY_SECRET = 'SAMPLE_SURVEY_CHECKPOINT_KEY'
export const SAMPLE_SURVEY_CHECKPOINT_PLAINTEXT_LIMIT = 16 * 1024 * 1024
export const SAMPLE_SURVEY_CHECKPOINT_ENVELOPE_LIMIT = 24 * 1024 * 1024
const DOMAIN = 'gonchiman/sf6/sample-survey-checkpoint/v1'
export interface SampleSurveyCheckpointContext { sourceSha: string; runId: string; runAttempt: 1; resumeDepth: number }
export interface SampleSurveyCheckpointExpected extends Omit<SampleSurveyCheckpointContext, 'resumeDepth'> { config: SampleSurveyConfig; resumeDepth?: number }
export interface SampleSurveyCheckpointManifest extends SampleSurveyCheckpointContext {
  schemaVersion: 1; config: SampleSurveyConfig; reportId: string; planId: string; startedAt: string; checkpointAt: string
  state: SampleSurveyRun['state']; stopReason: SampleSurveyError | null; resumeAllowed: boolean; processed: number
  bytes: number; sha256: string
}
type Header = Omit<SampleSurveyCheckpointManifest, 'bytes' | 'sha256'> & { algorithm: 'aes-256-gcm' }
const HEADER_KEYS = ['schemaVersion', 'algorithm', 'sourceSha', 'runId', 'runAttempt', 'resumeDepth', 'config', 'reportId', 'planId', 'startedAt', 'checkpointAt', 'state', 'stopReason', 'resumeAllowed', 'processed']
const ERRORS: SampleSurveyError[] = ['cancelled', 'limit-reached', 'human-verification', 'http-denied', 'login-required', 'authentication-unconfirmed', 'maintenance', 'server-error', 'http-error', 'timeout', 'read-failed', 'condition-mismatch', 'page-mismatch', 'frame-changed', 'session-unavailable', 'browser-unavailable', 'storage-error', 'interrupted', 'invalid-request']
export class SampleSurveyCloudCheckpointError extends Error {
  constructor() { super('標本調査の暗号化された途中記録を確認・保存できません。'); this.name = 'SampleSurveyCloudCheckpointError' }
}
const fail = (): never => { throw new SampleSurveyCloudCheckpointError() }
function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key))) return fail()
  return value as Record<string, unknown>
}
function context(value: unknown): SampleSurveyCheckpointContext {
  const input = record(value, ['sourceSha', 'runId', 'runAttempt', 'resumeDepth'])
  if (typeof input.sourceSha !== 'string' || !/^[a-f0-9]{40}$/.test(input.sourceSha)
    || typeof input.runId !== 'string' || !/^[1-9]\d{0,14}$/.test(input.runId) || input.runAttempt !== 1
    || !Number.isInteger(input.resumeDepth) || Number(input.resumeDepth) < 0 || Number(input.resumeDepth) > 6) return fail()
  return { sourceSha: input.sourceSha, runId: input.runId, runAttempt: 1, resumeDepth: Number(input.resumeDepth) }
}
function base64(value: unknown, exactLength?: number, maximum = SAMPLE_SURVEY_CHECKPOINT_PLAINTEXT_LIMIT): Buffer {
  if (typeof value !== 'string' || value.length === 0 || value.length > Math.ceil(maximum / 3) * 4
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return fail()
  const bytes = Buffer.from(value, 'base64')
  if (bytes.toString('base64') !== value || bytes.length > maximum || exactLength !== undefined && bytes.length !== exactLength) return fail()
  return bytes
}
/** Reconstruct only the supported record. Cookies and unknown caller fields never enter the encrypted payload. */
function checkpoint(value: unknown): SampleSurveyCheckpoint {
  const parsed = parseSampleSurveyCheckpoint(value)
  if (parsed.schemaVersion !== 2 || parsed.report.schemaVersion !== 2) return fail()
  return parsed
}
function parseHeader(value: unknown): Header {
  const input = record(value, HEADER_KEYS)
  if (input.schemaVersion !== 1 || input.algorithm !== 'aes-256-gcm' || typeof input.reportId !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(input.reportId)
    || typeof input.planId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(input.planId)
    || typeof input.checkpointAt !== 'string' || !Number.isFinite(Date.parse(input.checkpointAt))
    || new Date(input.checkpointAt).toISOString() !== input.checkpointAt
    || typeof input.startedAt !== 'string' || !Number.isFinite(Date.parse(input.startedAt))
    || new Date(input.startedAt).toISOString() !== input.startedAt || input.startedAt > input.checkpointAt
    || !['preparing', 'running', 'complete', 'stopped', 'error'].includes(String(input.state))
    || input.stopReason !== null && !ERRORS.includes(input.stopReason as SampleSurveyError)
    || typeof input.resumeAllowed !== 'boolean' || !Number.isSafeInteger(input.processed) || Number(input.processed) < 0 || Number(input.processed) > 14_000) return fail()
  return { schemaVersion: 1, algorithm: 'aes-256-gcm',
    ...context({ sourceSha: input.sourceSha, runId: input.runId, runAttempt: input.runAttempt, resumeDepth: input.resumeDepth }),
    config: parseSampleSurveyConfig(input.config), reportId: input.reportId, planId: input.planId,
    startedAt: input.startedAt, checkpointAt: input.checkpointAt, state: input.state as SampleSurveyRun['state'],
    stopReason: input.stopReason as SampleSurveyError | null, resumeAllowed: input.resumeAllowed, processed: Number(input.processed) }
}
function aad(header: Header): Buffer { return Buffer.from(`${DOMAIN}\n${JSON.stringify(header)}`, 'utf8') }
function headerFor(parsed: SampleSurveyCheckpoint, owner: SampleSurveyCheckpointContext): Header {
  return parseHeader({ schemaVersion: 1, algorithm: 'aes-256-gcm', ...context(owner), config: parsed.plan.config,
    reportId: parsed.report.id, planId: parsed.plan.id, startedAt: parsed.report.startedAt, checkpointAt: parsed.report.updatedAt,
    state: parsed.report.state, stopReason: parsed.report.stopReason, resumeAllowed: parsed.report.resumeAllowed,
    processed: parsed.report.strata.reduce((sum, row) => sum + row.processed, 0) })
}
function parseEnvelope(bytes: Uint8Array): { header: Header; iv: Buffer; tag: Buffer; ciphertext: Buffer } {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > SAMPLE_SURVEY_CHECKPOINT_ENVELOPE_LIMIT) return fail()
  const input = record(JSON.parse(Buffer.from(bytes).toString('utf8')), [...HEADER_KEYS, 'iv', 'tag', 'ciphertext'])
  const { iv, tag, ciphertext, ...rest } = input
  return { header: parseHeader(rest), iv: base64(iv, 12, 12), tag: base64(tag, 16, 16), ciphertext: base64(ciphertext) }
}

/** Public metadata contains only the acquisition identity and aggregate progress; never a seed, position or account ID. */
export function parseSampleSurveyCheckpointManifest(value: unknown): SampleSurveyCheckpointManifest {
  try {
    const input = record(value, [...HEADER_KEYS.filter(key => key !== 'algorithm'), 'bytes', 'sha256'])
    const { bytes, sha256, ...rest } = input
    const { algorithm: _, ...header } = parseHeader({ ...rest, algorithm: 'aes-256-gcm' })
    if (!Number.isSafeInteger(bytes) || Number(bytes) < 1 || Number(bytes) > SAMPLE_SURVEY_CHECKPOINT_ENVELOPE_LIMIT
      || typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256)) return fail()
    return { ...header, bytes: Number(bytes), sha256 }
  } catch { return fail() }
}
export function createSampleSurveyCheckpointManifest(bytes: Uint8Array): SampleSurveyCheckpointManifest {
  try {
    const { algorithm: _, ...header } = parseEnvelope(bytes).header
    return parseSampleSurveyCheckpointManifest({ ...header, bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') })
  } catch { return fail() }
}

export function encryptSampleSurveyCheckpoint(value: unknown, owner: SampleSurveyCheckpointContext, secret: string): Buffer {
  let key: Buffer | undefined, plain: Buffer | undefined
  try {
    key = base64(secret, 32, 32)
    const parsed = checkpoint(value)
    const header = headerFor(parsed, owner)
    plain = Buffer.from(JSON.stringify(parsed), 'utf8')
    if (plain.length > SAMPLE_SURVEY_CHECKPOINT_PLAINTEXT_LIMIT) return fail()
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 })
    cipher.setAAD(aad(header))
    const encrypted = Buffer.concat([cipher.update(plain), cipher.final()])
    const result = Buffer.from(JSON.stringify({ ...header, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: encrypted.toString('base64') }) + '\n', 'utf8')
    if (result.length > SAMPLE_SURVEY_CHECKPOINT_ENVELOPE_LIMIT) return fail()
    return result
  } catch { return fail() }
  finally { key?.fill(0); plain?.fill(0) }
}

export function decryptSampleSurveyCheckpoint(bytes: Uint8Array, secret: string, expected: SampleSurveyCheckpointExpected): SampleSurveyCheckpoint {
  let key: Buffer | undefined, plain: Buffer | undefined
  try {
    key = base64(secret, 32, 32)
    const { header, iv, tag, ciphertext } = parseEnvelope(bytes)
    const owner = context({ sourceSha: expected.sourceSha, runId: expected.runId, runAttempt: expected.runAttempt, resumeDepth: expected.resumeDepth ?? header.resumeDepth })
    const config = parseSampleSurveyConfig(expected.config)
    if (header.sourceSha !== owner.sourceSha || header.runId !== owner.runId || header.runAttempt !== owner.runAttempt
      || header.resumeDepth !== owner.resumeDepth || JSON.stringify(header.config) !== JSON.stringify(config)) return fail()
    const cipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 })
    cipher.setAAD(aad(header)); cipher.setAuthTag(tag)
    plain = Buffer.concat([cipher.update(ciphertext), cipher.final()])
    if (plain.length > SAMPLE_SURVEY_CHECKPOINT_PLAINTEXT_LIMIT) return fail()
    const parsed = checkpoint(JSON.parse(plain.toString('utf8')))
    if (JSON.stringify(headerFor(parsed, owner)) !== JSON.stringify(header)) return fail()
    return parsed
  } catch { return fail() }
  finally { key?.fill(0); plain?.fill(0) }
}

async function inspect(path: string) {
  try { return await lstat(path) }
  catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null; throw error }
}
/** Check every ancestor before creating/reading a file; never follow junctions or symbolic links. */
async function safeParents(file: string, create: boolean): Promise<void> {
  const parent = dirname(file), ancestors: string[] = []
  for (let current = parent; ; current = dirname(current)) { ancestors.unshift(current); if (current === dirname(current)) break }
  for (const current of ancestors) {
    const info = await inspect(current)
    if (info) { if (info.isSymbolicLink() || !info.isDirectory()) return fail() }
    else if (create) { await mkdir(current, { mode: 0o700 }); const created = await inspect(current); if (!created || created.isSymbolicLink() || !created.isDirectory()) return fail() }
    else return fail()
  }
}
function privatePath(path: string): string {
  if (typeof path !== 'string' || !path || path.includes('\0')) return fail()
  const file = resolve(path)
  if (file === dirname(file) || file.split(sep).some(part => ['public', '.git'].includes(part.toLowerCase()))) return fail()
  return file
}
async function safeFile(path: string, required: boolean): Promise<void> {
  const info = await inspect(path)
  if (!info) { if (required) return fail(); return }
  if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1 || info.size > SAMPLE_SURVEY_CHECKPOINT_ENVELOPE_LIMIT) return fail()
}

async function atomicWrite(bytes: Uint8Array, path: string): Promise<void> {
  let temporary: string | undefined
  try {
    if (bytes.byteLength > SAMPLE_SURVEY_CHECKPOINT_ENVELOPE_LIMIT) return fail()
    const file = privatePath(path)
    await safeParents(file, true); await safeFile(file, false)
    const staged = `${file}.${randomUUID()}.tmp`
    temporary = staged
    const handle = await open(staged, 'wx', 0o600)
    try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
    await safeParents(file, false); await safeFile(file, false); await safeFile(staged, true)
    for (let attempt = 0; ; attempt++) {
      try { await rename(staged, file); temporary = undefined; break }
      catch (error) {
        if (attempt >= 3 || !error || typeof error !== 'object' || !('code' in error) || !['EPERM', 'EBUSY'].includes(String(error.code))) throw error
        await delay(40 * 2 ** attempt)
        await safeParents(file, false); await safeFile(file, false)
      }
    }
  } catch { return fail() }
  finally { if (temporary) await unlink(temporary).catch(() => {}) }
}

async function readEnvelope(path: string): Promise<Buffer> {
  try {
    const file = privatePath(path)
    await safeParents(file, false); await safeFile(file, true)
    const handle = await open(file, 'r')
    let bytes: Buffer
    try {
      const info = await handle.stat()
      if (!info.isFile() || info.nlink !== 1 || info.size > SAMPLE_SURVEY_CHECKPOINT_ENVELOPE_LIMIT) return fail()
      bytes = Buffer.alloc(info.size + 1)
      let offset = 0
      while (offset < bytes.length) {
        const result = await handle.read(bytes, offset, bytes.length - offset, null)
        if (!result.bytesRead) break
        offset += result.bytesRead
      }
      if (offset !== info.size) return fail()
      bytes = bytes.subarray(0, offset)
    } finally { await handle.close() }
    await safeParents(file, false); await safeFile(file, true)
    return bytes
  } catch { return fail() }
}

/** Atomic replacement contains ciphertext only, including the temporary file. A failed update retains the previous checkpoint. */
export async function saveSampleSurveyCloudCheckpoint(value: unknown, owner: SampleSurveyCheckpointContext, secret: string, path: string): Promise<SampleSurveyCheckpointManifest> {
  const bytes = encryptSampleSurveyCheckpoint(value, owner, secret)
  await atomicWrite(bytes, path)
  return createSampleSurveyCheckpointManifest(bytes)
}
export async function loadSampleSurveyCloudCheckpointBundle(path: string, secret: string, expected: SampleSurveyCheckpointExpected): Promise<{
  checkpoint: SampleSurveyCheckpoint; manifest: SampleSurveyCheckpointManifest
}> {
  const bytes = await readEnvelope(path)
  const checkpoint = decryptSampleSurveyCheckpoint(bytes, secret, expected)
  return { checkpoint, manifest: createSampleSurveyCheckpointManifest(bytes) }
}
export async function loadSampleSurveyCloudCheckpoint(path: string, secret: string, expected: SampleSurveyCheckpointExpected): Promise<SampleSurveyCheckpoint> {
  return (await loadSampleSurveyCloudCheckpointBundle(path, secret, expected)).checkpoint
}

/** Rebuild metadata from the last atomic ciphertext, even when the collector ended before its final callback. No decryption key is needed. */
export async function finalizeSampleSurveyCloudCheckpoint(encryptedPath: string, manifestPath: string): Promise<SampleSurveyCheckpointManifest> {
  if (privatePath(encryptedPath) === privatePath(manifestPath)) return fail()
  const manifest = createSampleSurveyCheckpointManifest(await readEnvelope(encryptedPath))
  await atomicWrite(Buffer.from(JSON.stringify(manifest) + '\n', 'utf8'), manifestPath)
  return manifest
}
