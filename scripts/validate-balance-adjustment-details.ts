import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseBalanceAdjustmentDetails } from '../src/lib/balanceAdjustmentDetails.ts'
import { parseBalanceAdjustmentCatalog } from '../src/lib/balanceAdjustments.ts'
import { parseCharacterManifest } from '../src/lib/characters.ts'

export async function validateBalanceAdjustmentDetails(
  detailsFile: string, historyFile: string, characterFile: string,
): Promise<{ patches: number; characters: number; unlisted: number; changes: number; commonChanges: number }> {
  const [detailsInput, historyInput, characterInput] = await Promise.all([
    readFile(detailsFile, 'utf8'), readFile(historyFile, 'utf8'), readFile(characterFile, 'utf8'),
  ])
  const history = parseBalanceAdjustmentCatalog(JSON.parse(historyInput))
  const manifest = parseCharacterManifest(JSON.parse(characterInput))
  const details = parseBalanceAdjustmentDetails(JSON.parse(detailsInput), history, manifest)
  if (details.patches.length === 0) throw new Error('収録済みの調整詳細がありません。')
  const imported = new Set(details.patches.map(({ adjustmentId }) => adjustmentId))
  if (details.patches.length !== history.events.length || history.events.some(({ id }) => !imported.has(id))) {
    throw new Error('調整履歴の全件に対応する技別内容が必要です。')
  }
  let characters = 0
  let unlisted = 0
  let changes = 0
  let commonChanges = 0
  for (const patch of details.patches) {
    // Every imported patch must retain explicit confirmed status for every current character.
    if (patch.characters.length !== manifest.characters.length
      || manifest.characters.some(({ id }) => !patch.characters.some(({ characterId }) => characterId === id))) {
      throw new Error(`全キャラの掲載状況の確認が必要です: ${patch.adjustmentId}`)
    }
    if (patch.adjustmentId === 'battle-change-20260803'
      && (patch.characters.filter(({ status }) => status === 'ready').length !== 30
        || patch.characters.filter(({ status }) => status === 'unlisted').length !== 1
        || patch.characters.find(({ characterId }) => characterId === 'yasmine')?.status !== 'unlisted')) {
      throw new Error('2026年8月3日の公式掲載範囲（掲載30キャラ・ヤスミン未掲載）と一致しません。')
    }
    characters += patch.characters.length
    unlisted += patch.characters.filter(({ status }) => status === 'unlisted').length
    commonChanges += patch.common.changes.length
    changes += patch.common.changes.length + patch.characters.reduce((total, entry) => total + entry.changes.length, 0)
  }
  if (!details.patches.some(({ adjustmentId }) => adjustmentId === 'battle-change-20260803')) {
    throw new Error('初期収録対象の2026年8月3日がありません。')
  }
  return { patches: details.patches.length, characters, unlisted, changes, commonChanges }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const data = fileURLToPath(new URL('../public/data/', import.meta.url))
  try {
    const result = await validateBalanceAdjustmentDetails(
      process.argv[2] ?? resolve(data, 'balance-adjustment-details.json'),
      process.argv[3] ?? resolve(data, 'balance-adjustments.json'),
      process.argv[4] ?? resolve(data, 'characters/index.json'),
    )
    console.log(`バランス調整詳細検証完了: ${result.patches}件 / ${result.characters}キャラ（未掲載${result.unlisted}） / ${result.changes}変更（共通${result.commonChanges}）`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
