import { mkdir, mkdtemp, readdir, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { LEGEND_ANALYSIS_SOURCE, parseLegendAnalysisDataset, parseLegendAnalysisManifest } from '../src/lib/legendAnalysis.ts'
import type { LegendAnalysisAvailability, LegendAnalysisDataset, LegendAnalysisDescriptor, LegendAnalysisManifest } from '../src/types/legendAnalysis.ts'
import { checkLegendAnalysisParents, LEGEND_ANALYSIS_JSON_LIMIT, legendAnalysisFileInfo, legendAnalysisPathWithin, readLegendAnalysisJson } from './lib/legend-analysis-files.ts'
import { validateLegendAnalysisDirectory } from './validate-legend-analysis-data.ts'

function descriptor(value: LegendAnalysisDataset): LegendAnalysisDescriptor {
  return { id: value.id, path: `${value.id}.json`, actId: value.act.id, definitionVersion: value.definitionVersion,
    membershipRule: value.membershipRule, conditions: value.conditions, captureStartedAt: value.captureStartedAt,
    captureEndedAt: value.captureEndedAt, totalCount: value.totalCount }
}
async function datasetsAt(input: string): Promise<LegendAnalysisDataset[]> {
  const root = resolve(input)
  await checkLegendAnalysisParents(dirname(root))
  const value = await legendAnalysisFileInfo(root)
  if (!value || value.isSymbolicLink()) throw new Error('レジェンド分析の入力が不正です。')
  if (value.isFile()) return [parseLegendAnalysisDataset(await readLegendAnalysisJson(root))]
  if (!value.isDirectory()) throw new Error('レジェンド分析の入力が不正です。')
  await validateLegendAnalysisDirectory(root)
  const manifest = parseLegendAnalysisManifest(await readLegendAnalysisJson(resolve(root, 'index.json')))
  return Promise.all(manifest.datasets.map(async item => parseLegendAnalysisDataset(await readLegendAnalysisJson(resolve(root, item.path)), item)))
}
async function json(path: string, value: unknown): Promise<void> {
  const text = `${JSON.stringify(value, null, 2)}\n`
  if (Buffer.byteLength(text, 'utf8') > LEGEND_ANALYSIS_JSON_LIMIT) throw new Error('レジェンド分析JSONのサイズが上限を超えています。')
  await writeFile(path, text, { flag: 'wx', mode: 0o600 })
}
async function move(from: string, to: string): Promise<void> {
  // Windows may briefly hold a recently inspected directory; retain the bounded retry used by weekly publishing.
  for (let attempt = 0; ; attempt++) {
    try { await rename(from, to); return } catch (error) {
      if (attempt >= 3 || !error || typeof error !== 'object' || !('code' in error)
        || !['EPERM', 'EACCES', 'EBUSY'].includes(String(error.code))) throw error
      await delay(50 * (attempt + 1))
    }
  }
}
function equal(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false
  if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right)
    && left.length === right.length && left.every((value, index) => equal(value, right[index]))
  const a = left as Record<string, unknown>, b = right as Record<string, unknown>
  return Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(key => Object.hasOwn(b, key) && equal(a[key], b[key]))
}

/** Strict aggregate-only history merge. A snapshot ID is immutable; failures retain the old directory. */
export async function importLegendAnalysisData(input: string, output: string, generatedAt = new Date().toISOString()): Promise<{ datasets: number; entries: number }> {
  const incoming = await datasetsAt(input)
  if (!incoming.length) throw new Error('取り込む取得完了データがありません。未取得を0件として公開できません。')
  return mergeLegendAnalysisData(incoming, output, generatedAt)
}

/** Daily publisher also accepts a validated failure status, retaining every successful snapshot. */
export async function publishLegendAnalysisData(inputDirectory: string, output: string, generatedAt = new Date().toISOString()): Promise<{ datasets: number; entries: number }> {
  await validateLegendAnalysisDirectory(inputDirectory)
  const manifest = parseLegendAnalysisManifest(await readLegendAnalysisJson(resolve(inputDirectory, 'index.json')))
  const incoming = await datasetsAt(inputDirectory)
  if (!incoming.length && !manifest.availability) throw new Error('取得完了データまたは明示的な取得状況が必要です。')
  return mergeLegendAnalysisData(incoming, output, generatedAt, manifest.availability)
}

