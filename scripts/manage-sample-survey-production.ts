import { createHash } from 'node:crypto'
import { appendFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { inflateRawSync } from 'node:zlib'
import { setTimeout as delay } from 'node:timers/promises'
import { parseSampleSurveyResultsManifest, parseSampleSurveyResultsRun, SAMPLE_SURVEY_RESULTS_MAX_JSON_BYTES } from '../src/lib/sampleSurveyResults.ts'
import type { SampleSurveyConfig, SampleSurveyRun } from '../src/types/sampleSurvey.ts'
import { runCloudGhCommand, type CloudGhCommand } from './lib/parallel-fetch-github.ts'
import { publishableSampleSurveyRun } from './lib/sample-survey-publication.ts'
import { validateProductionRecovery, validateProductionRestart, validateProductionResume } from './lib/sample-survey-production-resume.ts'
import { createSampleSurveyCheckpointManifest, parseSampleSurveyCheckpointManifest, type SampleSurveyCheckpointManifest } from './lib/sample-survey-cloud-checkpoint.ts'

const REPO = 'gonchiman/sf6', API = `repos/${REPO}`, WORKFLOW = 'sample-survey.yml'
const META_LIMIT = 1024 * 1024, ZIP_LIMIT = 1024 * 1024
const CHECKPOINT_ZIP_LIMIT = 32 * 1024 * 1024, CHECKPOINT_FILE_LIMIT = 24 * 1024 * 1024
export const PRODUCTION_RESUME_DELAY_MS = 5 * 60_000
export const PRODUCTION_MAX_RESUMES = 6
export const PRODUCTION_CLOCK_SKEW_MS = 5000
class ProductionManagementError extends Error {}
const fail = (reason: 'verification' | 'workflow-changed' = 'verification'): never => {
  throw new ProductionManagementError(reason === 'workflow-changed'
    ? '取得用ワークフローが固定した版から変更されたため、後続を開始しません。'
    : '本取得の実行または保存結果を確認できないため、後続を開始しません。')
}
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail()
  return value as Record<string, unknown>
}
const id = (value: unknown): string => {
  const text = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value
  if (typeof text !== 'string' || !/^[1-9]\d{0,14}$/.test(text)) return fail()
  return text
}
const sha = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[a-f0-9]{40}$/.test(value)) return fail()
  return value
}
export function productionStage(stage: number): { stage: number; label: string; config: SampleSurveyConfig; waitMinutes: number } {
  if (!Number.isInteger(stage) || stage < 1 || stage > 5) return fail()
  const pairs: SampleSurveyConfig['ranks'][] = [['ROOKIE', 'IRON'], ['BRONZE', 'SILVER'], ['GOLD', 'PLATINUM'], ['DIAMOND', 'MASTER'], []]
  return { stage, label: stage === 5 ? 'MR6帯' : pairs[stage - 1]!.join('・'), waitMinutes: stage === 5 ? 295 : stage === 1 ? 175 : 235,
    config: { ranks: [...pairs[stage - 1]!], rankSampleSize: 200, includeMr: stage === 5, mrSampleSize: 100, maxDurationMinutes: stage === 5 ? 180 : 120 } }
}
export interface ProductionRun { id: string; attempt: 1; status: 'queued' | 'in_progress' | 'completed'; conclusion: string | null; createdAt: string }
export function parseProductionRun(value: unknown, expected: { runId: string; sha: string; pinnedSource?: boolean }): ProductionRun {
  const input = object(value)
  sha(input.head_sha); sha(expected.sha)
  if (id(input.id) !== id(expected.runId)
    || (expected.pinnedSource ? input.display_title !== `Sample survey source ${expected.sha}` : input.head_sha !== expected.sha)
    || input.run_attempt !== 1
    || input.event !== 'workflow_dispatch' || input.head_branch !== 'main'
    || object(input.repository).full_name !== REPO || object(input.head_repository).full_name !== REPO
    || ![`.github/workflows/${WORKFLOW}`, `.github/workflows/${WORKFLOW}@refs/heads/main`].includes(String(input.path))
    || !['queued', 'in_progress', 'completed', 'requested', 'waiting', 'pending'].includes(String(input.status))
    || typeof input.created_at !== 'string' || !Number.isFinite(Date.parse(input.created_at))) return fail()
  const status = input.status === 'completed' ? 'completed' : input.status === 'in_progress' ? 'in_progress' : 'queued'
  if (status === 'completed' && typeof input.conclusion !== 'string' || status !== 'completed' && input.conclusion !== null) return fail()
  return { id: id(input.id), attempt: 1, status, conclusion: input.conclusion as string | null, createdAt: new Date(input.created_at).toISOString() }
}
export function parseProductionDispatch(value: unknown): string {
  const input = object(value), runId = id(input.workflow_run_id)
  if (input.run_url !== `https://api.github.com/${API}/actions/runs/${runId}`
    || input.html_url !== `https://github.com/${REPO}/actions/runs/${runId}`) return fail()
  return runId
}
export function validateProductionReport(value: unknown, stage: number): SampleSurveyRun {
  const report = publishableSampleSurveyRun(value), expected = productionStage(stage).config
  if (!isDeepStrictEqual(report.config, expected) || report.schemaVersion !== 2 || report.observation?.method !== 'rank-position-tolerant-v1'
    || report.strata.some(row => row.population === null || row.selected !== row.requested
      || row.processed !== row.selected || row.succeeded + row.missing + row.duplicates !== row.selected
      || row.succeeded === 0)) return fail()
  return report
}

