import { parseUpdateArguments, UPDATE_HELP, updateWinRates } from './lib/update-win-rates.ts'

try {
  const now = new Date()
  const options = parseUpdateArguments(process.argv.slice(2), { now })
  if (options.help) console.log(UPDATE_HELP)
  else {
    const result = await updateWinRates(options, now)
    console.log(`勝率データ更新完了: ${result.months.join(', ')} / 更新${result.updatedDatasets}条件 / 保存済み全${result.datasets}条件・${result.cells}セル`)
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
}
