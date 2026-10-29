import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { publishLegendDailyBundle } from './lib/legend-analysis-daily-bundle.ts'
import { isAllowedLegendDailyExecution, legendDailyIncludesPlayers, LegendDailyError } from './collect-legend-analysis-daily.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const LEGEND_DAILY_INCOMING = resolve(ROOT, '.local/legend-analysis-daily/incoming/public')
export const LEGEND_DAILY_HISTORY = resolve(ROOT, '.local/legend-analysis-daily/history/public')

export async function publishLegendDaily(dependencies: {
  env?: Record<string, string | undefined>
  publish?: typeof publishLegendDailyBundle
} = {}): Promise<void> {
  const env = dependencies.env ?? process.env
  if (!isAllowedLegendDailyExecution(env)) throw new LegendDailyError('runner')
  const includePlayers = legendDailyIncludesPlayers(env)
  await (dependencies.publish ?? publishLegendDailyBundle)(LEGEND_DAILY_INCOMING, LEGEND_DAILY_HISTORY, includePlayers)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.slice(2).length) { console.error('引数は指定できません。'); process.exitCode = 1 }
  else publishLegendDaily().then(() => console.log('レジェンド帯の集計履歴を反映しました。')).catch(() => {
    console.error('レジェンド帯の履歴を反映できませんでした。以前の正常データを保持してください。'); process.exitCode = 1
  })
}