/** Adapt the existing in-memory ZIP reader to this feed's manifest and one report. Nothing is extracted to disk. */
export function extractProductionArtifact(zip: Buffer, kind: 'report' | 'checkpoint' = 'report'): Map<string, Buffer> {
  try {
    const zipLimit = kind === 'checkpoint' ? CHECKPOINT_ZIP_LIMIT : ZIP_LIMIT
    const fileLimit = kind === 'checkpoint' ? CHECKPOINT_FILE_LIMIT : SAMPLE_SURVEY_RESULTS_MAX_JSON_BYTES
    if (zip.length < 22 || zip.length > zipLimit) return fail()
    let end = -1
    for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65557); i--) {
      if (zip.readUInt32LE(i) === 0x06054b50 && i + 22 + zip.readUInt16LE(i + 20) === zip.length) { end = i; break }
    }
    if (end < 0 || zip.readUInt16LE(end + 4) || zip.readUInt16LE(end + 6)) return fail()
    const count = zip.readUInt16LE(end + 10), start = zip.readUInt32LE(end + 16), size = zip.readUInt32LE(end + 12)
    if (count < 2 || count > 3 || zip.readUInt16LE(end + 8) !== count || start + size !== end) return fail()
    const files = new Map<string, Buffer>(), ranges: [number, number][] = []
    let at = start, total = 0
    const decode = (bytes: Buffer): string => new TextDecoder('utf8', { fatal: true }).decode(bytes)
    for (let entry = 0; entry < count; entry++) {
      if (at + 46 > end || zip.readUInt32LE(at) !== 0x02014b50) return fail()
      const flags = zip.readUInt16LE(at + 8), method = zip.readUInt16LE(at + 10), crc = zip.readUInt32LE(at + 16)
      const compressed = zip.readUInt32LE(at + 20), uncompressed = zip.readUInt32LE(at + 24)
      const nameSize = zip.readUInt16LE(at + 28), extra = zip.readUInt16LE(at + 30), comment = zip.readUInt16LE(at + 32), local = zip.readUInt32LE(at + 42)
      if (at + 46 + nameSize + extra + comment > end || flags & 1 || ![0, 8].includes(method)
        || compressed > zipLimit || uncompressed > fileLimit || zip.readUInt16LE(at + 34)
        || (zip.readUInt32LE(at + 38) >>> 16 & 0xf000) === 0xa000) return fail()
      const name = decode(zip.subarray(at + 46, at + 46 + nameSize))
      const allowed = kind === 'checkpoint' ? ['manifest.json', 'checkpoint.enc.json'].includes(name)
        : name === 'index.json' || name === 'runs/' || /^runs\/[A-Za-z0-9][A-Za-z0-9_-]{0,79}\.json$/.test(name)
      if (!allowed || files.has(name)
        || local + 30 > start || zip.readUInt32LE(local) !== 0x04034b50 || zip.readUInt16LE(local + 6) !== flags
        || zip.readUInt16LE(local + 8) !== method) return fail()
      const localName = zip.readUInt16LE(local + 26), localExtra = zip.readUInt16LE(local + 28), data = local + 30 + localName + localExtra
      if (data + compressed > start || decode(zip.subarray(local + 30, local + 30 + localName)) !== name
        || ranges.some(([a, b]) => local < b && data + compressed > a)) return fail()
      ranges.push([local, data + compressed])
      const packed = zip.subarray(data, data + compressed)
      const bytes = method === 0 ? Buffer.from(packed) : inflateRawSync(packed, { maxOutputLength: fileLimit })
      if (bytes.length !== uncompressed || name === 'runs/' && bytes.length !== 0 || name !== 'runs/' && bytes.length === 0) return fail()
      let checksum = 0xffffffff
      for (const byte of bytes) { checksum ^= byte; for (let bit = 0; bit < 8; bit++) checksum = checksum >>> 1 ^ (checksum & 1 ? 0xedb88320 : 0) }
      if (((checksum ^ 0xffffffff) >>> 0) !== crc) return fail()
      files.set(name, bytes); total += bytes.length; at += 46 + nameSize + extra + comment
    }
    if (at !== end || total > (kind === 'checkpoint' ? CHECKPOINT_FILE_LIMIT + 16 * 1024 : 2 * SAMPLE_SURVEY_RESULTS_MAX_JSON_BYTES)) return fail()
    if (kind === 'checkpoint' ? files.size !== 2 || !files.has('manifest.json') || !files.has('checkpoint.enc.json') || files.get('manifest.json')!.length > 16 * 1024
      : !files.has('index.json') || [...files.keys()].filter(name => name.startsWith('runs/') && name !== 'runs/').length !== 1) return fail()
    return files
  } catch { return fail() }
}
export interface ProductionGitHub {
  mainSha(): Promise<string>
  dispatch(stage: number, sourceSha: string, resumeRunId?: string, executionBudgetMinutes?: number,
    recovery?: { sourceSha: string; recoverAuthentication: true }): Promise<string>
  run(runId: string, expectedSha: string, pinnedSource?: boolean): Promise<ProductionRun>
  report(run: ProductionRun, stage: number, resumed?: SampleSurveyCheckpointManifest): Promise<SampleSurveyRun>
  checkpoint?(run: ProductionRun, stage: number, sourceSha: string, completed?: boolean): Promise<SampleSurveyCheckpointManifest>
  cancel?(runId: string): Promise<void>
}
/** Read encrypted checkpoint bytes only; the parent never receives the decryption key. */
export async function fetchSampleSurveyCheckpointArtifact(options: {
  run: ProductionRun; sourceSha: string; config: SampleSurveyConfig; completed?: boolean
}, command: CloudGhCommand = runCloudGhCommand): Promise<{ manifest: SampleSurveyCheckpointManifest; files: Map<string, Buffer> }> {
  try {
    const { run, config } = options, source = sha(options.sourceSha), runId = id(run.id)
    if (run.status !== 'completed' || run.conclusion !== (options.completed === true ? 'success' : 'failure') || run.attempt !== 1) return fail()
    const listing = object(JSON.parse((await command(['api', '--hostname', 'github.com', `${API}/actions/runs/${runId}/artifacts?per_page=100`], META_LIMIT)).toString('utf8')))
    const expectedCount = options.completed === true ? 2 : 1
    if (listing.total_count !== expectedCount || !Array.isArray(listing.artifacts) || listing.artifacts.length !== expectedCount) return fail()
    const names = listing.artifacts.map(value => String(object(value).name))
    if (new Set(names).size !== expectedCount || names.some(name => ![`sample-survey-checkpoint-${runId}-1`,
      ...(options.completed === true ? [`sample-survey-${runId}-1`] : [])].includes(name))) return fail()
    const artifact = object(listing.artifacts.find(value => object(value).name === `sample-survey-checkpoint-${runId}-1`))
    if (artifact.name !== `sample-survey-checkpoint-${runId}-1` || artifact.expired !== false
      || !Number.isSafeInteger(artifact.size_in_bytes) || Number(artifact.size_in_bytes) < 1 || Number(artifact.size_in_bytes) > CHECKPOINT_ZIP_LIMIT
      || typeof artifact.digest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(artifact.digest)
      || id(object(artifact.workflow_run).id) !== runId) return fail()
    const zip = await command(['api', '--hostname', 'github.com', `${API}/actions/artifacts/${id(artifact.id)}/zip`], CHECKPOINT_ZIP_LIMIT)
    if (`sha256:${createHash('sha256').update(zip).digest('hex')}` !== artifact.digest) return fail()
    const files = extractProductionArtifact(zip, 'checkpoint')
    const manifest = parseSampleSurveyCheckpointManifest(JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(files.get('manifest.json')!)))
    const encrypted = files.get('checkpoint.enc.json')!
    if (manifest.runId !== runId || manifest.runAttempt !== 1 || manifest.sourceSha !== source || !isDeepStrictEqual(manifest.config, config)
      || manifest.bytes !== encrypted.length || manifest.sha256 !== createHash('sha256').update(encrypted).digest('hex')
      || !isDeepStrictEqual(manifest, createSampleSurveyCheckpointManifest(encrypted))
      || Date.parse(manifest.checkpointAt) < Date.parse(run.createdAt)) return fail()
    return { manifest, files }
  } catch { return fail() }
}
/** A second manual parent must not silently reuse the same first collection and dispatch the remaining stages again. */
export function validateProductionParents(value: unknown, parentRunId: string, firstRunId: string): void {
  const input = object(value), current = id(parentRunId), first = id(firstRunId)
  if (!Number.isSafeInteger(input.total_count) || Number(input.total_count) < 1 || Number(input.total_count) > 100
    || !Array.isArray(input.workflow_runs) || input.workflow_runs.length !== input.total_count) return fail()
  const title = `Sample survey production ${first}`
  const matches = input.workflow_runs.filter(value => object(value).display_title === title
    || typeof object(value).display_title === 'string' && String(object(value).display_title).startsWith(`${title} `))
  if (matches.length !== 1) return fail()
  const run = object(matches[0])
  if (id(run.id) !== current || run.run_attempt !== 1 || run.event !== 'workflow_dispatch' || run.head_branch !== 'main'
    || object(run.repository).full_name !== REPO || object(run.head_repository).full_name !== REPO) return fail()
}
export function createProductionGitHub(command: CloudGhCommand = runCloudGhCommand, metadataWait: (ms: number) => Promise<void> = ms => delay(ms)): ProductionGitHub {
  const api = async (path: string, extra: string[] = []): Promise<Record<string, unknown>> => {
    try { return object(JSON.parse((await command(['api', '--hostname', 'github.com', '-H', 'X-GitHub-Api-Version: 2026-03-10', path, ...extra], META_LIMIT)).toString('utf8'))) }
    catch { return fail() }
  }
  const workflowBlobs = new Map<string, string>()
  async function workflowBlob(revision: string): Promise<string> {
    const ref = sha(revision)
    if (workflowBlobs.has(ref)) return workflowBlobs.get(ref)!
    const path = `.github/workflows/${WORKFLOW}`
    const value = await api(`${API}/contents/${path}?ref=${ref}`)
    if (value.type !== 'file' || value.path !== path) return fail()
    const blob = sha(value.sha)
    workflowBlobs.set(ref, blob)
    return blob
  }
  async function compatibleWorkflow(source: string, launch: string): Promise<void> {
    if (sha(source) !== sha(launch) && await workflowBlob(source) !== await workflowBlob(launch)) return fail('workflow-changed')
  }
  return {
    async mainSha() { return sha((await api(`${API}/commits/main`)).sha) },
    async dispatch(stage, sourceSha, resumeRunId, executionBudgetMinutes, recovery) {
      const { config } = productionStage(stage)
      if (resumeRunId !== undefined) id(resumeRunId)
      if (executionBudgetMinutes !== undefined && (!Number.isInteger(executionBudgetMinutes) || executionBudgetMinutes < 1 || executionBudgetMinutes > config.maxDurationMinutes)) return fail()
      if (recovery && (stage !== 3 || !resumeRunId || recovery.recoverAuthentication !== true || !/^[a-f0-9]{40}$/.test(recovery.sourceSha))) return fail()
      const source = sha(sourceSha), launch = sha((await api(`${API}/commits/main`)).sha)
      await compatibleWorkflow(source, launch)
      // One POST only. Never resend a dispatch after an ambiguous response.
      return parseProductionDispatch(await api(`${API}/actions/workflows/${WORKFLOW}/dispatches`, ['--method', 'POST',
        '-f', 'ref=main', '-F', 'return_run_details=true', '-f', `inputs[ranks]=${config.ranks.join(',') || 'NONE'}`,
        '-f', `inputs[rank_sample_size]=${config.rankSampleSize}`, '-f', `inputs[include_mr]=${config.includeMr}`,
        '-f', `inputs[mr_sample_size]=${config.mrSampleSize}`, '-f', `inputs[max_duration_minutes]=${config.maxDurationMinutes}`,
        '-f', `inputs[source_sha]=${source}`,
        ...(resumeRunId ? ['-f', `inputs[resume_run_id]=${resumeRunId}`] : []),
        ...(recovery ? ['-f', `inputs[resume_source_sha]=${sha(recovery.sourceSha)}`, '-f', 'inputs[recover_authentication]=true'] : []),
        ...(executionBudgetMinutes === undefined ? [] : ['-f', `inputs[execution_budget_minutes]=${executionBudgetMinutes}`])]))
    },
    async run(runId, expectedSha, pinnedSource = false) {
      sha(expectedSha); id(runId)
      // Dispatch can precede the run's API metadata. Retry only this known GET,
      // never the POST, and never accept a mismatched identity to continue.
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const raw = await api(`${API}/actions/runs/${runId}`)
          const run = parseProductionRun(raw, { runId, sha: expectedSha, pinnedSource })
          if (pinnedSource) await compatibleWorkflow(expectedSha, sha(raw.head_sha))
          return run
        } catch (error) {
          if (attempt === 2) throw error
          await metadataWait(5000)
        }
      }
      return fail()
    },
    async checkpoint(run, stage, sourceSha, completed) {
      return (await fetchSampleSurveyCheckpointArtifact({ run, sourceSha, config: productionStage(stage).config, completed }, command)).manifest
    },
    async cancel(runId) {
      await command(['api', '--hostname', 'github.com', `${API}/actions/runs/${id(runId)}/cancel`, '--method', 'POST'], META_LIMIT)
    },
    async report(run, stage, resumed) {
      if (run.status !== 'completed' || run.conclusion !== 'success' || run.attempt !== 1) return fail()
      const listing = await api(`${API}/actions/runs/${id(run.id)}/artifacts?per_page=100`)
      if (![1, 2].includes(Number(listing.total_count)) || !Array.isArray(listing.artifacts) || listing.artifacts.length !== listing.total_count) return fail()
      const expectedName = `sample-survey-${run.id}-1`, names = listing.artifacts.map(value => String(object(value).name))
      if (new Set(names).size !== names.length || names.some(name => ![expectedName, `sample-survey-checkpoint-${run.id}-1`].includes(name))) return fail()
      const artifact = object(listing.artifacts.find(value => object(value).name === expectedName))
      if (artifact.name !== expectedName || artifact.expired !== false || !Number.isSafeInteger(artifact.size_in_bytes)
        || Number(artifact.size_in_bytes) < 1 || Number(artifact.size_in_bytes) > ZIP_LIMIT
        || typeof artifact.digest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(artifact.digest)
        || id(object(artifact.workflow_run).id) !== run.id) return fail()
      const zip = await command(['api', '--hostname', 'github.com', `${API}/actions/artifacts/${id(artifact.id)}/zip`], ZIP_LIMIT)
      if (`sha256:${createHash('sha256').update(zip).digest('hex')}` !== artifact.digest) return fail()
      const files = extractProductionArtifact(zip)
      const decode = (bytes: Buffer): unknown => {
        if (bytes.length > SAMPLE_SURVEY_RESULTS_MAX_JSON_BYTES) return fail()
        return JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes)) as unknown
      }
      const manifest = parseSampleSurveyResultsManifest(decode(files.get('index.json')!))
      if (manifest.datasets.length !== 1) return fail()
      const descriptor = manifest.datasets[0]!, bytes = files.get(descriptor.path)
      if (!bytes) return fail()
      const report = validateProductionReport(parseSampleSurveyResultsRun(decode(bytes), descriptor), stage)
      if (resumed ? report.id !== resumed.reportId || report.planId !== resumed.planId || report.startedAt !== resumed.startedAt
        || report.strata.reduce((n, row) => n + row.processed, 0) < resumed.processed
        : Date.parse(report.startedAt) < Date.parse(run.createdAt)) return fail()
      const history = await api(`${API}/contents/public/data/sample-survey/${descriptor.path}?ref=codex%2Fsample-survey-history`)
      if (history.encoding !== 'base64' || typeof history.content !== 'string' || history.content.length > 2 * SAMPLE_SURVEY_RESULTS_MAX_JSON_BYTES) return fail()
      const published = parseSampleSurveyResultsRun(decode(Buffer.from(history.content, 'base64')), descriptor)
      if (!isDeepStrictEqual(published, report)) return fail()
      const historyIndex = await api(`${API}/contents/public/data/sample-survey/index.json?ref=codex%2Fsample-survey-history`)
      if (historyIndex.encoding !== 'base64' || typeof historyIndex.content !== 'string' || historyIndex.content.length > 2 * SAMPLE_SURVEY_RESULTS_MAX_JSON_BYTES) return fail()
      const saved = parseSampleSurveyResultsManifest(decode(Buffer.from(historyIndex.content, 'base64')))
      if (!saved.datasets.some(value => isDeepStrictEqual(value, descriptor))) return fail()
      return report
    },
  }
}
export async function adoptCompletedProductionStage(options: { stage: 2; runId: string; sourceSha: string }, dependencies: {
  github: ProductionGitHub; now?: () => number
}): Promise<{ run: ProductionRun; report: SampleSurveyRun }> {
  if (options.stage !== 2 || !dependencies.github.checkpoint) return fail()
  const runId = id(options.runId), source = sha(options.sourceSha), { github } = dependencies
  const run = await github.run(runId, source, true), now = (dependencies.now ?? Date.now)()
  if (run.status !== 'completed' || run.conclusion !== 'success' || Date.parse(run.createdAt) > now + PRODUCTION_CLOCK_SKEW_MS) return fail()
  const saved = parseSampleSurveyCheckpointManifest(await github.checkpoint!(run, options.stage, source, true))
  if (saved.runId !== runId || saved.sourceSha !== source || saved.runAttempt !== 1 || saved.state !== 'complete' || saved.stopReason !== null
    || saved.resumeAllowed || saved.processed !== 400 || !isDeepStrictEqual(saved.config, productionStage(2).config)
    || Date.parse(saved.checkpointAt) > now || Date.parse(saved.checkpointAt) < Date.parse(run.createdAt)) return fail()
  const report = validateProductionReport(await github.report(run, 2, saved), 2)
  if (report.id !== saved.reportId || report.planId !== saved.planId || report.startedAt !== saved.startedAt) return fail()
  return { run, report }
}

