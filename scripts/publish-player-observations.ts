import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { parsePlayerObservationDataset } from '../src/lib/playerObservations.ts'
import { PlayerObservationStore, assertPrivateObservationPath } from './lib/player-observation-store.ts'
import { validatePlayerObservationDirectory } from './validate-player-observation-data.ts'

interface Paths { directory: string; work: string; stage: string; backup: string; journal: string; temporary: string; lock: string; reclaim: string }
interface Journal { version: 1; directory: string; hadOriginal: boolean; phase: 'prepared' | 'committed' }

function hasCode(error: unknown, value: string): boolean { return !!error && typeof error === 'object' && 'code' in error && error.code === value }
function contains(parent: string, child: string): boolean {
  const path = relative(parent, child)
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`))
}
async function exists(path: string): Promise<boolean> {
  try { await fs.lstat(path); return true } catch (error) { if (hasCode(error, 'ENOENT')) return false; throw error }
}
async function checkParents(path: string): Promise<void> {
  for (let current = path; ; current = dirname(current)) {
    if (await exists(current)) {
      const stat = await fs.lstat(current)
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('観測データの公開先にリンク等の特殊な保存先は指定できません。')
    }
    if (current === dirname(current)) return
  }
}
async function checkTree(path: string): Promise<void> {
  const stat = await fs.lstat(path)
  if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw new Error('公開作業先にリンク等の特殊なファイルがあります。')
  if (stat.isDirectory()) for (const name of await fs.readdir(path)) await checkTree(resolve(path, name))
}
async function move(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try { await fs.rename(from, to); return } catch (error) {
      if (attempt >= 5 || !['EPERM', 'EACCES', 'EBUSY'].some((code) => hasCode(error, code))) throw error
      await delay(25 * 2 ** attempt)
    }
  }
}
function pathsFor(directoryValue: string, workValue?: string): Paths {
  const directory = resolve(directoryValue)
  const work = resolve(workValue ?? resolve(dirname(directory), `.${basename(directory)}-publication`))
  if (directory === dirname(directory) || contains(directory, work) || contains(work, directory)) throw new Error('公開先と作業先は、互いに含まれない別のディレクトリにしてください。')
  return { directory, work, stage: resolve(work, 'stage'), backup: resolve(work, 'backup'), journal: resolve(work, 'journal.json'),
    temporary: resolve(work, 'journal.tmp'), lock: resolve(work, 'lock'), reclaim: resolve(work, 'reclaim') }
}
function isAlive(pid: number): boolean { try { process.kill(pid, 0); return true } catch (error) { return !hasCode(error, 'ESRCH') } }
async function lockOwner(paths: Paths): Promise<{ pid: number; token: string }> {
  await checkTree(paths.lock)
  const owner = JSON.parse(await fs.readFile(paths.lock, 'utf8'))
  if (!Number.isInteger(owner?.pid) || owner.pid < 1 || owner.pid > 2147483647 || typeof owner.token !== 'string') throw new Error('公開ロックの形式を確認できません。')
  return owner
}
async function acquire(paths: Paths): Promise<string> {
  const token = randomUUID()
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (await exists(paths.reclaim)) throw new Error('公開ロックの復旧処理が残っています。')
    let handle
    try { handle = await fs.open(paths.lock, 'wx') } catch (error) {
      if (!hasCode(error, 'EEXIST')) throw error
      const owner = await lockOwner(paths)
      if (isAlive(owner.pid)) throw new Error('別の観測データ公開処理が実行中です。')
      try { await fs.mkdir(paths.reclaim) } catch (reclaimError) {
        if (hasCode(reclaimError, 'EEXIST')) throw new Error('公開ロックの復旧処理が実行中です。')
        throw reclaimError
      }
      try {
        if (await exists(paths.lock)) {
          const current = await lockOwner(paths)
          if (isAlive(current.pid)) throw new Error('別の観測データ公開処理が実行中です。')
          await fs.unlink(paths.lock)
        }
      } finally { await fs.rmdir(paths.reclaim) }
      continue
    }
    try { await handle.writeFile(JSON.stringify({ pid: process.pid, token }) + '\n'); await handle.sync() }
    catch (error) { await handle.close(); await fs.unlink(paths.lock); throw error }
    await handle.close()
    return token
  }
  throw new Error('観測データの公開ロックを取得できませんでした。')
}
async function remove(paths: Paths, path: string): Promise<void> {
  if (path === paths.work || !contains(paths.work, path)) throw new Error('公開作業先の範囲が不正です。')
  if (await exists(path)) { await checkTree(path); await fs.rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }) }
}
async function cleanup(paths: Paths): Promise<void> {
  for (const path of [paths.stage, paths.backup, paths.temporary, paths.journal]) await remove(paths, path)
}
async function writeJournal(paths: Paths, journal: Journal): Promise<void> {
  await fs.writeFile(paths.temporary, JSON.stringify(journal) + '\n', { flush: true })
  await move(paths.temporary, paths.journal)
}
async function restore(paths: Paths): Promise<void> {
  await validatePlayerObservationDirectory(paths.backup)
  if (await exists(paths.directory)) {
    if (await exists(paths.stage)) throw new Error('復旧先に公開データと作業データの両方があります。復旧記録を保持して停止しました。')
    await checkTree(paths.directory)
    await move(paths.directory, paths.stage)
  }
  await move(paths.backup, paths.directory)
}
async function recover(paths: Paths): Promise<void> {
  if (!await exists(paths.journal)) {
    if (await exists(paths.backup)) throw new Error('公開の復旧記録がないため退避データを保持して停止しました。')
    await cleanup(paths)
    return
  }
  const journal: Journal = JSON.parse(await fs.readFile(paths.journal, 'utf8'))
  if (journal.version !== 1 || journal.directory !== paths.directory || typeof journal.hadOriginal !== 'boolean' || !['prepared', 'committed'].includes(journal.phase)) {
    throw new Error('観測データの復旧記録が不正です。')
  }
  if (journal.phase === 'committed') {
    try { await validatePlayerObservationDirectory(paths.directory) } catch (error) {
      if (!await exists(paths.backup)) throw error
      await restore(paths)
    }
  } else if (await exists(paths.backup)) await restore(paths)
  else if (journal.hadOriginal) {
    if (!await exists(paths.directory)) throw new Error('公開データと退避データが見つかりません。')
    await validatePlayerObservationDirectory(paths.directory)
  } else if (await exists(paths.directory)) {
    if (await exists(paths.stage)) throw new Error('初回公開の復旧状態を確認できません。')
    await move(paths.directory, paths.stage)
  }
  await cleanup(paths)
}

/** Uses the existing publication protocol: validate, stage, journal, atomic replace, rollback. */
export async function publishPlayerObservationDataset(value: unknown, directoryValue: string, transactionDirectory?: string): Promise<{ runs: number }> {
  const dataset = parsePlayerObservationDataset(value)
  const paths = pathsFor(directoryValue, transactionDirectory)
  await checkParents(paths.directory)
  await checkParents(paths.work)
  await fs.mkdir(paths.work, { recursive: true })
  const allowed = new Set(['stage', 'backup', 'journal.json', 'journal.tmp', 'lock', 'reclaim'])
  if ((await fs.readdir(paths.work)).some((name) => !allowed.has(name))) throw new Error('公開作業先に管理対象外のファイルがあります。')
  await checkTree(paths.work)
  const token = await acquire(paths)
  try {
    await recover(paths)
    const hadOriginal = await exists(paths.directory)
    if (hadOriginal) await validatePlayerObservationDirectory(paths.directory)
    await fs.mkdir(paths.stage)
    await fs.writeFile(resolve(paths.stage, 'index.json'), JSON.stringify(dataset, null, 2) + '\n', { flag: 'wx', flush: true })
    const result = await validatePlayerObservationDirectory(paths.stage)
    const journal: Journal = { version: 1, directory: paths.directory, hadOriginal, phase: 'prepared' }
    await writeJournal(paths, journal)
    if (hadOriginal) await move(paths.directory, paths.backup)
    await move(paths.stage, paths.directory)
    await writeJournal(paths, { ...journal, phase: 'committed' })
    try { await cleanup(paths) } catch { console.warn('公開済みデータは検証済みです。作業ファイルの後片付けは次回更新時に再実行します。') }
    return result
  } catch (error) {
    try { await recover(paths) } catch (recoveryError) { throw new AggregateError([error, recoveryError], '公開に失敗しました。復旧用の記録を保持しています。') }
    throw error
  } finally {
    try {
      if ((await lockOwner(paths)).token === token) await fs.unlink(paths.lock)
      if ((await fs.readdir(paths.work)).length === 0) await fs.rmdir(paths.work)
    } catch { console.warn('公開ロックの後片付けが残っています。同じ設定で再実行してください。') }
  }
}

export async function publishPlayerObservations(databasePath: string, directory: string, generatedAt = new Date().toISOString()): Promise<{ runs: number }> {
  const path = assertPrivateObservationPath(databasePath)
  const paths = pathsFor(directory)
  if ([path, `${path}-wal`, `${path}-shm`].some((candidate) => contains(paths.directory, candidate) || contains(paths.work, candidate))) {
    throw new Error('非公開のID履歴と公開・復旧作業先は、互いに含まれない場所にしてください。')
  }
  await fs.stat(path) // Never fabricate an empty DB when the source history is missing.
  const store = new PlayerObservationStore(path)
  let dataset
  try { dataset = store.snapshotDataset(generatedAt) } finally { store.close() }
  return publishPlayerObservationDataset(dataset, directory)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const database = process.argv[2] ?? fileURLToPath(new URL('../.local/player-observations/history.sqlite', import.meta.url))
  const directory = process.argv[3] ?? fileURLToPath(new URL('../public/data/player-observations', import.meta.url))
  if (process.argv.length > 4) { console.error('使い方: node scripts/publish-player-observations.ts [非公開DBパス] [公開フォルダー]'); process.exitCode = 1 }
  else try {
    const result = await publishPlayerObservations(database, directory)
    console.log(`観測集計の公開JSON更新完了: ${result.runs}走査（ID履歴は含みません）`)
  } catch {
    console.error('観測集計を公開できませんでした。非公開の履歴と公開先の検証・復旧状態を確認してください。')
    process.exitCode = 1
  }
}
