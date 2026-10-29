import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseRankDistributionDataset, parseRankDistributionManifest, RANK_DISTRIBUTION_SOURCE } from '../../src/lib/rankDistribution.ts'
import type { RankDistributionDataset, RankDistributionManifest } from '../../src/types/rankDistribution.ts'
import { validateRankDistributionDirectory } from '../validate-rank-distribution-data.ts'
import { summarizeRankDistributionCloudCapture } from '../collect-rank-distribution-cloud.ts'
import type { RankDistributionCloudCaptureSummary } from '../collect-rank-distribution-cloud.ts'
import { mergeRankDistributionCheckpoints, parseRankDistributionCheckpoint } from './rank-distribution-checkpoint.ts'
import type { RankDistributionCheckpoint } from './rank-distribution-checkpoint.ts'
import { distributionHumanVerificationKind, parseDistributionHumanVerification } from './distribution-human-verification.ts'
import { rankDistributionAvailabilityMessage } from './rank-distribution-status.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
export const RANK_DISTRIBUTION_WEEKLY_PREVIOUS_DIRECTORY = resolve(ROOT, '.local/rank-distribution-weekly/previous')
export const RANK_DISTRIBUTION_WEEKLY_HISTORY_DIRECTORY = resolve(ROOT, '.local/rank-distribution-weekly/history')
export const RANK_DISTRIBUTION_WEEKLY_OUTPUT_DIRECTORY = resolve(ROOT, 'rank-distribution-weekly-output')
const FILE_LIMIT = 1024 * 1024
const TREE_LIMIT = 64 * 1024 * 1024
const FILE_COUNT_LIMIT = 10000
const DATASET_ID = /^max-lp(?:-estimate)?-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/
const RUN_ID = /^run-[1-9]\d{0,24}-[1-9]\d{0,5}$/
const WEEK_SECONDS = 7 * 24 * 60 * 60

export type RankDistributionWeeklyHistoryErrorCode = 'invalid-history' | 'invalid-report' | 'unsafe-path'
  | 'size-limit' | 'future-record' | 'conflict' | 'io-failed' | 'output-exists'
export class RankDistributionWeeklyHistoryError extends Error {
  readonly code: RankDistributionWeeklyHistoryErrorCode
  constructor(code: RankDistributionWeeklyHistoryErrorCode) {
    super(`週次ランク分布の履歴を安全に確認・保存できませんでした (${code})。`)
    this.name = 'RankDistributionWeeklyHistoryError'
    this.code = code
  }
}
function fail(code: RankDistributionWeeklyHistoryErrorCode): never { throw new RankDistributionWeeklyHistoryError(code) }
function sanitized(error: unknown): RankDistributionWeeklyHistoryError {
  return error instanceof RankDistributionWeeklyHistoryError ? error : new RankDistributionWeeklyHistoryError('io-failed')
}
function hasCode(error: unknown, code: string): boolean {
  return error !== null && typeof error === 'object' && 'code' in error && error.code === code
}
function object(value: unknown, keys: readonly string[], code: RankDistributionWeeklyHistoryErrorCode): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !keys.includes(key))) fail(code)
  return value as Record<string, unknown>
}
function time(value: unknown, code: RankDistributionWeeklyHistoryErrorCode = 'invalid-report'): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) fail(code)
  try { if (new Date(value).toISOString() !== value) fail(code) } catch { return fail(code) }
  return value
}
function currentTime(now: () => Date): string {
  try { return time(Date.prototype.toISOString.call(now()), 'invalid-history') } catch { return fail('invalid-history') }
}
function same(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false
  if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right)
    && left.length === right.length && left.every((item, i) => same(item, right[i]))
  const a = left as Record<string, unknown>, b = right as Record<string, unknown>
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && same(a[key], b[key]))
}

export interface RankDistributionWeeklyRunReport {
  schemaVersion: 1
  id: string
  startedAt: string
  endedAt: string
  event: 'schedule' | 'manual'
  status: 'succeeded' | 'failed'
  failureReason: null | 'authentication-unavailable' | 'collection-failed' | 'history-unavailable' | 'output-unavailable'
  sessionCapturedAt: string | null
  sessionUploadedAt: string | null
  sessionAgeSeconds: number | null
  initialSignInConfirmed: boolean
  reuseAfterSevenDays: 'pending' | 'confirmed' | 'unconfirmed'
  capture: RankDistributionCloudCaptureSummary | null
  datasetId: string | null
}

