import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseUsageRateDataset, parseUsageRateManifest } from '../src/lib/usageRates.ts'
import type { UsageRateDataset, UsageRateManifest } from '../src/types/usageRates.ts'
import { usagePathWithin, validateUsageRateDirectory } from './validate-usage-rate-data.ts'

function code(error: unknown, value: string): boolean {
  return error !== null && typeof error === 'object' && 'code' in error && error.code === value
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true } catch (error) {
    if (code(error, 'ENOENT')) return false
    throw error
  }
}

async function checkParents(path: string): Promise<void> {
  for (let current = path; ; current = dirname(current)) {
    if (await exists(current)) {
      const stat = await lstat(current)
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`使用率の保存先が不正です: ${current}`)
    }
    if (current === dirname(current)) return
  }
}

async function readInput(input: string): Promise<UsageRateDataset[]> {
  const root = resolve(input)
  const stat = await lstat(root)
  if (stat.isSymbolicLink()) throw new Error('使用率の入力にリンクは指定できません。')
  if (stat.isDirectory()) {
    const files = await readdir(root, { withFileTypes: true })
    if (files.some((entry) => !entry.isFile() || !entry.name.endsWith('.json'))) throw new Error('入力フォルダーには使用率JSONだけを配置してください。')
    const datasets: UsageRateDataset[] = []
    for (const file of files.map((entry) => entry.name).filter((name) => name !== 'index.json').sort()) {
      datasets.push(...await readInput(resolve(root, file)))
    }
    return datasets
  }
  if (!stat.isFile()) throw new Error('使用率の入力はJSONファイルまたはフォルダーで指定してください。')
  const value: unknown = JSON.parse(await readFile(root, 'utf8'))
  if (value !== null && typeof value === 'object' && !Array.isArray(value) && 'datasets' in value) {
    if (!('schemaVersion' in value) || value.schemaVersion !== 1 || !Array.isArray(value.datasets)) throw new Error('使用率の入力bundleが不正です。')
    return value.datasets.map((dataset) => parseUsageRateDataset(dataset))
  }
  return [parseUsageRateDataset(value)]
}

function descriptors(datasets: UsageRateDataset[]) {
  return datasets.map(({ id, month, league, capturedAt }) => ({ id, month, league, capturedAt, path: `${id}.json` }))
}

/** Validate the complete batch before staging, then publish only its month/league conditions. */
export async function importUsageRateData(input: string, output: string, generatedAt = new Date().toISOString()): Promise<{ datasets: number; entries: number }> {
  const datasets = await readInput(input)
  if (datasets.length === 0) throw new Error('取り込む使用率データがありません。')
  // This also rejects duplicate IDs/conditions and unsafe names before creating files.
  const batch = parseUsageRateManifest({ schemaVersion: 1, generatedAt, source: datasets[0].source, datasets: descriptors(datasets) })
  for (const dataset of datasets) {
    if (dataset.source.url !== batch.source.url) throw new Error('入力の使用率データは同じ出典URLに揃えてください。')
    if (Date.parse(dataset.generatedAt) > Date.parse(generatedAt)) throw new Error('入力の生成日時が一覧の生成日時より後です。')
    if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(dataset.id)) throw new Error(`保存できない使用率IDです: ${dataset.id}`)
  }
  const directory = resolve(output)
  const parent = dirname(directory)
  if (parent === directory) throw new Error('使用率の保存先にルートディレクトリは指定できません。')
  await checkParents(directory)
  await mkdir(parent, { recursive: true })
  const lock = resolve(parent, `.${basename(directory)}-import.lock`)
  // An exclusive lock prevents simultaneous importers from discarding one another's updates.
  await writeFile(lock, `${process.pid}\n`, { flag: 'wx' }).catch((error) => {
    if (code(error, 'EEXIST')) throw new Error(`使用率の取り込みロックが存在します。別の処理の終了を確認してください: ${lock}`)
    throw error
  })
  let work: string | undefined
  let hadOriginal = false
  let movedOriginal = false
  let committed = false
  try {
    hadOriginal = await exists(directory)
    let current: UsageRateManifest | null = null
    if (hadOriginal && (await readdir(directory)).length > 0) {
      await validateUsageRateDirectory(directory)
      current = parseUsageRateManifest(JSON.parse(await readFile(resolve(directory, 'index.json'), 'utf8')))
      if (current.source.url !== batch.source.url) throw new Error('既存使用率データと取り込みデータの出典URLが異なります。')
    }
    const selected = new Set(datasets.map((dataset) => `${dataset.month}/${dataset.league}`))
    const isSelected = (descriptor: { month: string; league: string }) => selected.has(`${descriptor.month}/${descriptor.league}`)
    const next = parseUsageRateManifest({
      schemaVersion: 1, generatedAt, source: current?.source ?? batch.source,
      datasets: [...(current?.datasets.filter((descriptor) => !isSelected(descriptor)) ?? []), ...batch.datasets]
        .sort((a, b) => b.month.localeCompare(a.month) || a.league.localeCompare(b.league)),
    })
    work = await mkdtemp(resolve(parent, `.${basename(directory)}-import-`))
    if (!usagePathWithin(parent, work)) throw new Error('使用率の作業先が不正です。')
    const stage = resolve(work, 'stage')
    const backup = resolve(work, 'backup')
    if (hadOriginal) await cp(directory, stage, { recursive: true, errorOnExist: true, force: false })
    else await mkdir(stage)
    for (const descriptor of current?.datasets ?? []) {
      if (isSelected(descriptor)) {
        const path = resolve(stage, descriptor.path)
        if (!usagePathWithin(stage, path)) throw new Error('使用率の保存先が不正です。')
        await unlink(path)
      }
    }
    for (const dataset of datasets) {
      const path = resolve(stage, `${dataset.id}.json`)
      if (!usagePathWithin(stage, path)) throw new Error('使用率の保存先が不正です。')
      await writeFile(path, `${JSON.stringify(dataset, null, 2)}\n`, { flag: 'wx' })
    }
    await writeFile(resolve(stage, 'index.json'), `${JSON.stringify(next, null, 2)}\n`)
    const result = await validateUsageRateDirectory(stage)
    if (hadOriginal) { await rename(directory, backup); movedOriginal = true }
    await rename(stage, directory)
    committed = true
    return result
  } catch (error) {
    if (movedOriginal && !committed && work) {
      try { await rename(resolve(work, 'backup'), directory); movedOriginal = false } catch (restoreError) {
        throw new AggregateError([error, restoreError], `使用率の復旧に失敗しました。既存データのbackupを保持しています: ${work}`)
      }
    }
    throw error
  } finally {
    // Never delete the only remaining backup after a failed rollback.
    if (work && (!movedOriginal || committed) && usagePathWithin(parent, work)) {
      try { await rm(work, { recursive: true, force: true }) } catch { console.warn(`使用率の作業ファイルの後片付けが残っています: ${work}`) }
    }
    try { await unlink(lock) } catch { console.warn(`使用率の取り込みロックの後片付けが残っています: ${lock}`) }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const input = process.argv[2] ?? fileURLToPath(new URL('./data-source/usage-rates-2026-07-to-09.json', import.meta.url))
  const output = process.argv[3] ?? fileURLToPath(new URL('../public/data/usage-rates/', import.meta.url))
  try {
    const result = await importUsageRateData(input, output)
    console.log(`使用率データ取込完了: ${result.datasets}データセット / ${result.entries}項目`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
