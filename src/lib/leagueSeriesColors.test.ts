import assert from 'node:assert/strict'
import test from 'node:test'
import { LEAGUE_SERIES_STYLES, leagueSeriesStyle, UNKNOWN_LEAGUE_SERIES_STYLE } from './leagueSeriesColors.ts'
import { WIN_RATE_EDITION_LEAGUES } from './winRateConditions.ts'

function contrastAgainstWhite(color: string): number {
  const channels = [1, 3, 5].map(offset => Number.parseInt(color.slice(offset, offset + 2), 16) / 255)
    .map(channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
  const luminance = channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
  return 1.05 / (luminance + 0.05)
}

test('両統計版の全リーグIDを網羅し、各IDの色・線種・記号を固定する', () => {
  const known = [...new Set(Object.values(WIN_RATE_EDITION_LEAGUES).flat())]
  assert.deepEqual(Object.keys(LEAGUE_SERIES_STYLES).sort(), known.sort())
  assert.deepEqual(LEAGUE_SERIES_STYLES, {
    ROOKIE: { color: '#365b8a', dashArray: undefined, marker: 'circle' },
    IRON: { color: '#56616f', dashArray: undefined, marker: 'square' },
    BRONZE: { color: '#8e5a2b', dashArray: undefined, marker: 'triangle' },
    SILVER: { color: '#577083', dashArray: undefined, marker: 'diamond' },
    GOLD: { color: '#917000', dashArray: '7 4', marker: 'circle' },
    PLATINUM: { color: '#237b7f', dashArray: '7 4', marker: 'square' },
    DIAMOND: { color: '#6752a3', dashArray: '7 4', marker: 'triangle' },
    MASTER: { color: '#245ea8', dashArray: '7 4', marker: 'diamond' },
    HIGH_MASTER: { color: '#a53f58', dashArray: '2 4', marker: 'circle' },
    GRAND_MASTER: { color: '#387344', dashArray: '2 4', marker: 'square' },
    ULTIMATE_MASTER: { color: '#8c408e', dashArray: '2 4', marker: 'triangle' },
  })
})

test('並べ替え・絞り込み・追加後も同じリーグには同じ固定styleを返す', () => {
  const first = ['GOLD', 'MASTER'].map(leagueSeriesStyle)
  const reordered = ['HIGH_MASTER', 'MASTER', 'DIAMOND', 'GOLD'].map(leagueSeriesStyle)
  assert.equal(first[0], reordered[3])
  assert.equal(first[1], reordered[1])
  assert.equal(leagueSeriesStyle('MASTER'), LEAGUE_SERIES_STYLES.MASTER)
  assert.ok(Object.isFrozen(LEAGUE_SERIES_STYLES))
  for (const style of Object.values(LEAGUE_SERIES_STYLES)) assert.ok(Object.isFrozen(style))
})

test('白背景とのコントラストを3:1以上にし、色以外の線種・記号でも系列を区別する', () => {
  const styles = Object.values(LEAGUE_SERIES_STYLES)
  for (const style of [...styles, UNKNOWN_LEAGUE_SERIES_STYLE]) {
    assert.match(style.color, /^#[0-9a-f]{6}$/)
    assert.ok(contrastAgainstWhite(style.color) >= 3, `${style.color} の白背景コントラスト`)
  }
  assert.equal(new Set(styles.map(style => `${style.dashArray ?? 'solid'}:${style.marker}`)).size, styles.length)
})

test('未知ID・表示名・大文字小文字違いを既知IDに推測変換せず専用グレーへ戻す', () => {
  for (const id of ['UNKNOWN', 'master', 'HIGH MASTER', ' MASTER', 'toString', '__proto__']) {
    assert.equal(leagueSeriesStyle(id), UNKNOWN_LEAGUE_SERIES_STYLE)
  }
  assert.equal(UNKNOWN_LEAGUE_SERIES_STYLE.color, '#666666')
  assert.ok(Object.values(LEAGUE_SERIES_STYLES).every(style => style.color !== UNKNOWN_LEAGUE_SERIES_STYLE.color))
})