/** Reject unknown fields rather than scrubbing secrets into an otherwise successful report. */
export function parseRankDistributionWeeklyRunReport(value: unknown, now: () => Date = () => new Date()): RankDistributionWeeklyRunReport {
  try {
    const input = object(value, ['schemaVersion', 'id', 'startedAt', 'endedAt', 'event', 'status', 'failureReason',
      'sessionCapturedAt', 'sessionUploadedAt', 'sessionAgeSeconds', 'initialSignInConfirmed', 'reuseAfterSevenDays', 'capture', 'datasetId'], 'invalid-report')
    const startedAt = time(input.startedAt), endedAt = time(input.endedAt)
    if (input.schemaVersion !== 1 || typeof input.id !== 'string' || !RUN_ID.test(input.id)
      || !['schedule', 'manual'].includes(input.event as string) || !['succeeded', 'failed'].includes(input.status as string)
      || ![null, 'authentication-unavailable', 'collection-failed', 'history-unavailable', 'output-unavailable'].includes(input.failureReason as null)
      || typeof input.initialSignInConfirmed !== 'boolean' || Date.parse(endedAt) < Date.parse(startedAt)) fail('invalid-report')
    if (Date.parse(endedAt) > Date.parse(currentTime(now))) fail('future-record')
    const sessionCapturedAt = input.sessionCapturedAt === null ? null : time(input.sessionCapturedAt)
    const sessionUploadedAt = input.sessionUploadedAt === null ? null : time(input.sessionUploadedAt)
    if ((sessionCapturedAt === null) !== (sessionUploadedAt === null)) fail('invalid-report')
    const age = sessionCapturedAt === null ? null : Math.floor((Date.parse(startedAt) - Date.parse(sessionCapturedAt)) / 1000)
    if (age !== input.sessionAgeSeconds || age !== null && (!Number.isSafeInteger(age) || age < 0)
      || sessionCapturedAt !== null && (Date.parse(sessionUploadedAt!) < Date.parse(sessionCapturedAt)
        || Date.parse(sessionUploadedAt!) > Date.parse(startedAt))) fail('invalid-report')
    const reuse = !input.initialSignInConfirmed ? 'unconfirmed' : age === null || age < WEEK_SECONDS ? 'pending' : 'confirmed'
    if (input.reuseAfterSevenDays !== reuse || input.initialSignInConfirmed && sessionCapturedAt === null) fail('invalid-report')
    let capture: RankDistributionCloudCaptureSummary | null = null
    if (input.capture !== null) {
      if (typeof input.capture === 'object' && Object.hasOwn(input.capture, 'humanVerification')) {
        parseDistributionHumanVerification((input.capture as Record<string, unknown>).humanVerification)
      }
      capture = summarizeRankDistributionCloudCapture(input.capture)
      if (!same(input.capture, capture) || capture.successfulReadCount > capture.requestCount
        || !capture.startedAt || !capture.endedAt || Date.parse(capture.startedAt) < Date.parse(startedAt)
        || Date.parse(capture.endedAt) > Date.parse(endedAt) || Date.parse(capture.endedAt) < Date.parse(capture.startedAt)) fail('invalid-report')
      if (capture.totalMin !== null && capture.totalMax !== null && capture.totalMin > capture.totalMax) fail('invalid-report')
      if (capture.totalAtEnd !== null && (capture.totalMin !== null && capture.totalAtEnd < capture.totalMin
        || capture.totalMax !== null && capture.totalAtEnd > capture.totalMax)) fail('invalid-report')
    }
    if (input.initialSignInConfirmed && (!capture || capture.successfulReadCount < 1)) fail('invalid-report')
    const datasetId = input.datasetId
    if (datasetId !== null && (typeof datasetId !== 'string' || !DATASET_ID.test(datasetId))) fail('invalid-report')
    if (input.status === 'succeeded' && (input.failureReason !== null || !datasetId || !input.initialSignInConfirmed
      || capture?.status !== 'succeeded' || capture.stage !== 'complete' || capture.reason !== null || !capture.browserClosed
      || capture.confirmedBoundaryCount !== 35 || !capture.datasetSaved || !capture.published)) fail('invalid-report')
    if (input.status === 'failed' && (input.failureReason === null || datasetId !== null)) fail('invalid-report')
    return { schemaVersion: 1, id: input.id, startedAt, endedAt, event: input.event as RankDistributionWeeklyRunReport['event'],
      status: input.status as RankDistributionWeeklyRunReport['status'], failureReason: input.failureReason as RankDistributionWeeklyRunReport['failureReason'],
      sessionCapturedAt, sessionUploadedAt, sessionAgeSeconds: age, initialSignInConfirmed: input.initialSignInConfirmed,
      reuseAfterSevenDays: reuse, capture, datasetId: datasetId as string | null }
  } catch (error) { if (error instanceof RankDistributionWeeklyHistoryError) throw error; return fail('invalid-report') }
}

