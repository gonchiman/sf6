import { constants } from 'node:fs'
import { mkdir, mkdtemp, readdir, rename, rm, rmdir, unlink, writeFile, copyFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import {
  parseSteamPlayerCountObservation, parseSteamPlayerCountDay, parseSteamPlayerCountManifest,
  STEAM_PLAYER_COUNT_APP_ID, STEAM_PLAYER_COUNT_SOURCE_URL,
} from '../src/lib/steamPlayerCount.ts'
import type { SteamPlayerCountDay, SteamPlayerCountDayDescriptor, SteamPlayerCountManifest, SteamPlayerCountObservation } from '../src/types/steamPlayerCount.ts'
import { checkSteamParents, parseSteamJson, readSteamBytes, steamFileInfo, steamJson, steamPathWithin, steamSha256 } from './lib/steam-player-count-files.ts'

interface History {
  manifest: SteamPlayerCountManifest | null
  days: Map<string, SteamPlayerCountDay>
  byId: Map<string, SteamPlayerCountObservation>
  byRun: Map<string, SteamPlayerCountObservation>
}

function register(history: History, observation: SteamPlayerCountObservation): boolean {
  const previous = history.byId.get(observation.id)
  const runKey = observation.runId === null ? null : `${observation.runId}:${observation.runAttempt}`
  const previousRun = runKey === null ? null : history.byRun.get(runKey)
  if ([previous, previousRun].some(value => value && JSON.stringify(value) !== JSON.stringify(observation))) {
    throw new Error('同じIDまたは実行回のSteam観測値を変更できません。')
  }
  history.byId.set(observation.id, observation)
  if (runKey !== null) history.byRun.set(runKey, observation)
  return !previous
}

async function loadHistory(directory: string): Promise<History> {
  const history: History = { manifest: null, days: new Map(), byId: new Map(), byRun: new Map() }
  await checkSteamParents(directory)
  if (!(await steamFileInfo(directory))) return history
  const entries = await readdir(directory, { withFileTypes: true })
  if (entries.length === 0) return history
  if (entries.some(entry => entry.isSymbolicLink() || (entry.name === 'index.json' ? !entry.isFile()
    : entry.name === 'days' ? !entry.isDirectory() : true))) throw new Error('Steam履歴に未許可のファイルがあります。')
  history.manifest = parseSteamPlayerCountManifest(parseSteamJson(await readSteamBytes(resolve(directory, 'index.json'))))
  const dayRoot = resolve(directory, 'days')
  const dayFiles = (await steamFileInfo(dayRoot)) ? await readdir(dayRoot, { withFileTypes: true }) : []
  const allowed = new Set(history.manifest.days.map(day => `${day.date}.json`))
  if (dayFiles.length !== allowed.size || dayFiles.some(file => !file.isFile() || file.isSymbolicLink() || !allowed.has(file.name))) {
    throw new Error('Steam履歴の一覧と日別ファイルが一致しません。')
  }
  for (const descriptor of history.manifest.days) {
    const bytes = await readSteamBytes(resolve(directory, descriptor.path))
    if (steamSha256(bytes) !== descriptor.sha256) throw new Error('Steam履歴のハッシュが一致しません。')
    const day = parseSteamPlayerCountDay(parseSteamJson(bytes), descriptor)
    history.days.set(day.date, day)
    for (const observation of day.observations) {
      if (!register(history, observation)) throw new Error('Steam履歴に重複した観測があります。')
    }
  }
  return history
}

export async function validateSteamPlayerCountHistory(directory: string): Promise<{ observations: number; days: number }> {
  const history = await loadHistory(resolve(directory))
  if (!history.manifest) throw new Error('Steam履歴のindex.jsonがありません。')
  return { observations: history.byId.size, days: history.days.size }
}

export async function replaceSteamPlayerCountFile(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try { await rename(from, to); return }
    catch (error) {
      if (attempt >= 3 || !error || typeof error !== 'object' || !('code' in error)
        || !['EPERM', 'EACCES', 'EBUSY'].includes(String(error.code))) throw error
      // Windows scanners can hold a new file briefly after its handles close.
      await delay(50 * (attempt + 1))
    }
  }
}

/** Seed a new isolated history from this commit's validated bundled publication.
 * Existing history is never seeded again, and every byte/hash is preserved.
 */
export async function seedSteamPlayerCountHistory(input: string, output: string): Promise<void> {
  const source = resolve(input), destination = resolve(output)
  if (source === destination || steamPathWithin(source, destination) || steamPathWithin(destination, source)) {
    throw new Error('Steam履歴の初期化先が不正です。')
  }
  const bundled = await loadHistory(source)
  if (!bundled.manifest) throw new Error('同梱Steam履歴を確認できません。')
  await checkSteamParents(destination)
  if (await steamFileInfo(destination) && (await readdir(destination)).length) throw new Error('既存Steam履歴を初期化できません。')
  await mkdir(resolve(destination, 'days'), { recursive: true })
  for (const descriptor of bundled.manifest.days) {
    await copyFile(resolve(source, descriptor.path), resolve(destination, descriptor.path), constants.COPYFILE_EXCL)
  }
  await copyFile(resolve(source, 'index.json'), resolve(destination, 'index.json'), constants.COPYFILE_EXCL)
  await loadHistory(destination)
}

