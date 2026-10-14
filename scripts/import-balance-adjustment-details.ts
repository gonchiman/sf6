import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseCharacterManifest } from '../src/lib/characters.ts'
import { parseBalanceAdjustmentCatalog } from '../src/lib/balanceAdjustments.ts'
import { parseBalanceAdjustmentDetails } from '../src/lib/balanceAdjustmentDetails.ts'
import { balanceAdjustmentDetailsFromSnapshot } from './lib/balance-adjustment-snapshot.ts'
import type { BalanceAdjustmentPatchDetails } from '../src/types/balanceAdjustmentDetails.ts'

const json = async (path: string): Promise<unknown> => JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''))

/** Validate the complete snapshot before publishing, following character imports. */
export async function importBalanceAdjustmentSnapshot(inputPath: string, outputPath: string): Promise<{ patches: number; ready: number; unlisted: number; changes: number }> {
  const manifest = parseCharacterManifest(await json(fileURLToPath(new URL('../public/data/characters/index.json', import.meta.url))))
  const history = parseBalanceAdjustmentCatalog(await json(fileURLToPath(new URL('../public/data/balance-adjustments.json', import.meta.url))))
  const input = resolve(inputPath)
  const files = (await stat(input)).isDirectory()
    ? (await readdir(input, { withFileTypes: true })).filter((entry) => entry.isFile() && entry.name.endsWith('.snapshot.json')).map((entry) => resolve(input, entry.name)).sort()
    : [input]
  if (!files.length) throw new Error('調整詳細の取得記録がありません。')
  const generatedAt = new Date().toISOString()
  const patches = new Map<string, BalanceAdjustmentPatchDetails>()
  try {
    const existing = parseBalanceAdjustmentDetails(await json(resolve(outputPath)), history, manifest)
    for (const patch of existing.patches) patches.set(patch.adjustmentId, patch)
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
  }
  const imported = new Set<string>()
  for (const file of files) {
    const patch = balanceAdjustmentDetailsFromSnapshot(await json(file), manifest, generatedAt, history).patches[0]
    if (imported.has(patch.adjustmentId)) throw new Error(`同じ調整リストの取得記録が重複しています: ${patch.adjustmentId}`)
    imported.add(patch.adjustmentId)
    patches.set(patch.adjustmentId, patch)
  }
  const historyOrder = new Map(history.events.map((event, index) => [event.id, index]))
  const catalog = parseBalanceAdjustmentDetails({ schemaVersion: 1, generatedAt,
    patches: [...patches.values()].sort((a, b) => historyOrder.get(a.adjustmentId)! - historyOrder.get(b.adjustmentId)!),
  }, history, manifest)
  await mkdir(dirname(resolve(outputPath)), { recursive: true })
  await writeFile(resolve(outputPath), `${JSON.stringify(catalog, null, 2)}\n`, 'utf8')
  return { patches: catalog.patches.length,
    ready: catalog.patches.reduce((sum, patch) => sum + patch.characters.filter((item) => item.status === 'ready').length, 0),
    unlisted: catalog.patches.reduce((sum, patch) => sum + patch.characters.filter((item) => item.status === 'unlisted').length, 0),
    changes: catalog.patches.reduce((sum, patch) => sum + patch.common.changes.length + patch.characters.reduce((count, item) => count + item.changes.length, 0), 0) }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const input = process.argv[2] ?? fileURLToPath(new URL('../.local/balance-adjustments/', import.meta.url))
  const output = process.argv[3] ?? fileURLToPath(new URL('../public/data/balance-adjustment-details.json', import.meta.url))
  try {
    const result = await importBalanceAdjustmentSnapshot(input, output)
    console.log(`調整詳細取込完了: ${result.patches}件 / 延べ${result.ready}キャラ掲載 / 延べ${result.unlisted}キャラ未掲載 / ${result.changes}変更箇所`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