export interface RankDistributionWeeklyHistory {
  manifest: RankDistributionManifest
  datasets: RankDistributionDataset[]
  checkpoint: RankDistributionCheckpoint | null
  runs: RankDistributionWeeklyRunReport[]
}

function checkedHistory(value: RankDistributionWeeklyHistory, now: () => Date): RankDistributionWeeklyHistory {
  try {
    const input = object(value, ['manifest', 'datasets', 'checkpoint', 'runs'], 'invalid-history')
    const manifest = parseRankDistributionManifest(input.manifest)
    if (manifest.source.url !== RANK_DISTRIBUTION_SOURCE.url || Date.parse(manifest.generatedAt) > Date.parse(currentTime(now))
      || !Array.isArray(input.datasets) || !Array.isArray(input.runs) || manifest.datasets.length !== input.datasets.length) fail('invalid-history')
    const datasets = input.datasets.map((item, i) => {
      const descriptor = manifest.datasets[i]
      const dataset = parseRankDistributionDataset(item, descriptor)
      if (!DATASET_ID.test(dataset.id) || descriptor.path !== `${dataset.id}.json`
        || dataset.source.url !== manifest.source.url || Date.parse(dataset.generatedAt) > Date.parse(manifest.generatedAt)) fail('invalid-history')
      return dataset
    })
    const checkpoint = input.checkpoint === null ? null : parseRankDistributionCheckpoint(input.checkpoint)
    if (checkpoint && Date.parse(checkpoint.savedAt) > Date.parse(currentTime(now))) fail('future-record')
    const runs = input.runs.map(item => parseRankDistributionWeeklyRunReport(item, now))
    if (new Set(runs.map(run => run.id)).size !== runs.length) fail('conflict')
    for (const run of runs) {
      if (run.datasetId) {
        const dataset = datasets.find(dataset => dataset.id === run.datasetId)
        if (!dataset || Date.parse(dataset.captureStartedAt) < Date.parse(run.startedAt)
          || Date.parse(dataset.captureEndedAt) > Date.parse(run.endedAt)
          || run.capture?.totalAtEnd !== dataset.totalCount) fail('invalid-history')
      }
    }
    return { manifest, datasets, checkpoint, runs }
  } catch (error) { if (error instanceof RankDistributionWeeklyHistoryError) throw error; return fail('invalid-history') }
}