/** Append one immutable observation. Replace only the affected day, then the index.
 * Readers verify the index hash; the brief file/index transition is never accepted
 * as a complete publication. A failed index replacement restores the old day.
 */
export async function publishSteamPlayerCount(input: string, output: string, generatedAt = new Date().toISOString(),
  options: { replace?: (from: string, to: string) => Promise<void> } = {}): Promise<{
  changed: boolean; observations: number; days: number
}> {
  const observation = parseSteamPlayerCountObservation(parseSteamJson(await readSteamBytes(resolve(input))))
  const directory = resolve(output), parent = dirname(directory)
  if (!steamPathWithin(parent, directory) || steamPathWithin(directory, resolve(input))) throw new Error('Steam履歴の入力・保存先が不正です。')
  await checkSteamParents(directory)
  await mkdir(parent, { recursive: true })
  const lock = resolve(parent, `.${basename(directory)}-steam.lock`)
  await writeFile(lock, `${process.pid}\n`, { flag: 'wx' })
  const replace = options.replace ?? replaceSteamPlayerCountFile
  let work: string | undefined, changedPath: string | undefined, backupPath: string | undefined
  let dayWritten = false, committed = false, recoveryFailed = false
  const dayRoot = resolve(directory, 'days')
  let hadDirectory = true, hadDayRoot = true
  try {
    hadDirectory = !!(await steamFileInfo(directory))
    hadDayRoot = !!(await steamFileInfo(dayRoot))
    const history = await loadHistory(directory)
    if (!register(history, observation)) return { changed: false, observations: history.byId.size, days: history.days.size }
    if (!Number.isFinite(Date.parse(generatedAt)) || new Date(generatedAt).toISOString() !== generatedAt
      || Date.parse(observation.observedAt) > Date.parse(generatedAt)
      || history.manifest && Date.parse(history.manifest.generatedAt) > Date.parse(generatedAt)) {
      throw new Error('Steam履歴の生成日時が不正です。')
    }
    const date = observation.observedAt.slice(0, 10)
    const observations = [...(history.days.get(date)?.observations ?? []), observation]
      .sort((a, b) => a.observedAt.localeCompare(b.observedAt) || a.id.localeCompare(b.id))
    const day = parseSteamPlayerCountDay({ schemaVersion: 1, appId: STEAM_PLAYER_COUNT_APP_ID, date, observations })
    const text = steamJson(day)
    const descriptor: SteamPlayerCountDayDescriptor = {
      date, path: `days/${date}.json`, sha256: steamSha256(text), observationCount: observations.length,
      firstObservedAt: observations[0].observedAt, lastObservedAt: observations.at(-1)!.observedAt,
    }
    const descriptors = [...(history.manifest?.days ?? []).filter(item => item.date !== date), descriptor]
      .sort((a, b) => a.date.localeCompare(b.date))
    const manifest = parseSteamPlayerCountManifest({ schemaVersion: 1, appId: STEAM_PLAYER_COUNT_APP_ID,
      sourceUrl: STEAM_PLAYER_COUNT_SOURCE_URL, generatedAt, days: descriptors })
    work = await mkdtemp(resolve(parent, '.steam-publication-'))
    const stagedDay = resolve(work, 'day.json'), stagedIndex = resolve(work, 'index.json')
    changedPath = resolve(directory, descriptor.path)
    if (history.days.has(date)) {
      backupPath = resolve(work, 'previous-day.json')
      await copyFile(changedPath, backupPath)
    }
    await writeFile(stagedDay, text, { flag: 'wx', mode: 0o600 })
    await writeFile(stagedIndex, steamJson(manifest), { flag: 'wx', mode: 0o600 })
    await mkdir(dayRoot, { recursive: true })
    await checkSteamParents(directory)
    await replace(stagedDay, changedPath)
    dayWritten = true
    await replace(stagedIndex, resolve(directory, 'index.json'))
    committed = true
    return { changed: true, observations: history.byId.size, days: descriptors.length }
  } catch (error) {
    if (dayWritten && !committed && changedPath) {
      try {
        if (backupPath) await replace(backupPath, changedPath)
        else await unlink(changedPath)
        dayWritten = false
      } catch {
        recoveryFailed = true
        throw new Error('Steam履歴の復旧が必要です。作業フォルダーの旧履歴を保持しています。')
      }
    }
    if (!hadDayRoot) await rmdir(dayRoot).catch(() => {})
    if (!hadDirectory) await rmdir(directory).catch(() => {})
    throw error
  } finally {
    if (work && !recoveryFailed && steamPathWithin(parent, work)) await rm(work, { recursive: true, force: true }).catch(() => {})
    if (!recoveryFailed) await unlink(lock).catch(() => {})
  }
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  if (args.length === 1 && args[0] === '--help') {
    console.log('node scripts/publish-steam-player-count.ts --input <observation.json> --output <履歴のpublicディレクトリ>')
    return
  }
  if (args.length !== 4 || args[0] !== '--input' || !args[1] || args[2] !== '--output' || !args[3]) throw new Error('引数が不正です。')
  console.log(JSON.stringify(await publishSteamPlayerCount(args[1], args[3])))
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { console.error('Steam履歴を反映できませんでした。以前の正常データを保持してください。'); process.exitCode = 1 })
}
