import { randomUUID } from 'node:crypto'
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  LEGEND_COLLECTION_HISTORY_LIMIT, LEGEND_COLLECTION_HISTORY_PATH, parseLegendCollectionHistory,
  type LegendCollectionRun,
} from '../src/lib/legendCollectionHistory.ts'
import { isAllowedLegendDailyExecution, legendDailyIncludesPlayers, LegendDailyError } from './collect-legend-analysis-daily.ts'
import { checkLegendAnalysisParents, legendAnalysisFileInfo, readLegendAnalysisJson } from './lib/legend-analysis-files.ts'
import { finalizeLegendCollectionRun } from './lib/legend-collection-run.ts'
import { LEGEND_DAILY_HISTORY } from './publish-legend-analysis-daily.ts'

export async function updateLegendCollectionHistory(historyDirectory: string, run: LegendCollectionRun): Promise<void> {
  const path = resolve(historyDirectory, LEGEND_COLLECTION_HISTORY_PATH), directory = dirname(path)
  await checkLegendAnalysisParents(directory)
  const old = await legendAnalysisFileInfo(path) ? parseLegendCollectionHistory(await readLegendAnalysisJson(path)).runs : []
  const runs = [run, ...old.filter(item => item.runId !== run.runId || item.runAttempt !== run.runAttempt)]
    .sort((a, b) => b.endedAt.localeCompare(a.endedAt) || b.runId.length - a.runId.length
      || b.runId.localeCompare(a.runId) || b.runAttempt - a.runAttempt)
    .slice(0, LEGEND_COLLECTION_HISTORY_LIMIT)
  const next = parseLegendCollectionHistory({ schemaVersion: 1, runs })
  if (JSON.stringify(old) === JSON.stringify(next.runs)) return

  await mkdir(directory, { recursive: true, mode: 0o700 })
  const temporary = resolve(directory, `.legend-runs-${randomUUID()}.tmp`)
  try {
    await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    await rename(temporary, path)
  } finally { await unlink(temporary).catch(() => {}) }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 2 || !isAllowedLegendDailyExecution(process.env)) throw new LegendDailyError('runner')
    if (!legendDailyIncludesPlayers(process.env)) throw new LegendDailyError('players-setting')
    const result = finalizeLegendCollectionRun(process.env, new Date().toISOString())
    await updateLegendCollectionHistory(dirname(LEGEND_DAILY_HISTORY), result)
    console.log('レジェンド帯の取得結果を履歴に反映しました。')
  } catch (error) {
    console.error(error instanceof LegendDailyError ? error.message : 'レジェンド帯の取得結果を履歴に反映できませんでした。')
    process.exitCode = 1
  }
}
