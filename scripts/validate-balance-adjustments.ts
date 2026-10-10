import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseBalanceAdjustmentCatalog } from '../src/lib/balanceAdjustments.ts'

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const input = process.argv[2] ?? fileURLToPath(new URL('../public/data/balance-adjustments.json', import.meta.url))
  try {
    const catalog = parseBalanceAdjustmentCatalog(JSON.parse(await readFile(input, 'utf8')))
    console.log(`バランス調整データ検証完了: ${catalog.events.length}件 (${catalog.coverage.fromMonth}〜${catalog.coverage.toMonth})`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
