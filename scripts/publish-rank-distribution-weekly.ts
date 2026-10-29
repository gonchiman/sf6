import { constants } from 'node:fs'
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  loadWeeklyHistory, RANK_DISTRIBUTION_WEEKLY_HISTORY_DIRECTORY, RANK_DISTRIBUTION_WEEKLY_OUTPUT_DIRECTORY,
  RankDistributionWeeklyHistoryError,
} from './lib/rank-distribution-weekly-history.ts'
import type { RankDistributionWeeklyHistory } from './lib/rank-distribution-weekly-history.ts'

const MAXIMUM_FILE_BYTES = 1024 * 1024
const FILES = /^(?:data\/(?:index|max-lp(?:-estimate)?-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)\.json|checkpoint\.json|runs\/run-[1-9]\d{0,24}-[1-9]\d{0,5}\.json)$/
export type RankDistributionWeeklyPublishErrorCode = 'arguments' | 'runner' | 'input' | 'history' | 'conflict' | 'write-failed'
export class RankDistributionWeeklyPublishError extends Error {
  readonly code: RankDistributionWeeklyPublishErrorCode
  constructor(code: RankDistributionWeeklyPublishErrorCode) {
    super(`週次ランク分布の履歴反映を完了できませんでした (${code})。`)
    this.name = 'RankDistributionWeeklyPublishError'
    this.code = code
  }
}
function fail(code: RankDistributionWeeklyPublishErrorCode): never { throw new RankDistributionWeeklyPublishError(code) }
function same(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false
  if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right)
    && left.length === right.length && left.every((value, index) => same(value, right[index]))
  const a = left as Record<string, unknown>, b = right as Record<string, unknown>
  return Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(key => Object.hasOwn(b, key) && same(a[key], b[key]))
}
async function inspect(path: string) {
  try { return await lstat(path) } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null
    throw error
  }
}
async function checkParents(path: string): Promise<void> {
  for (let current = resolve(path); ; current = dirname(current)) {
    const stat = await inspect(current)
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) fail('write-failed')
    if (current === dirname(current)) break
  }
}
async function makeDirectory(path: string): Promise<void> {
  await checkParents(path)
  await mkdir(path, { recursive: true, mode: 0o700 })
  await checkParents(path)
}
function snapshotFiles(history: RankDistributionWeeklyHistory): Map<string, unknown> {
  const files = new Map<string, unknown>([['data/index.json', history.manifest]])
  for (const dataset of history.datasets) files.set(`data/${dataset.id}.json`, dataset)
  for (const run of history.runs) files.set(`runs/${run.id}.json`, run)
  if (history.checkpoint) files.set('checkpoint.json', history.checkpoint)
  return files
}
function preservesHistory(previous: RankDistributionWeeklyHistory, incoming: RankDistributionWeeklyHistory): void {
  for (const dataset of previous.datasets) {
    if (!same(dataset, incoming.datasets.find(value => value.id === dataset.id))) fail('conflict')
  }
  for (const run of previous.runs) {
    if (!same(run, incoming.runs.find(value => value.id === run.id))) fail('conflict')
  }
  for (const dataset of incoming.datasets) {
    if (!previous.datasets.some(value => value.id === dataset.id)
      && !incoming.runs.some(run => run.status === 'succeeded' && run.datasetId === dataset.id)) fail('conflict')
  }
  if (Date.parse(incoming.manifest.generatedAt) < Date.parse(previous.manifest.generatedAt)
    && (previous.datasets.length || previous.runs.length)) fail('conflict')
  if (previous.checkpoint) {
    if (!incoming.checkpoint || previous.checkpoint.pageSize !== incoming.checkpoint.pageSize
      || Date.parse(incoming.checkpoint.savedAt) < Date.parse(previous.checkpoint.savedAt)) fail('conflict')
    for (const hint of previous.checkpoint.hints) {
      const next = incoming.checkpoint.hints.find(value => value.rankId === hint.rankId)
      if (!next || Date.parse(next.observedAt) < Date.parse(hint.observedAt)
        || Date.parse(next.observedAt) === Date.parse(hint.observedAt) && (next.countAtOrAbove !== hint.countAtOrAbove || next.totalCount !== hint.totalCount)) fail('conflict')
    }
  }
}

export interface PublishRankDistributionWeeklyOptions {
  /** Production entry point always uses the fixed directories; overrides isolate filesystem tests. */
  inputDirectory?: string
  historyDirectory?: string
  now?: () => Date
}

