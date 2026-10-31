import { fileURLToPath } from 'node:url'
import { validateSteamPlayerCountHistory } from './publish-steam-player-count.ts'

try {
  const result = await validateSteamPlayerCountHistory(fileURLToPath(new URL('../public/data/steam-player-count/', import.meta.url)))
  console.log(`Steam同時接続数検証完了: ${result.days}日 / ${result.observations}観測`)
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Steam同時接続数の検証に失敗しました。')
  process.exitCode = 1
}
