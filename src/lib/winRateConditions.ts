import type { WinRateEdition, WinRateOperationMode, WinRateSource } from '../types/winRates.ts'

export const WIN_RATE_EDITIONS = ['general', 'master'] as const

export const WIN_RATE_EDITION_SOURCES: Readonly<Record<WinRateEdition, WinRateSource>> = {
  general: { url: 'https://www.streetfighter.com/6/buckler/ja-jp/stats/dia', title: 'Buckler 総合版 対戦ダイアグラム' },
  master: { url: 'https://www.streetfighter.com/6/buckler/ja-jp/stats/dia_master', title: 'Buckler マスター版 対戦ダイアグラム' },
}

export const WIN_RATE_EDITION_LEAGUES: Readonly<Record<WinRateEdition, readonly string[]>> = {
  general: ['ROOKIE', 'IRON', 'BRONZE', 'SILVER', 'GOLD', 'PLATINUM', 'DIAMOND', 'MASTER'],
  master: ['MASTER', 'HIGH_MASTER', 'GRAND_MASTER', 'ULTIMATE_MASTER'],
}

export const WIN_RATE_EDITION_OPERATION_MODES: Readonly<Record<WinRateEdition, readonly WinRateOperationMode[]>> = {
  general: ['combined', 'separate'],
  master: ['combined'],
}

export function editionOf(value: { edition?: WinRateEdition }): WinRateEdition {
  return value.edition ?? 'general'
}

export function leagueLabel(value: string): string {
  const labels: Record<string, string> = {
    HIGH_MASTER: 'HIGH MASTER', GRAND_MASTER: 'GRAND MASTER', ULTIMATE_MASTER: 'ULTIMATE MASTER',
  }
  return Object.hasOwn(labels, value) ? labels[value] : value
}