/** Copy a fully validated aggregate snapshot only. Git staging, commit and push belong to the workflow. */
export async function publishRankDistributionWeekly(options: PublishRankDistributionWeeklyOptions = {}): Promise<{
  datasets: number; entries: number; runs: number; checkpointHints: number
}> {
  const input = resolve(options.inputDirectory ?? RANK_DISTRIBUTION_WEEKLY_OUTPUT_DIRECTORY)
  const destination = resolve(options.historyDirectory ?? RANK_DISTRIBUTION_WEEKLY_HISTORY_DIRECTORY)
  const now = options.now ?? (() => new Date())
  let incoming: RankDistributionWeeklyHistory
  let previous: RankDistributionWeeklyHistory
  try { incoming = await loadWeeklyHistory(input, now, { allowGit: false, requirePresent: true }) }
  catch { return fail('input') }
  try { previous = await loadWeeklyHistory(destination, now) } catch { return fail('history') }
  preservesHistory(previous, incoming)
  const files = snapshotFiles(incoming)
  const oldFiles = snapshotFiles(previous)
  const pending: Array<{ temporary: string; target: string }> = []
  try {
    await makeDirectory(destination)
    // New immutable data/run records are written before mutable checkpoint/index.
    const ordered = [...files.entries()].sort(([a], [b]) => Number(a === 'data/index.json') - Number(b === 'data/index.json'))
    for (const [name, value] of ordered) {
      if (!FILES.test(name)) fail('input')
      const target = resolve(destination, ...name.split('/'))
      await checkParents(dirname(target))
      const stat = await inspect(target)
      if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1)) fail('write-failed')
      if (stat && same(oldFiles.get(name), value)) continue
      if (stat && name !== 'checkpoint.json' && name !== 'data/index.json') fail('conflict')
      const temporary = resolve(dirname(destination), `.weekly-publish-${randomUUID()}.tmp`)
      if (await inspect(temporary)) fail('write-failed')
      const text = `${JSON.stringify(value, null, 2)}\n`
      if (Buffer.byteLength(text, 'utf8') > MAXIMUM_FILE_BYTES) fail('input')
      const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
      pending.push({ temporary, target })
      try { await file.writeFile(text, 'utf8'); await file.sync() } finally { await file.close() }
    }
    // Refuse a cooperative or external update before changing the checkout.
    const current = await loadWeeklyHistory(destination, now)
    if (!same(current, previous) && (previous.datasets.length || previous.runs.length || previous.checkpoint
      || current.datasets.length || current.runs.length || current.checkpoint)) fail('conflict')
    for (const { temporary, target } of pending) {
      await makeDirectory(dirname(target))
      const staged = await inspect(temporary)
      const existing = await inspect(target)
      if (!staged?.isFile() || staged.isSymbolicLink() || staged.nlink > 1
        || existing && (!existing.isFile() || existing.isSymbolicLink() || existing.nlink > 1)) fail('write-failed')
      for (let attempt = 0; ; attempt++) {
        try { await rename(temporary, target); break } catch (error) {
          const code = error && typeof error === 'object' && 'code' in error ? error.code : null
          if (attempt >= 3 || !['EPERM', 'EBUSY'].includes(code as string)) throw error
          await delay(40 * 2 ** attempt)
          await checkParents(dirname(target))
          const retry = await inspect(target)
          if (retry && (!retry.isFile() || retry.isSymbolicLink() || retry.nlink > 1)) fail('write-failed')
        }
      }
    }
    const result = await loadWeeklyHistory(destination, now, { requirePresent: true })
    if (!same(result, incoming)) fail('write-failed')
    return { datasets: result.datasets.length, entries: result.datasets.length * 36,
      runs: result.runs.length, checkpointHints: result.checkpoint?.hints.length ?? 0 }
  } catch (error) {
    if (error instanceof RankDistributionWeeklyPublishError) throw error
    throw new RankDistributionWeeklyPublishError(error instanceof RankDistributionWeeklyHistoryError ? 'history' : 'write-failed')
  } finally {
    for (const { temporary } of pending) {
      try { await checkParents(dirname(temporary)); const stat = await inspect(temporary); if (stat?.isFile() && !stat.isSymbolicLink()) await unlink(temporary) } catch { /* A failed checkout is never authorized for commit. */ }
    }
  }
}

type Environment = Record<string, string | undefined>
export async function main(args = process.argv.slice(2), dependencies: {
  env?: Environment; publish?: typeof publishRankDistributionWeekly; write?: (text: string) => void
} = {}): Promise<void> {
  if (args.length) fail('arguments')
  const env = dependencies.env ?? process.env
  if (env.GITHUB_ACTIONS !== 'true' || env.RUNNER_ENVIRONMENT !== 'github-hosted'
    || env.RUNNER_OS !== 'Windows'
    || env.GITHUB_REPOSITORY !== 'gonchiman/sf6' || env.GITHUB_REF !== 'refs/heads/main'
    || env.GITHUB_WORKFLOW_REF !== 'gonchiman/sf6/.github/workflows/rank-distribution-weekly.yml@refs/heads/main'
    || !['schedule', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME ?? '')) fail('runner')
  const result = await (dependencies.publish ?? publishRankDistributionWeekly)()
  ;(dependencies.write ?? console.log)(JSON.stringify(result))
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(error instanceof RankDistributionWeeklyPublishError ? error.message : '週次ランク分布の履歴反映を完了できませんでした。')
    process.exitCode = 1
  })
}
