import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { parseMrDistributionDataset, parseMrDistributionManifest } from '../src/lib/mrDistribution.ts'
import type { MrDistributionDataset, MrDistributionManifest } from '../src/types/mrDistribution.ts'
import { isAllowedMrWeeklyExecution, parseMrWeeklyRunReport } from './collect-mr-distribution-weekly.ts'
import type { MrWeeklyRunReport } from './collect-mr-distribution-weekly.ts'
import { importMrDistributionData } from './import-mr-distribution-data.ts'
import { mrDistributionPathWithin, validateMrDistributionDirectory } from './validate-mr-distribution-data.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const MR_WEEKLY_INCOMING = resolve(ROOT, '.local/mr-distribution-weekly/incoming')
export const MR_WEEKLY_HISTORY = resolve(ROOT, '.local/mr-distribution-weekly/history')
const SEED = resolve(ROOT, 'public/data/mr-distribution')
const DATA_FILE = /^max-mr-estimate-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.json$/
const RUN_FILE = /^run-[1-9]\d{0,24}-[1-9]\d{0,5}\.json$/
const MAX_FILE_BYTES = 1024 * 1024

interface PublicData { manifest: MrDistributionManifest; datasets: MrDistributionDataset[] }
interface History { data: PublicData | null; runs: MrWeeklyRunReport[] }

export class MrWeeklyPublishError extends Error {
  constructor() { super('MR分布の履歴を安全に反映できませんでした。以前の正常データを保持してください。'); this.name = 'MrWeeklyPublishError' }
}
function fail(): never { throw new MrWeeklyPublishError() }
async function inspect(path: string) {
  try { return await lstat(path) } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null
    throw error
  }
}
async function checkParents(path: string): Promise<void> {
  for (let current = resolve(path); ; current = dirname(current)) {
    const stat = await inspect(current)
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) fail()
    if (current === dirname(current)) return
  }
}
async function flatFiles(path: string, allowed: (name: string) => boolean): Promise<string[]> {
  await checkParents(path)
  const files = await readdir(path, { withFileTypes: true })
  for (const file of files) {
    if (!file.isFile() || file.isSymbolicLink() || !allowed(file.name)) fail()
    const stat = await lstat(resolve(path, file.name))
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1 || stat.size < 1 || stat.size > MAX_FILE_BYTES) fail()
  }
  return files.map(file => file.name).sort()
}
async function json(path: string): Promise<unknown> {
  const stat = await lstat(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1 || stat.size < 1 || stat.size > MAX_FILE_BYTES) fail()
  const bytes = await readFile(path)
  if (bytes.length !== stat.size || bytes.length > MAX_FILE_BYTES) fail()
  return JSON.parse(bytes.toString('utf8'))
}
async function readPublic(directory: string): Promise<PublicData> {
  const files = await flatFiles(directory, name => name === 'index.json' || DATA_FILE.test(name))
  await validateMrDistributionDirectory(directory)
  const manifest = parseMrDistributionManifest(await json(resolve(directory, 'index.json')))
  if (!isDeepStrictEqual(files, ['index.json', ...manifest.datasets.map(item => item.path)].sort())) fail()
  const datasets = await Promise.all(manifest.datasets.map(async descriptor =>
    parseMrDistributionDataset(await json(resolve(directory, descriptor.path)), descriptor)))
  return { manifest, datasets }
}
async function readHistory(directory: string, incoming = false): Promise<History> {
  await checkParents(directory)
  if (!await inspect(directory)) { if (incoming) fail(); return { data: null, runs: [] } }
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !['public', 'runs', ...(!incoming ? ['.git'] : [])].includes(entry.name)) fail()
  }
  const hasPublic = entries.some(entry => entry.name === 'public')
  const hasRuns = entries.some(entry => entry.name === 'runs')
  if (!hasPublic) {
    if (hasRuns || incoming) fail()
    return { data: null, runs: [] }
  }
  const data = await readPublic(resolve(directory, 'public'))
  const runs = hasRuns ? await Promise.all((await flatFiles(resolve(directory, 'runs'), name => RUN_FILE.test(name))).map(async name => {
    const run = parseMrWeeklyRunReport(await json(resolve(directory, 'runs', name)))
    if (`${run.id}.json` !== name || Date.parse(run.endedAt) > Date.parse(data.manifest.generatedAt)) fail()
    if (run.status === 'succeeded' && !data.datasets.some(dataset => dataset.id === run.datasetId)) fail()
    return run
  })) : []
  if (incoming && runs.length !== 1) fail()
  return { data, runs }
}
function validateIncoming(history: History, expectedRunId?: string): { data: PublicData; run: MrWeeklyRunReport } {
  const data = history.data
  if (!data || history.runs.length !== 1) fail()
  const run = history.runs[0]
  if (expectedRunId && run.id !== expectedRunId) fail()
  if (run.status === 'succeeded') {
    const dataset = data.datasets[0]
    if (data.datasets.length !== 1 || dataset.id !== run.datasetId || data.manifest.availability || !run.capture
      || Date.parse(dataset.captureStartedAt) < Date.parse(run.capture.startedAt)
      || Date.parse(dataset.captureEndedAt) > Date.parse(run.capture.endedAt)
      || Date.parse(dataset.generatedAt) > Date.parse(run.endedAt)) fail()
  } else if (data.datasets.length || data.manifest.availability?.status !== 'collection-failed'
    || data.manifest.availability.checkedAt !== run.endedAt) fail()
  return { data, run }
}
async function writeJson(path: string, value: unknown): Promise<void> {
  const text = `${JSON.stringify(value, null, 2)}\n`
  if (Buffer.byteLength(text, 'utf8') > MAX_FILE_BYTES) fail()
  await writeFile(path, text, { flag: 'wx', mode: 0o600 })
}

