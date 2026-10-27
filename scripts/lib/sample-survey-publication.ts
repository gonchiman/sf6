import { mkdir, mkdtemp, readdir, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { SAMPLE_SURVEY_RESULTS_SOURCE, SAMPLE_SURVEY_RESULTS_MAX_DATASETS, SAMPLE_SURVEY_RESULTS_MAX_JSON_BYTES, parseSampleSurveyResultsManifest, parseSampleSurveyResultsRun } from '../../src/lib/sampleSurveyResults.ts'
import type { SampleSurveyRun } from '../../src/types/sampleSurvey.ts'
// Reuse the established bounded/no-link aggregate-file IO, with this feed's smaller size limit.
import { checkLegendAnalysisParents as checkParents, legendAnalysisFileInfo as fileInfo, legendAnalysisPathWithin as within, readLegendAnalysisJson as readJson } from './legend-analysis-files.ts'

const fail = (): never => { throw new Error('標本調査の集計履歴を安全に確認・保存できません。') }
function descriptor(run: SampleSurveyRun) {
  return { id: run.id, path: `runs/${run.id}.json`, captureStartedAt: run.startedAt, captureEndedAt: run.finishedAt }
}
/** Incomplete, changed or partially missing samples must never replace a successful history. */
export function publishableSampleSurveyRun(value: unknown): SampleSurveyRun {
  const run = parseSampleSurveyResultsRun(value)
  if (run.frameChanged || run.strata.some(row => row.missing !== 0 || row.duplicates !== 0)) fail()
  return run
}
async function boundedJson(path: string): Promise<unknown> {
  const info = await fileInfo(path)
  if (!info || info.size > SAMPLE_SURVEY_RESULTS_MAX_JSON_BYTES) fail()
  return readJson(path)
}
async function json(path: string, value: unknown): Promise<void> {
  const text = `${JSON.stringify(value, null, 2)}\n`
  if (Buffer.byteLength(text) > SAMPLE_SURVEY_RESULTS_MAX_JSON_BYTES) fail()
  await writeFile(path, text, { flag: 'wx', mode: 0o600 })
}
async function readDirectory(path: string): Promise<{ generatedAt: string; runs: SampleSurveyRun[] }> {
  await checkParents(path)
  if (!(await fileInfo(path))?.isDirectory()) fail()
  const names = (await readdir(path)).sort()
  if (!isDeepStrictEqual(names, ['index.json', 'runs'])) fail()
  const manifest = parseSampleSurveyResultsManifest(await boundedJson(resolve(path, 'index.json')))
  await checkParents(resolve(path, 'runs'))
  const files = (await readdir(resolve(path, 'runs'))).sort()
  if (!isDeepStrictEqual(files, manifest.datasets.map(item => `${item.id}.json`).sort())) fail()
  const runs: SampleSurveyRun[] = []
  for (const item of manifest.datasets) {
    const run = publishableSampleSurveyRun(parseSampleSurveyResultsRun(await boundedJson(resolve(path, item.path)), item))
    if (Date.parse(run.updatedAt) > Date.parse(manifest.generatedAt)) fail()
    runs.push(run)
  }
  return { generatedAt: manifest.generatedAt, runs }
}
export async function validateSampleSurveyResultsDirectory(path: string): Promise<{ datasets: number }> {
  return { datasets: (await readDirectory(resolve(path))).runs.length }
}
async function move(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try { await rename(from, to); return } catch (error) {
      if (attempt >= 3 || !error || typeof error !== 'object' || !('code' in error)
        || !['EPERM', 'EACCES', 'EBUSY'].includes(String(error.code))) throw error
      await delay(50 * (attempt + 1))
    }
  }
}
/** Writes only reconstructed aggregate reports. Private checkpoints are never accepted here. */
export async function writeSampleSurveyResults(runs: unknown[], output: string, generatedAt = new Date().toISOString()): Promise<{ datasets: number }> {
  const incoming = runs.map(publishableSampleSurveyRun)
  if (!incoming.length || incoming.length > SAMPLE_SURVEY_RESULTS_MAX_DATASETS || new Set(incoming.map(run => run.id)).size !== incoming.length) fail()
  const directory = resolve(output), parent = dirname(directory)
  if (!within(parent, directory)) fail()
  await checkParents(directory)
  await mkdir(parent, { recursive: true, mode: 0o700 })
  await checkParents(parent)
  const lock = resolve(parent, `.${basename(directory)}-import.lock`)
  await writeFile(lock, `${process.pid}\n`, { flag: 'wx', mode: 0o600 })
  let work: string | undefined, originalMoved = false, committed = false
  try {
    const hasOriginal = (await fileInfo(directory)) !== null
    const previous = hasOriginal ? await readDirectory(directory) : { generatedAt, runs: [] }
    if (Date.parse(previous.generatedAt) > Date.parse(generatedAt)) fail()
    const selected = new Map(previous.runs.map(run => [run.id, run]))
    for (const run of incoming) {
      const existing = selected.get(run.id)
      if (existing && !isDeepStrictEqual(existing, run)) fail()
      selected.set(run.id, run)
    }
    const retained = [...selected.values()].sort((a, b) => Date.parse(b.finishedAt!) - Date.parse(a.finishedAt!) || a.id.localeCompare(b.id)).slice(0, SAMPLE_SURVEY_RESULTS_MAX_DATASETS)
    if (retained.some(run => Date.parse(run.updatedAt) > Date.parse(generatedAt))) fail()
    const manifest = parseSampleSurveyResultsManifest({ schemaVersion: 1, generatedAt, source: SAMPLE_SURVEY_RESULTS_SOURCE, datasets: retained.map(descriptor) })
    work = await mkdtemp(resolve(parent, `.${basename(directory)}-import-`))
    if (!within(parent, work)) fail()
    const stage = resolve(work, 'stage'), backup = resolve(work, 'backup')
    await mkdir(resolve(stage, 'runs'), { recursive: true, mode: 0o700 })
    for (const run of retained) await json(resolve(stage, 'runs', `${run.id}.json`), run)
    await json(resolve(stage, 'index.json'), manifest)
    const result = await validateSampleSurveyResultsDirectory(stage)
    await checkParents(directory)
    if (hasOriginal) { await move(directory, backup); originalMoved = true }
    await move(stage, directory)
    committed = true
    return result
  } catch (error) {
    if (work && originalMoved && !committed) {
      try { await move(resolve(work, 'backup'), directory); originalMoved = false }
      catch { throw new Error('標本調査の旧履歴を作業フォルダーに保持しています。復旧が必要です。') }
    }
    throw error
  } finally {
    if (work && (!originalMoved || committed) && within(parent, work) && basename(work).startsWith(`.${basename(directory)}-import-`)) {
      await rm(work, { recursive: true, force: true }).catch(() => {})
    }
    await unlink(lock).catch(() => {})
  }
}
export async function publishSampleSurveyResults(input: string, output: string, generatedAt = new Date().toISOString()): Promise<{ datasets: number }> {
  const incoming = await readDirectory(resolve(input))
  if (Date.parse(incoming.generatedAt) > Date.parse(generatedAt)) fail()
  return writeSampleSurveyResults(incoming.runs, output, generatedAt)
}
