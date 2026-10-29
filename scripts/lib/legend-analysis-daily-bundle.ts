import { mkdir, mkdtemp, readdir, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { parseLegendAnalysisManifest } from '../../src/lib/legendAnalysis.ts'
import { publishLegendAnalysisData } from '../import-legend-analysis-data.ts'
import { publishLegendPlayersData } from '../import-legend-players-data.ts'
import { validateLegendAnalysisDirectory } from '../validate-legend-analysis-data.ts'
import { validateLegendPlayersDirectory } from '../validate-legend-players-data.ts'
import { checkLegendAnalysisParents, legendAnalysisFileInfo, legendAnalysisPathWithin, readLegendAnalysisJson } from './legend-analysis-files.ts'

type PlayerRequirement = boolean | 'optional'

/** Only the fixed players subdirectory may accompany the strict aggregate family. */
async function separateFamilies(input: string, output: string, requirePlayers: PlayerRequirement) {
  await checkLegendAnalysisParents(input)
  const files = await readdir(input, { withFileTypes: true })
  if (files.length > 10001 || files.some(file => file.isSymbolicLink()
    || (file.name === 'players' ? !file.isDirectory() : !file.isFile()))) throw new Error('履歴の構成が不正です。')
  const hasPlayers = files.some(file => file.name === 'players')
  if (requirePlayers !== 'optional' && hasPlayers !== requirePlayers) throw new Error('プレイヤー一覧の設定と出力が一致しません。')
  const aggregate = resolve(output, 'aggregate'), players = resolve(output, 'players')
  await mkdir(aggregate, { recursive: true, mode: 0o700 })
  let bytes = 0
  for (const file of files.filter(file => file.name !== 'players')) {
    if (file.name !== 'index.json' && !/^legend-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.json$/.test(file.name)) throw new Error('履歴に未許可のファイルがあります。')
    const value = await readLegendAnalysisJson(resolve(input, file.name)), text = `${JSON.stringify(value, null, 2)}\n`
    if ((bytes += Buffer.byteLength(text)) > 64 * 1024 * 1024) throw new Error('履歴サイズが上限を超えています。')
    await writeFile(resolve(aggregate, file.name), text, { flag: 'wx', mode: 0o600 })
  }
  const counts = await validateLegendAnalysisDirectory(aggregate)
  if (hasPlayers) {
    const source = resolve(input, 'players')
    await validateLegendPlayersDirectory(source)
    await mkdir(players, { mode: 0o700 })
    for (const file of await readdir(source)) {
      const value = await readLegendAnalysisJson(resolve(source, file))
      await writeFile(resolve(players, file), `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    }
    await validateLegendPlayersDirectory(players)
    if (requirePlayers === true) {
      const aggregateManifest = parseLegendAnalysisManifest(await readLegendAnalysisJson(resolve(aggregate, 'index.json')))
      const playerManifest = parseLegendAnalysisManifest(await readLegendAnalysisJson(resolve(players, 'index.json')))
      if (JSON.stringify(aggregateManifest.datasets) !== JSON.stringify(playerManifest.datasets)
        || aggregateManifest.generatedAt !== playerManifest.generatedAt
        || aggregateManifest.availability?.status !== playerManifest.availability?.status
        || aggregateManifest.availability?.checkedAt !== playerManifest.availability?.checkedAt) throw new Error('集計と一覧の取得回が一致しません。')
    }
  }
  return { aggregate, players: hasPlayers ? players : null, counts }
}

async function move(from: string, to: string) {
  for (let attempt = 0; ; attempt++) {
    try { await rename(from, to); return } catch (error) {
      if (attempt >= 3 || !error || typeof error !== 'object' || !('code' in error)
        || !['EPERM', 'EACCES', 'EBUSY'].includes(String(error.code))) throw error
      await delay(50 * (attempt + 1))
    }
  }
}

export async function validateLegendDailyBundle(directory: string, includePlayers: boolean) {
  const root = resolve(directory), parent = dirname(root)
  await checkLegendAnalysisParents(root)
  const work = await mkdtemp(resolve(parent, '.legend-bundle-check-'))
  try { return (await separateFamilies(root, work, includePlayers)).counts }
  finally { if (legendAnalysisPathWithin(parent, work)) await rm(work, { recursive: true, force: true }) }
}

/** Validate/merge both families in isolation, then swap the complete history in one transaction. */
export async function publishLegendDailyBundle(input: string, output: string, includePlayers: boolean,
  generatedAt = new Date().toISOString()): Promise<void> {
  const directory = resolve(output), parent = dirname(directory)
  if (!legendAnalysisPathWithin(parent, directory)) throw new Error('履歴の保存先が不正です。')
  await checkLegendAnalysisParents(directory)
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const lock = resolve(parent, `.${basename(directory)}-daily.lock`)
  await writeFile(lock, `${process.pid}\n`, { flag: 'wx', mode: 0o600 })
  let work: string | undefined, originalMoved = false, committed = false
  try {
    work = await mkdtemp(resolve(parent, '.legend-bundle-'))
    const incoming = await separateFamilies(resolve(input), resolve(work, 'incoming'), includePlayers)
    const stage = resolve(work, 'stage'), playerStage = resolve(work, 'player-stage'), backup = resolve(work, 'backup')
    const existingInfo = await legendAnalysisFileInfo(directory), hasOriginal = existingInfo !== null
    let existingPlayers = false
    if (hasOriginal && (await readdir(directory)).length) {
      const existing = await separateFamilies(directory, resolve(work, 'existing'), 'optional')
      await move(existing.aggregate, stage)
      if (existing.players) { await move(existing.players, playerStage); existingPlayers = true }
    }
    await publishLegendAnalysisData(incoming.aggregate, stage, generatedAt)
    if (incoming.players) await publishLegendPlayersData(incoming.players, playerStage, generatedAt)
    if (incoming.players || existingPlayers) {
      await validateLegendPlayersDirectory(playerStage)
      await move(playerStage, resolve(stage, 'players'))
    }
    await checkLegendAnalysisParents(directory)
    if (hasOriginal) { await move(directory, backup); originalMoved = true }
    await move(stage, directory)
    committed = true
  } catch (error) {
    if (work && originalMoved && !committed) {
      try { await move(resolve(work, 'backup'), directory); originalMoved = false }
      catch { throw new Error('履歴の復旧が必要です。作業フォルダーの旧履歴を保持しています。') }
    }
    throw error
  } finally {
    if (work && (!originalMoved || committed) && legendAnalysisPathWithin(parent, work)) await rm(work, { recursive: true, force: true }).catch(() => {})
    await unlink(lock).catch(() => {})
  }
}