export interface PublishMrWeeklyOptions {
  /** Production entry point uses fixed paths. Overrides isolate filesystem tests. */
  inputDirectory?: string
  historyDirectory?: string
  seedDirectory?: string
  expectedRunId?: string
  now?: () => Date
}

/** Validate the entire batch, preserve immutable captures, then replace public/runs with rollback. */
export async function publishMrWeekly(options: PublishMrWeeklyOptions = {}): Promise<{ datasets: number; entries: number; runs: number }> {
  const input = resolve(options.inputDirectory ?? MR_WEEKLY_INCOMING)
  const destination = resolve(options.historyDirectory ?? MR_WEEKLY_HISTORY)
  const parent = dirname(destination)
  if (destination === parent || input === destination || mrDistributionPathWithin(input, destination)
    || mrDistributionPathWithin(destination, input)) fail()
  let work: string | undefined
  let locked = false
  let keepWork = false
  const lock = resolve(parent, `.${destination.split(/[\\/]/).at(-1)}-mr-publish.lock`)
  try {
    const incoming = validateIncoming(await readHistory(input, true), options.expectedRunId)
    const previous = await readHistory(destination)
    const seedPath = resolve(options.seedDirectory ?? SEED)
    const base = previous.data ?? await readPublic(seedPath)
    const generatedAt = (options.now ?? (() => new Date()))().toISOString()
    if (Date.parse(generatedAt) < Math.max(Date.parse(base.manifest.generatedAt), Date.parse(incoming.data.manifest.generatedAt))) fail()
    if (base.manifest.source.url !== incoming.data.manifest.source.url) fail()
    const existingRun = previous.runs.find(run => run.id === incoming.run.id)
    for (const dataset of incoming.data.datasets) {
      const existing = base.datasets.find(item => item.id === dataset.id)
      if (existing && !isDeepStrictEqual(existing, dataset)) fail()
      if (base.datasets.some(item => item.id !== dataset.id && Date.parse(item.captureStartedAt) === Date.parse(dataset.captureStartedAt)
        && Date.parse(item.captureEndedAt) === Date.parse(dataset.captureEndedAt))) fail()
    }
    if (existingRun) {
      if (!isDeepStrictEqual(existingRun, incoming.run)
        || incoming.data.datasets.some(dataset => !isDeepStrictEqual(base.datasets.find(item => item.id === dataset.id), dataset))) fail()
      return { datasets: base.datasets.length, entries: base.datasets.length * 26, runs: previous.runs.length }
    }
    if (previous.runs.some(run => Date.parse(run.endedAt) > Date.parse(incoming.run.endedAt))) fail()
    await checkParents(parent)
    await mkdir(parent, { recursive: true })
    await writeFile(lock, `${process.pid}\n`, { flag: 'wx', mode: 0o600 }); locked = true
    work = await mkdtemp(resolve(parent, '.mr-publish-'))
    if (!mrDistributionPathWithin(parent, work)) fail()
    const stage = resolve(work, 'stage')
    await mkdir(stage)
    const publicStage = resolve(stage, 'public')
    if (base.datasets.length) await importMrDistributionData(previous.data ? resolve(destination, 'public') : seedPath, publicStage, generatedAt)
    else { await mkdir(publicStage); await writeJson(resolve(publicStage, 'index.json'), { ...base.manifest, generatedAt }) }
    for (const dataset of incoming.data.datasets) {
      if (!base.datasets.some(item => item.id === dataset.id)) {
        const descriptor = incoming.data.manifest.datasets.find(item => item.id === dataset.id)!
        await importMrDistributionData(resolve(input, 'public', descriptor.path), publicStage, generatedAt)
      }
    }
    const staged = await readPublic(publicStage)
    const manifest = parseMrDistributionManifest({ ...staged.manifest, generatedAt,
      ...(incoming.run.status === 'failed' ? { availability: { status: 'collection-failed', checkedAt: incoming.run.endedAt,
        message: 'MR分布の取得を完了できませんでした。前回の正常データを保持しています。' } } : {}) })
    if (incoming.run.status === 'succeeded') delete manifest.availability
    await writeFile(resolve(publicStage, 'index.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    await mkdir(resolve(stage, 'runs'))
    for (const run of [...previous.runs, incoming.run]) await writeJson(resolve(stage, 'runs', `${run.id}.json`), run)
    const next = await readHistory(stage)
    if (!next.data || next.runs.length !== previous.runs.length + 1) fail()
    if (!isDeepStrictEqual(previous, await readHistory(destination))) fail()
    await checkParents(destination)
    await mkdir(destination, { recursive: true })
    const moved: Array<{ name: string; backup: boolean; installed: boolean }> = []
    try {
      // Preserve the Git checkout itself. Both directories are validated before either is replaced.
      for (const name of ['runs', 'public']) {
        const state = { name, backup: false, installed: false }; moved.push(state)
        const target = resolve(destination, name)
        if (await inspect(target)) { await rename(target, resolve(work, `backup-${name}`)); state.backup = true }
        await rename(resolve(stage, name), target); state.installed = true
      }
      if (!isDeepStrictEqual(next, await readHistory(destination))) fail()
    } catch (error) {
      try {
        for (const state of [...moved].reverse()) {
          if (state.installed) await rename(resolve(destination, state.name), resolve(stage, state.name))
          if (state.backup) await rename(resolve(work, `backup-${state.name}`), resolve(destination, state.name))
        }
      } catch { keepWork = true }
      throw error
    }
    return { datasets: next.data.datasets.length, entries: next.data.datasets.length * 26, runs: next.runs.length }
  } catch { throw new MrWeeklyPublishError() }
  finally {
    if (work && !keepWork && mrDistributionPathWithin(parent, work)) await rm(work, { recursive: true, force: true }).catch(() => {})
    if (locked && !keepWork) await unlink(lock).catch(() => {})
  }
}

export async function main(args = process.argv.slice(2), dependencies: {
  env?: Record<string, string | undefined>; publish?: typeof publishMrWeekly; log?: (value: string) => void
} = {}): Promise<void> {
  const env = dependencies.env ?? process.env
  if (args.length || !isAllowedMrWeeklyExecution(env) || !/^[1-9]\d{0,24}$/.test(env.GITHUB_RUN_ID ?? '')
    || !/^[1-9]\d{0,5}$/.test(env.GITHUB_RUN_ATTEMPT ?? '')) fail()
  const result = await (dependencies.publish ?? publishMrWeekly)({ expectedRunId: `run-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}` })
  ;(dependencies.log ?? console.log)(JSON.stringify(result))
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { console.error(new MrWeeklyPublishError().message); process.exitCode = 1 })
}
