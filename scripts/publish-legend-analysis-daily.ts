import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { publishLegendDailyBundle } from './lib/legend-analysis-daily-bundle.ts'
import { publishLegendMatchResult, readLegendMatchRanking } from './lib/legend-ranked-match-history.ts'
import { isAllowedLegendDailyExecution, legendDailyIncludesPlayers, LegendDailyError } from './collect-legend-analysis-daily.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const LEGEND_DAILY_INCOMING = resolve(ROOT, '.local/legend-analysis-daily/incoming/public')
export const LEGEND_DAILY_HISTORY_ROOT = resolve(ROOT, '.local/legend-analysis-daily/history')
export const LEGEND_DAILY_HISTORY = resolve(LEGEND_DAILY_HISTORY_ROOT, 'public')
const LEGEND_MATCH_INCOMING = resolve(ROOT, '.local/legend-analysis-daily/match-incoming/result.json')

export async function publishLegendDaily(dependencies: {
  env?: Record<string, string | undefined>
  publish?: typeof publishLegendDailyBundle
} = {}): Promise<void> {
  const env = dependencies.env ?? process.env
  if (!isAllowedLegendDailyExecution(env)) throw new LegendDailyError('runner')
  const includePlayers = legendDailyIncludesPlayers(env)
  await (dependencies.publish ?? publishLegendDailyBundle)(LEGEND_DAILY_INCOMING, LEGEND_DAILY_HISTORY, includePlayers)
}

export async function publishLegendRankedMatchesDaily(env = process.env): Promise<void> {
  if (!isAllowedLegendDailyExecution(env)) throw new LegendDailyError('runner')
  if (!legendDailyIncludesPlayers(env)) throw new LegendDailyError('players-setting')
  const ranking = await readLegendMatchRanking(LEGEND_DAILY_HISTORY_ROOT, env)
  await publishLegendMatchResult(LEGEND_MATCH_INCOMING, LEGEND_DAILY_HISTORY_ROOT, ranking)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2)
  try {
    if (!args.length) {
      await publishLegendDaily()
      console.log('レジェンド帯の集計履歴を反映しました。')
    } else if (args.length === 1 && args[0] === '--match-counts') {
      await publishLegendRankedMatchesDaily()
      console.log('レジェンド帯の対戦数を履歴に反映しました。')
    } else throw new LegendDailyError('arguments')
  } catch {
    console.error('レジェンド帯の履歴を反映できませんでした。以前の正常データを保持してください。')
    process.exitCode = 1
  }
}