async function info(path: string) {
  try { return await lstat(path) } catch (error) { if (hasCode(error, 'ENOENT')) return null; throw error }
}
async function parents(path: string): Promise<void> {
  for (let current = resolve(path); ; current = dirname(current)) {
    const value = await info(current)
    if (value && (!value.isDirectory() || value.isSymbolicLink())) fail('unsafe-path')
    if (current === dirname(current)) break
  }
}
async function directory(path: string): Promise<void> {
  await parents(path)
  const value = await info(path)
  if (!value) { await mkdir(path, { recursive: true, mode: 0o700 }); await parents(path) }
}
async function json(path: string, budget: { bytes: number; files: number }): Promise<unknown> {
  await parents(dirname(path))
  const before = await info(path)
  if (!before?.isFile() || before.isSymbolicLink() || before.nlink > 1) fail('unsafe-path')
  if (before.size < 1 || before.size > FILE_LIMIT || ++budget.files > FILE_COUNT_LIMIT
    || (budget.bytes += before.size) > TREE_LIMIT) fail('size-limit')
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const opened = await handle.stat()
    if (opened.ino !== before.ino || opened.dev !== before.dev || opened.size !== before.size || opened.nlink > 1) fail('unsafe-path')
    const bytes = Buffer.alloc(before.size + 1)
    let length = 0
    while (length < bytes.length) {
      const part = await handle.read(bytes, length, bytes.length - length, null)
      if (!part.bytesRead) break
      length += part.bytesRead
    }
    const after = await handle.stat()
    if (length !== before.size || after.size !== before.size || after.nlink > 1) fail('unsafe-path')
    await parents(dirname(path))
    const linked = await info(path)
    if (!linked?.isFile() || linked.isSymbolicLink() || linked.ino !== before.ino || linked.dev !== before.dev || linked.size !== before.size) fail('unsafe-path')
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length))) } catch { return fail('invalid-history') }
  } finally { await handle.close() }
}
async function names(path: string): Promise<string[]> {
  await parents(path)
  const values = await readdir(path, { withFileTypes: true })
  if (values.length > FILE_COUNT_LIMIT || values.some(value => value.isSymbolicLink() || !value.isFile() && !value.isDirectory())) fail('unsafe-path')
  return values.map(value => value.name).sort()
}

/** The Git checkout's .git entry is never traversed, read, copied or uploaded. */
export async function loadWeeklyHistory(directoryPath = RANK_DISTRIBUTION_WEEKLY_PREVIOUS_DIRECTORY,
  now: () => Date = () => new Date(), options: { allowGit?: boolean; requirePresent?: boolean } = {}): Promise<RankDistributionWeeklyHistory> {
  try {
    const root = resolve(directoryPath)
    await parents(root)
    const files = await info(root) ? await names(root) : []
    if (!files.length && options.requirePresent) fail('invalid-history')
    if (files.some(name => !['data', 'checkpoint.json', 'runs', ...(options.allowGit === false ? [] : ['.git'])].includes(name))) fail('invalid-history')
    const budget = { bytes: 0, files: 0 }
    let manifest = parseRankDistributionManifest({ schemaVersion: 1, generatedAt: currentTime(now), source: RANK_DISTRIBUTION_SOURCE, datasets: [] })
    const datasets: RankDistributionDataset[] = []
    if (files.includes('data')) {
      const data = resolve(root, 'data')
      const dataFiles = await names(data)
      manifest = parseRankDistributionManifest(await json(resolve(data, 'index.json'), budget))
      if (dataFiles.length !== manifest.datasets.length + 1
        || dataFiles.some(name => name !== 'index.json' && !manifest.datasets.some(item => item.path === name))) fail('invalid-history')
      for (const descriptor of manifest.datasets) datasets.push(parseRankDistributionDataset(await json(resolve(data, descriptor.path), budget), descriptor))
      await validateRankDistributionDirectory(data)
    } else if (files.some(name => name !== '.git')) fail('invalid-history')
    const checkpoint = files.includes('checkpoint.json') ? parseRankDistributionCheckpoint(await json(resolve(root, 'checkpoint.json'), budget)) : null
    const runs: RankDistributionWeeklyRunReport[] = []
    if (files.includes('runs')) {
      for (const name of await names(resolve(root, 'runs'))) {
        if (!name.endsWith('.json') || !RUN_ID.test(name.slice(0, -5))) fail('invalid-history')
        const run = parseRankDistributionWeeklyRunReport(await json(resolve(root, 'runs', name), budget), now)
        if (name !== `${run.id}.json`) fail('invalid-history')
        runs.push(run)
      }
    }
    return checkedHistory({ manifest, datasets, checkpoint, runs }, now)
  } catch (error) { throw sanitized(error) }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await parents(dirname(path))
  const text = `${JSON.stringify(value, null, 2)}\n`
  if (Buffer.byteLength(text, 'utf8') > FILE_LIMIT) fail('size-limit')
  const handle = await open(path, 'wx', 0o600)
  try { await handle.writeFile(text, 'utf8'); await handle.sync() } finally { await handle.close() }
}

