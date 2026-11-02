import { fileURLToPath } from 'node:url'
import { validateSteamPlayerCountHistory } from './publish-steam-player-count.ts'
import { STEAM_PLAYER_COUNT_GAMES } from '../src/lib/steamPlayerCountGames.ts'

try {
  for (const game of STEAM_PLAYER_COUNT_GAMES) {
    const directory = fileURLToPath(new URL(`../public/${game.bundledPath}/`, import.meta.url))
    const result = await validateSteamPlayerCountHistory(directory, game.appId)
    console.log(`Steam同時接続数検証完了（${game.label}）: ${result.days}日 / ${result.observations}観測`)
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Steam同時接続数の検証に失敗しました。')
  process.exitCode = 1
}