export async function runProductionStage(options: { stage: number; sha: string; firstRunId?: string; firstRunSha?: string; allowCompletedHistory?: boolean;
  recoveryCheckpoint?: { runId: string; sourceSha: string } }, dependencies: {
  github: ProductionGitHub; now?: () => number; sleep?: (ms: number) => Promise<void>; log?: (value: unknown) => void
}): Promise<{ run: ProductionRun; report: SampleSurveyRun }> {
  const stage = productionStage(options.stage), expectedSha = sha(options.sha), { github } = dependencies
  const now = dependencies.now ?? Date.now, sleep = dependencies.sleep ?? (ms => delay(ms)), log = dependencies.log ?? (() => {})
  const start = now(), deadline = start + stage.waitMinutes * 60000
  let runId: string, runSha: string
  let resumed: SampleSurveyCheckpointManifest | undefined, resumes = 0
  const dispatched = new Set<string>()
  if (options.recoveryCheckpoint && stage.stage !== 3) return fail()
  if (stage.stage === 1) {
    runId = id(options.firstRunId); runSha = sha(options.firstRunSha)
  } else {
    if (options.firstRunId || options.firstRunSha || options.allowCompletedHistory) return fail()
    runSha = expectedSha
    if (options.recoveryCheckpoint) {
      if (!github.checkpoint) return fail()
      const oldId = id(options.recoveryCheckpoint.runId), oldSource = sha(options.recoveryCheckpoint.sourceSha)
      const oldRun = await github.run(oldId, oldSource, true)
      if (oldRun.status !== 'completed' || oldRun.conclusion !== 'failure' || Date.parse(oldRun.createdAt) > now() + PRODUCTION_CLOCK_SKEW_MS) return fail()
      const saved = parseSampleSurveyCheckpointManifest(await github.checkpoint(oldRun, stage.stage, oldSource))
      if (saved.sourceSha !== oldSource || saved.runId !== oldId || saved.runAttempt !== 1 || saved.resumeDepth >= PRODUCTION_MAX_RESUMES
        || !isDeepStrictEqual(saved.config, stage.config) || saved.state !== 'error' || saved.stopReason !== 'authentication-unconfirmed'
        || saved.resumeAllowed || Date.parse(saved.startedAt) < now() - 72 * 60 * 60_000 || Date.parse(saved.checkpointAt) > now()
        || Date.parse(saved.checkpointAt) < Date.parse(oldRun.createdAt)) return fail()
      resumed = saved; resumes = saved.resumeDepth + 1
      dispatched.add(oldId)
      // Explicitly requested once. The child must obtain a fresh positive auth
      // result before restoring any saved work. Later auth stops still terminate.
      runId = id(await github.dispatch(stage.stage, expectedSha, oldId, stage.config.maxDurationMinutes,
        { sourceSha: oldSource, recoverAuthentication: true }))
      if (dispatched.has(runId)) return fail()
      log({ stage: stage.stage, runId, state: 'authentication-recovery-requested', previousRunId: oldId, processed: saved.processed, resumeNumber: resumes })
    } else runId = id(await github.dispatch(stage.stage, expectedSha))
  }
  dispatched.add(runId)
  log({ stage: stage.stage, runId, sourceSha: runSha, state: 'waiting', url: `https://github.com/${REPO}/actions/runs/${runId}` })
  while (now() <= deadline) {
    const run = await github.run(runId, runSha, stage.stage > 1)
    if (Date.parse(run.createdAt) > now() + PRODUCTION_CLOCK_SKEW_MS || Date.parse(run.createdAt) < start - 24 * 60 * 60000
      && !(stage.stage === 1 && options.allowCompletedHistory === true && run.status === 'completed' && run.conclusion === 'success')) return fail()
    if (run.status === 'completed') {
      if (now() > deadline) return fail()
      if (run.conclusion !== 'success') {
        if (stage.stage === 1 || run.conclusion !== 'failure' || !github.checkpoint || resumes >= PRODUCTION_MAX_RESUMES) return fail()
        const saved = parseSampleSurveyCheckpointManifest(await github.checkpoint(run, stage.stage, runSha))
        if (saved.sourceSha !== runSha || saved.runId !== runId || saved.runAttempt !== 1 || saved.resumeDepth !== resumes
          || !isDeepStrictEqual(saved.config, stage.config) || saved.resumeAllowed !== true || !['error', 'stopped'].includes(saved.state)
          || !['server-error', 'timeout', 'limit-reached'].includes(saved.stopReason ?? '')
          || Date.parse(saved.startedAt) < now() - 72 * 60 * 60_000 || Date.parse(saved.checkpointAt) > now()
          || Date.parse(saved.checkpointAt) < Date.parse(run.createdAt)
          || resumed && (saved.reportId !== resumed.reportId || saved.planId !== resumed.planId || saved.startedAt !== resumed.startedAt || saved.processed < resumed.processed)) return fail()
        if (now() + PRODUCTION_RESUME_DELAY_MS + 16 * 60000 > deadline) return fail()
        log({ stage: stage.stage, runId, state: 'checkpoint-saved', processed: saved.processed, resumeNumber: resumes + 1, delayMs: PRODUCTION_RESUME_DELAY_MS })
        // The delay is explicit and bounded; never reactivate a CAPTCHA/login/denial stop.
        await sleep(PRODUCTION_RESUME_DELAY_MS)
        const budget = Math.min(stage.config.maxDurationMinutes, Math.floor((deadline - now()) / 60000) - 15)
        if (budget < 1) return fail()
        const next = id(await github.dispatch(stage.stage, runSha, runId, budget))
        if (dispatched.has(next)) return fail()
        dispatched.add(next); resumed = saved; resumes++; runId = next
        log({ stage: stage.stage, runId, sourceSha: runSha, state: 'resumed', resumeNumber: resumes,
          previousRunId: saved.runId, processed: saved.processed, url: `https://github.com/${REPO}/actions/runs/${runId}` })
        continue
      }
      const report = validateProductionReport(await github.report(run, stage.stage, resumed), stage.stage)
      if (resumed && (report.id !== resumed.reportId || report.planId !== resumed.planId || report.startedAt !== resumed.startedAt)) return fail()
      log({ stage: stage.stage, runId, state: 'complete', reportId: report.id, strata: report.strata.map(row => ({ id: row.id, requested: row.requested,
        succeeded: row.succeeded, missing: row.missing, duplicates: row.duplicates })) })
      return { run, report }
    }
    if (now() + 60000 > deadline) break
    await sleep(60000)
  }
  if (stage.stage > 1 && github.cancel) {
    // Only stop a child created by this stage, never the externally supplied first run.
    await github.cancel(runId)
    log({ stage: stage.stage, runId, state: 'monitor-deadline-cancel-requested' })
  }
  return fail()
}
export function isAllowedProductionExecution(env: Record<string, string | undefined>): boolean {
  return env.GITHUB_ACTIONS === 'true' && env.RUNNER_ENVIRONMENT === 'github-hosted' && env.RUNNER_OS === 'Linux'
    && env.GITHUB_REPOSITORY === REPO && env.GITHUB_REF === 'refs/heads/main' && env.GITHUB_EVENT_NAME === 'workflow_dispatch'
    && env.GITHUB_WORKFLOW_REF === `${REPO}/.github/workflows/sample-survey-production.yml@refs/heads/main`
    && env.GITHUB_RUN_ATTEMPT === '1'
}
export async function main(args = process.argv.slice(2)): Promise<void> {
  if (args.length !== 0 || !isAllowedProductionExecution(process.env) || !/^[1-5]$/.test(process.env.PRODUCTION_STAGE ?? '')) return fail()
  const stage = Number(process.env.PRODUCTION_STAGE)
  const parentRuns = JSON.parse((await runCloudGhCommand(['api', '--hostname', 'github.com',
    `${API}/actions/workflows/sample-survey-production.yml/runs?event=workflow_dispatch&branch=main&per_page=100`], META_LIMIT)).toString('utf8'))
  const parentRunId = id(process.env.GITHUB_RUN_ID), firstRunId = id(process.env.PRODUCTION_FIRST_RUN_ID)
  const resumeFrom = process.env.PRODUCTION_RESUME_FROM_RUN_ID?.trim()
  const restartFailed = process.env.PRODUCTION_RESTART_FAILED_RUN_ID?.trim()
  const recoveryParent = process.env.PRODUCTION_RECOVERY_PARENT_RUN_ID?.trim()
  const checkpointRun = process.env.PRODUCTION_RECOVERY_CHECKPOINT_RUN_ID?.trim()
  const completedSecond = process.env.PRODUCTION_COMPLETED_SECOND_RUN_ID?.trim()
  const checkpointSource = process.env.PRODUCTION_CHECKPOINT_SOURCE_SHA?.trim()
  if (restartFailed && !resumeFrom) return fail()
  if ([checkpointRun, completedSecond, checkpointSource].some(Boolean) && !recoveryParent) return fail()
  if (recoveryParent) {
    if (resumeFrom || restartFailed) return fail()
    const previousParentRunId = id(recoveryParent), checkpointRunId = id(checkpointRun)
    const completedSecondRunId = id(completedSecond), checkpointSourceSha = sha(checkpointSource)
    const read = async (path: string) => JSON.parse((await runCloudGhCommand(['api', '--hostname', 'github.com', `${API}/${path}`], META_LIMIT)).toString('utf8'))
    const [previousParent, previousJobs, childRuns, completedSecondRun, failedChild] = await Promise.all([
      read(`actions/runs/${previousParentRunId}`), read(`actions/runs/${previousParentRunId}/jobs?filter=latest&per_page=100`),
      read(`actions/workflows/${WORKFLOW}/runs?event=workflow_dispatch&branch=main&per_page=100`),
      read(`actions/runs/${completedSecondRunId}`), read(`actions/runs/${checkpointRunId}`),
    ])
    validateProductionRecovery({ parents: parentRuns, previousParent, previousJobs, childRuns, completedSecond: completedSecondRun, failedChild,
      parentRunId, firstRunId, previousParentRunId, completedSecondRunId, checkpointRunId, checkpointSourceSha })
  } else if (resumeFrom) {
    const previousParentRunId = id(resumeFrom)
    const read = async (path: string) => JSON.parse((await runCloudGhCommand(['api', '--hostname', 'github.com', `${API}/${path}`], META_LIMIT)).toString('utf8'))
    const [previousParent, previousJobs, childRuns] = await Promise.all([
      read(`actions/runs/${previousParentRunId}`),
      read(`actions/runs/${previousParentRunId}/jobs?filter=latest&per_page=100`),
      read(`actions/workflows/${WORKFLOW}/runs?event=workflow_dispatch&branch=main&per_page=100`),
    ])
    if (restartFailed) {
      const restartFailedRunId = id(restartFailed)
      const match = new RegExp(`^Sample survey production ${firstRunId} resume ([1-9]\\d{0,14})$`).exec(String(object(previousParent).display_title))
      if (!match) return fail()
      const ancestorId = id(match[1])
      const [ancestorParent, ancestorJobs, failedChild, failedChildJobs, failedChildArtifacts] = await Promise.all([
        read(`actions/runs/${ancestorId}`), read(`actions/runs/${ancestorId}/jobs?filter=latest&per_page=100`),
        read(`actions/runs/${restartFailedRunId}`), read(`actions/runs/${restartFailedRunId}/jobs?filter=latest&per_page=100`),
        read(`actions/runs/${restartFailedRunId}/artifacts?per_page=100`),
      ])
      validateProductionRestart({ parents: parentRuns, previousParent, previousJobs, ancestorParent, ancestorJobs, failedChild, failedChildJobs,
        failedChildArtifacts, childRuns, parentRunId, firstRunId, previousParentRunId, restartFailedRunId })
    } else validateProductionResume({ parents: parentRuns, previousParent, previousJobs, childRuns, parentRunId, firstRunId, previousParentRunId })
  } else validateProductionParents(parentRuns, parentRunId, firstRunId)
  const github = createProductionGitHub()
  const result = recoveryParent && stage === 2
    ? await adoptCompletedProductionStage({ stage: 2, runId: id(completedSecond), sourceSha: sha(checkpointSource) }, { github })
    : await runProductionStage({ stage, sha: sha(process.env.GITHUB_SHA),
      ...(stage === 1 ? { firstRunId, firstRunSha: process.env.PRODUCTION_FIRST_RUN_SHA, allowCompletedHistory: !!resumeFrom || !!recoveryParent } : {}),
      ...(recoveryParent && stage === 3 ? { recoveryCheckpoint: { runId: id(checkpointRun), sourceSha: sha(checkpointSource) } } : {}) },
    { github, log: value => console.log(JSON.stringify({ production: value })) })
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `run_id=${result.run.id}\nreport_id=${result.report.id}\n`)
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY,
    `### ${productionStage(stage).label}\n\n[取得実行](https://github.com/${REPO}/actions/runs/${result.run.id}) — 保存・公開確認済み\n\n`
    + '| 区分 | 予定 | 有効 | 欠測 | 重複 |\n| --- | ---: | ---: | ---: | ---: |\n'
    + result.report.strata.map(row => `| ${row.label} | ${row.requested} | ${row.succeeded} | ${row.missing} | ${row.duplicates} |`).join('\n') + '\n')
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => {
  console.error(error instanceof ProductionManagementError ? error.message : '本取得の実行または保存結果を確認できないため、後続を開始しません。')
  process.exitCode = 1
})
