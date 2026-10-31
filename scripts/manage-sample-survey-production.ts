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

const REPO = 'gonchiman/sf6', API = `repos/${REPO}`, WORKFLOW = 'sample-survey.yml'
const META_LIMIT = 1024 * 1024, ZIP_LIMIT = 1024 * 1024
const fail = (): never => { throw new Error('本取得の実行または保存結果を確認できないため、後続を開始しません。') }
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
  return { stage, label: stage === 5 ? 'MR6帯' : pairs[stage - 1]!.join('・'), waitMinutes: stage === 5 ? 235 : 175,
    config: { ranks: [...pairs[stage - 1]!], rankSampleSize: 200, includeMr: stage === 5, mrSampleSize: 100, maxDurationMinutes: stage === 5 ? 180 : 120 } }
}
export interface ProductionRun { id: string; attempt: 1; status: 'queued' | 'in_progress' | 'completed'; conclusion: string | null; createdAt: string }
export function parseProductionRun(value: unknown, expected: { runId: string; sha: string }): ProductionRun {
  const input = object(value)
  if (id(input.id) !== id(expected.runId) || sha(input.head_sha) !== sha(expected.sha) || input.run_attempt !== 1
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
export function extractProductionArtifact(zip: Buffer): Map<string, Buffer> {
  try {
    if (zip.length < 22 || zip.length > ZIP_LIMIT) return fail()
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
        || compressed > ZIP_LIMIT || uncompressed > SAMPLE_SURVEY_RESULTS_MAX_JSON_BYTES || zip.readUInt16LE(at + 34)
        || (zip.readUInt32LE(at + 38) >>> 16 & 0xf000) === 0xa000) return fail()
      const name = decode(zip.subarray(at + 46, at + 46 + nameSize))
      if (name !== 'index.json' && name !== 'runs/' && !/^runs\/[A-Za-z0-9][A-Za-z0-9_-]{0,79}\.json$/.test(name) || files.has(name)
        || local + 30 > start || zip.readUInt32LE(local) !== 0x04034b50 || zip.readUInt16LE(local + 6) !== flags
        || zip.readUInt16LE(local + 8) !== method) return fail()
      const localName = zip.readUInt16LE(local + 26), localExtra = zip.readUInt16LE(local + 28), data = local + 30 + localName + localExtra
      if (data + compressed > start || decode(zip.subarray(local + 30, local + 30 + localName)) !== name
        || ranges.some(([a, b]) => local < b && data + compressed > a)) return fail()
      ranges.push([local, data + compressed])
      const packed = zip.subarray(data, data + compressed)
      const bytes = method === 0 ? Buffer.from(packed) : inflateRawSync(packed, { maxOutputLength: SAMPLE_SURVEY_RESULTS_MAX_JSON_BYTES })
      if (bytes.length !== uncompressed || name === 'runs/' && bytes.length !== 0 || name !== 'runs/' && bytes.length === 0) return fail()
      let checksum = 0xffffffff
      for (const byte of bytes) { checksum ^= byte; for (let bit = 0; bit < 8; bit++) checksum = checksum >>> 1 ^ (checksum & 1 ? 0xedb88320 : 0) }
      if (((checksum ^ 0xffffffff) >>> 0) !== crc) return fail()
      files.set(name, bytes); total += bytes.length; at += 46 + nameSize + extra + comment
    }
    if (at !== end || total > 2 * SAMPLE_SURVEY_RESULTS_MAX_JSON_BYTES || !files.has('index.json')
      || [...files.keys()].filter(name => name.startsWith('runs/') && name !== 'runs/').length !== 1) return fail()
    return files
  } catch { return fail() }
}
export interface ProductionGitHub {
  mainSha(): Promise<string>
  dispatch(stage: number): Promise<string>
  run(runId: string, expectedSha: string): Promise<ProductionRun>
  report(run: ProductionRun, stage: number): Promise<SampleSurveyRun>
}
/** A second manual parent must not silently reuse the same first collection and dispatch the remaining stages again. */
export function validateProductionParents(value: unknown, parentRunId: string, firstRunId: string): void {
  const input = object(value), current = id(parentRunId), first = id(firstRunId)
  if (!Number.isSafeInteger(input.total_count) || Number(input.total_count) < 1 || Number(input.total_count) > 100
    || !Array.isArray(input.workflow_runs) || input.workflow_runs.length !== input.total_count) return fail()
  const matches = input.workflow_runs.filter(value => object(value).display_title === `Sample survey production ${first}`)
  if (matches.length !== 1) return fail()
  const run = object(matches[0])
  if (id(run.id) !== current || run.run_attempt !== 1 || run.event !== 'workflow_dispatch' || run.head_branch !== 'main'
    || object(run.repository).full_name !== REPO || object(run.head_repository).full_name !== REPO) return fail()
}
export function createProductionGitHub(command: CloudGhCommand = runCloudGhCommand): ProductionGitHub {
  const api = async (path: string, extra: string[] = []): Promise<Record<string, unknown>> => {
    try { return object(JSON.parse((await command(['api', '--hostname', 'github.com', '-H', 'X-GitHub-Api-Version: 2026-03-10', path, ...extra], META_LIMIT)).toString('utf8'))) }
    catch { return fail() }
  }
  return {
    async mainSha() { return sha((await api(`${API}/commits/main`)).sha) },
    async dispatch(stage) {
      const { config } = productionStage(stage)
      // One POST only. Never resend a dispatch after an ambiguous response.
      return parseProductionDispatch(await api(`${API}/actions/workflows/${WORKFLOW}/dispatches`, ['--method', 'POST',
        '-f', 'ref=main', '-F', 'return_run_details=true', '-f', `inputs[ranks]=${config.ranks.join(',')}`,
        '-f', `inputs[rank_sample_size]=${config.rankSampleSize}`, '-f', `inputs[include_mr]=${config.includeMr}`,
        '-f', `inputs[mr_sample_size]=${config.mrSampleSize}`, '-f', `inputs[max_duration_minutes]=${config.maxDurationMinutes}`]))
    },
    async run(runId, expectedSha) { return parseProductionRun(await api(`${API}/actions/runs/${id(runId)}`), { runId, sha: expectedSha }) },
    async report(run, stage) {
      if (run.status !== 'completed' || run.conclusion !== 'success' || run.attempt !== 1) return fail()
      const listing = await api(`${API}/actions/runs/${id(run.id)}/artifacts?per_page=100`)
      if (listing.total_count !== 1 || !Array.isArray(listing.artifacts) || listing.artifacts.length !== 1) return fail()
      const artifact = object(listing.artifacts[0]), expectedName = `sample-survey-${run.id}-1`
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
      if (Date.parse(report.startedAt) < Date.parse(run.createdAt)) return fail()
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
export async function runProductionStage(options: { stage: number; sha: string; firstRunId?: string; firstRunSha?: string }, dependencies: {
  github: ProductionGitHub; now?: () => number; sleep?: (ms: number) => Promise<void>; log?: (value: unknown) => void
}): Promise<{ run: ProductionRun; report: SampleSurveyRun }> {
  const stage = productionStage(options.stage), expectedSha = sha(options.sha), { github } = dependencies
  const now = dependencies.now ?? Date.now, sleep = dependencies.sleep ?? (ms => delay(ms)), log = dependencies.log ?? (() => {})
  const start = now(), deadline = start + stage.waitMinutes * 60000
  let runId: string, runSha: string
  if (stage.stage === 1) {
    runId = id(options.firstRunId); runSha = sha(options.firstRunSha)
  } else {
    if (options.firstRunId || options.firstRunSha || await github.mainSha() !== expectedSha) return fail()
    runSha = expectedSha; runId = id(await github.dispatch(stage.stage))
  }
  log({ stage: stage.stage, runId, state: 'waiting', url: `https://github.com/${REPO}/actions/runs/${runId}` })
  while (now() <= deadline) {
    const run = await github.run(runId, runSha)
    if (Date.parse(run.createdAt) > now() || Date.parse(run.createdAt) < start - 24 * 60 * 60000) return fail()
    if (run.status === 'completed') {
      if (run.conclusion !== 'success') return fail()
      if (now() > deadline) return fail()
      const report = validateProductionReport(await github.report(run, stage.stage), stage.stage)
      log({ stage: stage.stage, runId, state: 'complete', reportId: report.id, strata: report.strata.map(row => ({ id: row.id, requested: row.requested,
        succeeded: row.succeeded, missing: row.missing, duplicates: row.duplicates })) })
      return { run, report }
    }
    if (now() + 60000 > deadline) break
    await sleep(60000)
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
  validateProductionParents(parentRuns, id(process.env.GITHUB_RUN_ID), id(process.env.PRODUCTION_FIRST_RUN_ID))
  const result = await runProductionStage({ stage, sha: sha(process.env.GITHUB_SHA),
    ...(stage === 1 ? { firstRunId: process.env.PRODUCTION_FIRST_RUN_ID, firstRunSha: process.env.PRODUCTION_FIRST_RUN_SHA } : {}) },
  { github: createProductionGitHub(), log: value => console.log(JSON.stringify({ production: value })) })
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `run_id=${result.run.id}\nreport_id=${result.report.id}\n`)
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY,
    `### ${productionStage(stage).label}\n\n[取得実行](https://github.com/${REPO}/actions/runs/${result.run.id}) — 保存・公開確認済み\n\n`
    + '| 区分 | 予定 | 有効 | 欠測 | 重複 |\n| --- | ---: | ---: | ---: | ---: |\n'
    + result.report.strata.map(row => `| ${row.label} | ${row.requested} | ${row.succeeded} | ${row.missing} | ${row.duplicates} |`).join('\n') + '\n')
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(() => { console.error('本取得の実行または保存結果を確認できないため、後続を開始しません。'); process.exitCode = 1 })
