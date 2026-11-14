import { randomUUID } from 'node:crypto'
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { parseLegendCollectionHistory } from '../../src/lib/legendCollectionHistory.ts'
import { parseLegendPlayersDataset, parseLegendPlayersManifest, parseLegendRankedMatchSupplement } from '../../src/lib/legendPlayers.ts'
import type { LegendPlayersDataset, LegendRankedMatchSupplement } from '../../src/types/legendPlayers.ts'
import { checkLegendAnalysisParents, LEGEND_ANALYSIS_JSON_LIMIT, legendAnalysisFileInfo,
  legendAnalysisPathWithin, readLegendAnalysisJson } from './legend-analysis-files.ts'

type Environment = Record<string, string | undefined>

/** The same run's published ranking is the sole source of rows for the second stage. */
export async function readLegendMatchRanking(history: string, env: Environment): Promise<LegendPlayersDataset> {
  const raw = env.LEGEND_COLLECTION_RESULT
  if (!raw || raw.length > 4096) throw new Error('ランキングの取得結果を確認できません。')
  const [run] = parseLegendCollectionHistory({ schemaVersion: 1, runs: [JSON.parse(raw)] }).runs
  if (run.runId !== env.GITHUB_RUN_ID || String(run.runAttempt) !== env.LEGEND_COLLECTION_ATTEMPT
    || run.trigger !== env.GITHUB_EVENT_NAME || run.outcome !== 'partial' || run.phase !== 'profiles'
    || run.reason !== null || run.datasetId === null) throw new Error('ランキングの取得回が一致しません。')

  const players = resolve(history, 'public', 'players')
  const manifest = parseLegendPlayersManifest(await readLegendAnalysisJson(resolve(players, 'index.json')))
  const descriptor = manifest.datasets.find(dataset => dataset.id === run.datasetId)
  if (!descriptor || descriptor.totalCount !== run.rankingCount) throw new Error('公開されたランキングを確認できません。')
  const ranking = parseLegendPlayersDataset(await readLegendAnalysisJson(resolve(players, descriptor.path)), descriptor)
  if (ranking.schemaVersion !== 4) throw new Error('対戦数の追加に対応したランキングが必要です。')
  return ranking
}

function legendMatchResultPath(directory: string, ranking: LegendPlayersDataset): string {
  const path = resolve(directory, `${ranking.id}.json`)
  if (!legendAnalysisPathWithin(directory, path) || !/^legend-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/.test(ranking.id)) {
    throw new Error('対戦数の保存先が不正です。')
  }
  return path
}

export async function readPublishedLegendMatchResult(history: string, ranking: LegendPlayersDataset): Promise<LegendRankedMatchSupplement | null> {
  const directory = resolve(history, 'match-counts')
  await checkLegendAnalysisParents(directory)
  const path = legendMatchResultPath(directory, ranking)
  if (!await legendAnalysisFileInfo(path)) return null
  return parseLegendRankedMatchSupplement(await readLegendAnalysisJson(path), ranking)
}

/** Preserve a previous result on retries and never overwrite an immutable ranking or result. */
export async function publishLegendMatchResult(input: string, history: string, ranking: LegendPlayersDataset): Promise<void> {
  const result = parseLegendRankedMatchSupplement(await readLegendAnalysisJson(input), ranking)
  const directory = resolve(history, 'match-counts')
  await checkLegendAnalysisParents(directory)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await checkLegendAnalysisParents(directory)
  const target = legendMatchResultPath(directory, ranking)
  const lock = resolve(directory, `.${ranking.id}.lock`)
  await writeFile(lock, `${process.pid}\n`, { flag: 'wx', mode: 0o600 })
  const temporary = resolve(directory, `.${randomUUID()}.tmp`)
  try {
    const previous = await readPublishedLegendMatchResult(history, ranking)
    if (previous) {
      if (!isDeepStrictEqual(previous, result)) throw new Error('同じ取得回の対戦数を変更できません。')
      return
    }
    await writeLegendMatchResult(temporary, result)
    await checkLegendAnalysisParents(directory)
    await rename(temporary, target)
  } finally {
    await unlink(temporary).catch(() => {})
    await unlink(lock).catch(() => {})
  }
}

export async function writeLegendMatchResult(path: string, value: LegendRankedMatchSupplement): Promise<void> {
  const json = `${JSON.stringify(value, null, 2)}\n`
  if (Buffer.byteLength(json, 'utf8') > LEGEND_ANALYSIS_JSON_LIMIT) throw new Error('レジェンドの対戦数JSONが上限を超えています。')
  await writeFile(path, json, { flag: 'wx', mode: 0o600 })
}