async function mergeLegendAnalysisData(incoming: LegendAnalysisDataset[], output: string, generatedAt: string,
  availability?: LegendAnalysisAvailability): Promise<{ datasets: number; entries: number }> {
  const batch = parseLegendAnalysisManifest({ schemaVersion: 1, generatedAt, source: LEGEND_ANALYSIS_SOURCE, datasets: incoming.map(descriptor), ...(availability ? { availability } : {}) })
  const directory = resolve(output), parent = dirname(directory)
  if (directory === parent || !legendAnalysisPathWithin(parent, directory)) throw new Error('レジェンド分析の保存先が不正です。')
  await checkLegendAnalysisParents(directory)
  await mkdir(parent, { recursive: true, mode: 0o700 })
  await checkLegendAnalysisParents(parent)
  const lock = resolve(parent, `.${basename(directory)}-import.lock`)
  await writeFile(lock, `${process.pid}\n`, { flag: 'wx', mode: 0o600 }).catch(() => { throw new Error('レジェンド分析の取り込みロックを取得できません。') })
  let work: string | undefined, originalMoved = false, committed = false
  try {
    const existingInfo = await legendAnalysisFileInfo(directory)
    const hasOriginal = existingInfo !== null
    let current: LegendAnalysisManifest | null = null
    let existing: LegendAnalysisDataset[] = []
    if (hasOriginal && (await readdir(directory)).length) {
      await validateLegendAnalysisDirectory(directory)
      current = parseLegendAnalysisManifest(await readLegendAnalysisJson(resolve(directory, 'index.json')))
      existing = await datasetsAt(directory)
      if (current.source.url !== batch.source.url || Date.parse(current.generatedAt) > Date.parse(generatedAt)) throw new Error('既存履歴と出典または生成日時が整合しません。')
    }
    const selected = new Map(existing.map(value => [value.id, value]))
    for (const dataset of incoming) {
      if (dataset.source.url !== batch.source.url || Date.parse(dataset.generatedAt) > Date.parse(generatedAt)) throw new Error('入力の出典または生成日時が整合しません。')
      const previous = selected.get(dataset.id)
      if (previous && !equal(previous, dataset)) throw new Error('同じIDの取得履歴を変更できません。')
      selected.set(dataset.id, dataset)
    }
    const datasets = [...selected.values()].sort((a, b) => Date.parse(b.captureEndedAt) - Date.parse(a.captureEndedAt) || a.id.localeCompare(b.id))
    const manifest = parseLegendAnalysisManifest({ schemaVersion: 1, generatedAt, source: batch.source, datasets: datasets.map(descriptor), ...(availability ? { availability } : {}) })
    work = await mkdtemp(resolve(parent, `.${basename(directory)}-import-`))
    if (!legendAnalysisPathWithin(parent, work)) throw new Error('レジェンド分析の作業先が不正です。')
    const stage = resolve(work, 'stage'), backup = resolve(work, 'backup')
    await mkdir(stage, { mode: 0o700 })
    for (const dataset of datasets) {
      const path = resolve(stage, `${dataset.id}.json`)
      if (!legendAnalysisPathWithin(stage, path)) throw new Error('レジェンド分析の保存先が不正です。')
      await json(path, dataset)
    }
    await json(resolve(stage, 'index.json'), manifest)
    const result = await validateLegendAnalysisDirectory(stage)
    await checkLegendAnalysisParents(directory)
    if (hasOriginal) { await move(directory, backup); originalMoved = true }
    await move(stage, directory)
    committed = true
    return result
  } catch (error) {
    if (work && originalMoved && !committed) {
      try { await move(resolve(work, 'backup'), directory); originalMoved = false }
      catch { throw new Error('レジェンド分析の復旧が必要です。作業フォルダーの旧履歴を保持しています。') }
    }
    throw error
  } finally {
    if (work && (!originalMoved || committed) && legendAnalysisPathWithin(parent, work)) await rm(work, { recursive: true, force: true }).catch(() => {})
    await unlink(lock).catch(() => {})
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const input = process.argv[2]
  const output = process.argv[3] ?? fileURLToPath(new URL('../public/data/legend-analysis/', import.meta.url))
  if (!input) { console.error('取得完了したレジェンド分析JSONまたはデータフォルダーを指定してください。'); process.exitCode = 1 }
  else importLegendAnalysisData(input, output).then(result => {
    console.log(`レジェンド分析データ取込完了: ${result.datasets}データセット / ${result.entries}掲載エントリー`)
  }).catch(() => { console.error('レジェンド分析の取り込みに失敗しました。既存履歴の整合性を確認してください。'); process.exitCode = 1 })
}