export interface WriteWeeklyHistoryOutputOptions {
  previous: RankDistributionWeeklyHistory
  run: RankDistributionWeeklyRunReport
  dataset?: RankDistributionDataset
  checkpoint?: RankDistributionCheckpoint | null
  /** Isolated tests may choose their own directory; production callers use the fixed default. */
  directory?: string
  now?: () => Date
}

/** A new complete snapshot is staged once; callers authorize uploads only after this returns. */
export async function writeWeeklyHistoryOutput(options: WriteWeeklyHistoryOutputOptions): Promise<RankDistributionWeeklyHistory> {
  try {
    object(options, ['previous', 'run', 'dataset', 'checkpoint', 'directory', 'now'], 'invalid-history')
    const now = options.now ?? (() => new Date())
    const previous = checkedHistory(options.previous, now)
    const run = parseRankDistributionWeeklyRunReport(options.run, now)
    if ((run.status === 'succeeded') !== (options.dataset !== undefined)) fail('invalid-history')
    const dataset = options.dataset === undefined ? undefined : parseRankDistributionDataset(options.dataset)
    if (dataset && (dataset.id !== run.datasetId || dataset.method !== 'boundary-search-estimate'
      || Date.parse(dataset.captureStartedAt) < Date.parse(run.startedAt) || Date.parse(dataset.captureEndedAt) > Date.parse(run.endedAt))) fail('invalid-history')
    const datasets = [...previous.datasets]
    if (dataset) {
      const prior = datasets.find(item => item.id === dataset.id || item.captureStartedAt === dataset.captureStartedAt && item.captureEndedAt === dataset.captureEndedAt)
      if (prior && !same(prior, dataset)) fail('conflict')
      if (!prior) datasets.push(dataset)
    }
    datasets.sort((a, b) => Date.parse(b.captureEndedAt) - Date.parse(a.captureEndedAt) || a.id.localeCompare(b.id))
    const existingRun = previous.runs.find(item => item.id === run.id)
    if (existingRun && !same(existingRun, run)) fail('conflict')
    const runs = existingRun ? previous.runs : [...previous.runs, run].sort((a, b) => a.id.localeCompare(b.id))
    const checkpoint = options.checkpoint ? mergeRankDistributionCheckpoints(previous.checkpoint, options.checkpoint) : previous.checkpoint
    const protectionKind = run.status === 'failed'
      ? distributionHumanVerificationKind(run.capture?.humanVerification, run.capture?.readFailureCode) : null
    const manifest = parseRankDistributionManifest({ schemaVersion: 1, generatedAt: currentTime(now),
      source: datasets.length ? { url: datasets[0].source.url, title: datasets[0].source.title } : previous.manifest.source,
      datasets: datasets.map(item => ({ id: item.id, path: `${item.id}.json`,
        captureStartedAt: item.captureStartedAt, captureEndedAt: item.captureEndedAt, totalCount: item.totalCount })),
      ...(protectionKind ? { availability: { status: 'collection-failed', checkedAt: run.endedAt,
        message: rankDistributionAvailabilityMessage(protectionKind) } } : {}) })
    const next = checkedHistory({ manifest, datasets, checkpoint, runs }, now)
    const output = resolve(options.directory ?? RANK_DISTRIBUTION_WEEKLY_OUTPUT_DIRECTORY)
    await directory(dirname(output))
    if (await info(output)) fail('output-exists')
    await mkdir(output, { mode: 0o700 })
    // The collector has already used the existing importer for its new capture.
    // This is a new snapshot, so serialize the validated history without replacing
    // a live directory; the shared directory validator checks it before upload.
    await directory(resolve(output, 'data'))
    for (const item of datasets) await writeJson(resolve(output, 'data', `${item.id}.json`), item)
    await writeJson(resolve(output, 'data/index.json'), manifest)
    await directory(resolve(output, 'runs'))
    for (const item of runs) await writeJson(resolve(output, 'runs', `${item.id}.json`), item)
    if (checkpoint) await writeJson(resolve(output, 'checkpoint.json'), checkpoint)
    const saved = await loadWeeklyHistory(output, now, { allowGit: false, requirePresent: true })
    if (!same(saved, next)) fail('invalid-history')
    return saved
  } catch (error) { throw sanitized(error) }
}
