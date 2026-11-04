import assert from 'node:assert/strict'
import { test } from 'node:test'
import { STEAM_PLAYER_COUNT_GAMES } from './steamPlayerCountGames.ts'
import { steamPlayerCountGameLabel, steamPlayerCountGameStyle } from './steamPlayerCountGameColors.ts'

function luminance(hex: string) {
  const channels = [1, 3, 5].map(start => parseInt(hex.slice(start, start + 2), 16) / 255)
    .map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4)
  return .2126 * channels[0] + .7152 * channels[1] + .0722 * channels[2]
}

test('all five Steam app IDs keep a distinct fixed style and short label', () => {
  const original = STEAM_PLAYER_COUNT_GAMES.map(game => steamPlayerCountGameStyle(game.appId))
  assert.equal(new Set(original.map(style => style.color)).size, 5)
  assert.equal(new Set(original.map(style => style.dashArray ?? '')).size, 5)
  assert.deepEqual(STEAM_PLAYER_COUNT_GAMES.map(game => steamPlayerCountGameLabel(game.appId)), ['SF6', 'TEKKEN 8', 'GGST', 'GBVSR', 'KOF XV'])
  for (const game of [...STEAM_PLAYER_COUNT_GAMES].reverse()) {
    const style = steamPlayerCountGameStyle(game.appId)
    assert.equal(style, original[STEAM_PLAYER_COUNT_GAMES.indexOf(game)])
    assert.ok(Object.isFrozen(style))
    assert.ok(1.05 / (luminance(style.color) + .05) >= 3, `${game.label} must contrast against white`)
  }
  const unknown = steamPlayerCountGameStyle(-1)
  assert.ok(!original.includes(unknown))
  assert.equal(steamPlayerCountGameLabel(-1), 'App -1')
})
