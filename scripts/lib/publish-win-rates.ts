import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { parseWinRateDataset, parseWinRateManifest } from '../../src/lib/winRates.ts'
import type { WinRateDataset, WinRateManifest } from '../../src/types/winRates.ts'
import { validateWinRateDirectory } from '../validate-win-rate-data.ts'

const LEAGUES = ['ROOKIE', 'IRON', 'BRONZE', 'SILVER', 'GOLD', 'PLATINUM', 'DIAMOND', 'MASTER']
const MODES = ['combined', 'separate']
const WORK_FILES = new Set(['stage', 'backup', 'journal.json', 'journal.tmp', 'lock', 'reclaim'])

interface PublishOptions {
  directory: string
  transactionDirectory?: string
  datasets: WinRateDataset[]
  months: string[]
  generatedAt: string
}

interface Paths {
  directory: string
  work: string
  stage: string
  backup: string
  journal: string
  temporaryJournal: string
  lock: string
  reclaim: string
}

interface Journal {
  version: 1
  directory: string
  phase: 'prepared' | 'committed'
  hadOriginal: boolean
}

function hasCode(error: unknown, code: string): boolean {
  return error !== null && typeof error === 'object' && 'code' in error && error.code === code
}

function contains(parent: string, child: string): boolean {
  const path = relative(parent, child)
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`))
}

function pathsFor(options: PublishOptions): Paths {
  const directory = resolve(options.directory)
  const work = resolve(options.transactionDirectory ?? resolve(dirname(directory), `.${basename(directory)}-update`))
  if (directory === dirname(directory) || contains(directory, work) || contains(work, directory)) {
    throw new Error('公開先と作業先は、互いに含まれない別のディレクトリにしてください。')
  }
  return {
    directory, work, stage: resolve(work, 'stage'), backup: resolve(work, 'backup'),
    journal: resolve(work, 'journal.json'), temporaryJournal: resolve(work, 'journal.tmp'), lock: resolve(work, 'lock'),
    reclaim: resolve(work, 'reclaim'),
  }
}

async function exists(path: string): Promise<boolean> {
  try { await fs.lstat(path); return true } catch (error) {
    if (hasCode(error, 'ENOENT')) return false
    throw error
  }
}

async function move(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try { await fs.rename(from, to); return } catch (error) {
      if (attempt >= 5 || !['EPERM', 'EACCES', 'EBUSY'].some((code) => hasCode(error, code))) throw error
      await delay(25 * 2 ** attempt)
    }
  }
}

async function checkParents(path: string): Promise<void> {
  for (let current = path; ; current = dirname(current)) {
    if (await exists(current)) {
      const stat = await fs.lstat(current)
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`ディレクトリの保存先が不正です: ${current}`)
    }
    if (current === dirname(current)) return
  }
}

async function checkTree(path: string): Promise<void> {
  const stat = await fs.lstat(path)
  if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw new Error(`リンク等の特殊なファイルは更新できません: ${path}`)
  if (stat.isDirectory()) {
    for (const entry of await fs.readdir(path)) await checkTree(resolve(path, entry))
  }
}

async function currentManifest(directory: string): Promise<WinRateManifest | null> {
  if (!await exists(directory)) return null
  await checkTree(directory)
  if ((await fs.readdir(directory)).length === 0) return null
  await validateWinRateDirectory(directory)
  return parseWinRateManifest(JSON.parse(await fs.readFile(resolve(directory, 'index.json'), 'utf8')))
}

function validateBatch(options: PublishOptions): WinRateDataset[] {
  if (options.months.length === 0 || new Set(options.months).size !== options.months.length
    || options.months.some((month) => !/^\d{4}-(?:0[1-9]|1[0-2])$/.test(month))) {
    throw new Error('対象月は重複のないYYYY-MM形式で指定してください。')
  }
  const expected = new Set(options.months.flatMap((month) => LEAGUES.flatMap((league) => MODES.map((mode) => `${month}/${league}/${mode}`))))
  const datasets = options.datasets.map((value) => {
    const dataset = parseWinRateDataset(value)
    const key = `${dataset.month}/${dataset.league}/${dataset.operationMode}`
    if (!expected.delete(key)) throw new Error(`重複または対象外の取得条件です: ${key}`)
    if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(dataset.id)) throw new Error(`保存できないデータIDです: ${dataset.id}`)
    return dataset
  })
  if (expected.size !== 0) throw new Error(`対象月の16条件が揃っていません: ${[...expected].join(', ')}`)
  // Also validate IDs, timestamps and output paths before any filesystem changes.
  parseWinRateManifest({ schemaVersion: 1, generatedAt: options.generatedAt, source: datasets[0].source, datasets: descriptors(datasets) })
  return datasets
}

function descriptors(datasets: WinRateDataset[]) {
  return datasets.map(({ id, month, league, operationMode, capturedAt }) => ({
    id, month, league, operationMode, capturedAt, path: `${id}.json`,
  }))
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (error) {
    return !hasCode(error, 'ESRCH')
  }
}

async function readLockOwner(paths: Paths): Promise<{ pid: number; token: string }> {
  await checkTree(paths.lock)
  let owner
  try { owner = JSON.parse(await fs.readFile(paths.lock, 'utf8')) } catch {
    throw new Error('更新ロックを確認できません。別の更新処理が終了してから再実行してください。')
  }
  if (!Number.isInteger(owner?.pid) || owner.pid <= 0 || owner.pid > 2147483647 || typeof owner.token !== 'string') {
    throw new Error('更新ロックの形式が正しくありません。作業先を確認してください。')
  }
  return owner
}

async function reclaimLock(paths: Paths): Promise<void> {
  try { await fs.mkdir(paths.reclaim) } catch (error) {
    if (hasCode(error, 'EEXIST')) throw new Error('更新ロックの復旧処理が実行中、または復旧記録が残っています。作業先を確認してください。')
    throw error
  }
  try {
    if (!await exists(paths.lock)) return
    // Another contender may already have replaced the stale lock. Always
    // reread its owner while holding the exclusive reclaim directory.
    const owner = await readLockOwner(paths)
    if (isAlive(owner.pid)) throw new Error(`別の更新処理が実行中です（PID ${owner.pid}）。`)
    await fs.unlink(paths.lock)
  } finally {
    // Only the process which created this directory may remove it.
    await fs.rmdir(paths.reclaim)
  }
}

async function acquireLock(paths: Paths): Promise<string> {
  const token = randomUUID()
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (await exists(paths.reclaim)) throw new Error('更新ロックの復旧処理が実行中、または復旧記録が残っています。作業先を確認してください。')
    let handle
    try {
      handle = await fs.open(paths.lock, 'wx')
    } catch (error) {
      if (!hasCode(error, 'EEXIST')) throw error
      const owner = await readLockOwner(paths)
      if (isAlive(owner.pid)) throw new Error(`別の更新処理が実行中です（PID ${owner.pid}）。`)
      await reclaimLock(paths)
      continue
    }
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid, token }) + '\n')
      await handle.sync()
    } catch (error) {
      await handle.close()
      await fs.unlink(paths.lock)
      throw error
    }
    await handle.close()
    return token
  }
  throw new Error('更新ロックを取得できませんでした。')
}

async function removeWorkPath(paths: Paths, path: string): Promise<void> {
  if (!contains(paths.work, path) || path === paths.work) throw new Error('作業ファイルの削除先が不正です。')
  if (!await exists(path)) return
  await checkTree(path)
  await fs.rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 })
}

async function cleanWork(paths: Paths): Promise<void> {
  for (const path of [paths.stage, paths.backup, paths.temporaryJournal, paths.journal]) await removeWorkPath(paths, path)
}

async function writeJournal(paths: Paths, journal: Journal): Promise<void> {
  await fs.writeFile(paths.temporaryJournal, JSON.stringify(journal) + '\n', { flush: true })
  await move(paths.temporaryJournal, paths.journal)
}

async function restoreBackup(paths: Paths): Promise<void> {
  await currentManifest(paths.backup)
  if (await exists(paths.directory)) {
    if (await exists(paths.stage)) throw new Error('復旧先に公開データと作業データが両方あります。バックアップを保持して停止します。')
    await checkTree(paths.directory)
    await move(paths.directory, paths.stage)
  }
  await move(paths.backup, paths.directory)
}

async function recover(paths: Paths): Promise<void> {
  if (!await exists(paths.journal)) {
    if (await exists(paths.backup)) throw new Error('復旧記録のないバックアップがあります。上書きせず停止します。')
    await cleanWork(paths)
    return
  }
  const journal = JSON.parse(await fs.readFile(paths.journal, 'utf8')) as Journal
  if (journal.version !== 1 || journal.directory !== paths.directory
    || !['prepared', 'committed'].includes(journal.phase) || typeof journal.hadOriginal !== 'boolean') {
    throw new Error('更新の復旧記録が正しくありません。バックアップを保持して停止します。')
  }
  if (journal.phase === 'committed') {
    try { await validateWinRateDirectory(paths.directory) } catch (error) {
      if (!await exists(paths.backup)) throw error
      await restoreBackup(paths)
    }
  } else if (await exists(paths.backup)) {
    await restoreBackup(paths)
  } else if (journal.hadOriginal) {
    if (!await exists(paths.directory)) throw new Error('公開データとバックアップが見つかりません。')
    await currentManifest(paths.directory)
  } else if (await exists(paths.directory)) {
    if (await exists(paths.stage)) throw new Error('初回更新の復旧状態を確認できません。')
    await checkTree(paths.directory)
    await move(paths.directory, paths.stage)
  }
  await cleanWork(paths)
}

export async function publishWinRateBatch(options: PublishOptions): Promise<{ datasets: number; cells: number }> {
  const paths = pathsFor(options)
  const datasets = validateBatch(options)
  await checkParents(paths.directory)
  await checkParents(paths.work)
  await fs.mkdir(dirname(paths.directory), { recursive: true })
  await fs.mkdir(paths.work, { recursive: true })
  for (const entry of await fs.readdir(paths.work)) {
    if (!WORK_FILES.has(entry)) throw new Error(`作業先に管理対象外のファイルがあります: ${entry}`)
  }
  await checkTree(paths.work)
  const token = await acquireLock(paths)
  try {
    await recover(paths)
    const manifest = await currentManifest(paths.directory)
    const hadOriginal = await exists(paths.directory)
    if (hadOriginal) await fs.cp(paths.directory, paths.stage, { recursive: true, errorOnExist: true, force: false })
    else await fs.mkdir(paths.stage)
    const selected = new Set(options.months)
    const retained = manifest?.datasets.filter((item) => !selected.has(item.month)) ?? []
    const nextManifest = parseWinRateManifest({
      schemaVersion: 1, generatedAt: options.generatedAt, source: manifest?.source ?? datasets[0].source,
      datasets: [...retained, ...descriptors(datasets)].sort((a, b) => b.month.localeCompare(a.month)
        || LEAGUES.indexOf(a.league) - LEAGUES.indexOf(b.league) || MODES.indexOf(a.operationMode) - MODES.indexOf(b.operationMode)),
    })
    for (const item of manifest?.datasets ?? []) {
      if (selected.has(item.month)) {
        const path = resolve(paths.stage, item.path)
        if (!contains(paths.stage, path) || path === paths.stage) throw new Error('データの保存先が不正です。')
        await fs.unlink(path)
      }
    }
    for (const dataset of datasets) {
      await fs.writeFile(resolve(paths.stage, `${dataset.id}.json`), JSON.stringify(dataset) + '\n', { flag: 'wx' })
    }
    await fs.writeFile(resolve(paths.stage, 'index.json'), JSON.stringify(nextManifest, null, 2) + '\n')
    const result = await validateWinRateDirectory(paths.stage)
    const journal: Journal = { version: 1, directory: paths.directory, phase: 'prepared', hadOriginal }
    await writeJournal(paths, journal)
    if (hadOriginal) await move(paths.directory, paths.backup)
    await move(paths.stage, paths.directory)
    await writeJournal(paths, { ...journal, phase: 'committed' })
    try { await cleanWork(paths) } catch {
      console.warn(`データの反映は完了しました。作業ファイルは次回の更新時に削除します: ${paths.work}`)
    }
    return result
  } catch (error) {
    try { await recover(paths) } catch (recoveryError) {
      throw new AggregateError([error, recoveryError], '更新に失敗しました。復旧用のファイルを保持しています。同じ設定で再実行してください。')
    }
    throw error
  } finally {
    try {
      const owner = JSON.parse(await fs.readFile(paths.lock, 'utf8'))
      if (owner.token === token) await fs.unlink(paths.lock)
      if ((await fs.readdir(paths.work)).length === 0) await fs.rmdir(paths.work)
    } catch {
      console.warn(`更新ロックの後片付けが残っています。処理終了後に同じ設定で再実行してください: ${paths.work}`)
    }
  }
}
