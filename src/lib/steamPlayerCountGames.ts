import type { SteamPlayerCountGame } from '../types/steamPlayerCount.ts'
export type { SteamPlayerCountAppId, SteamPlayerCountGame } from '../types/steamPlayerCount.ts'

/** One registry binds each title to its source and its own publication directory. */
export const STEAM_PLAYER_COUNT_GAMES: readonly SteamPlayerCountGame[] = Object.freeze(([
  { key: 'sf6', appId: 1364780, label: 'Street Fighter 6' },
  { key: 'tekken-8', appId: 1778820, label: 'TEKKEN 8' },
  { key: 'ggst', appId: 1384160, label: 'GUILTY GEAR -STRIVE-' },
  { key: 'gbvsr', appId: 2157560, label: 'Granblue Fantasy Versus: Rising' },
  { key: 'kof-xv', appId: 1498570, label: 'THE KING OF FIGHTERS XV' },
] as const).map(game => Object.freeze({
  ...game,
  sourceUrl: `https://api.steampowered.com/ISteamUserStats/GetNumberOfCurrentPlayers/v1/?appid=${game.appId}`,
  historyPath: game.key === 'sf6' ? 'public' : `games/${game.key}`,
  bundledPath: game.key === 'sf6' ? 'data/steam-player-count' : `data/steam-player-count-games/${game.key}`,
})))

export const DEFAULT_STEAM_PLAYER_COUNT_GAME = STEAM_PLAYER_COUNT_GAMES[0]

export function getSteamPlayerCountGame(appId: number): SteamPlayerCountGame {
  const game = STEAM_PLAYER_COUNT_GAMES.find(item => item.appId === appId)
  if (!game) throw new Error('Steam同時接続数の対象ゲームが不正です。')
  return game
}
