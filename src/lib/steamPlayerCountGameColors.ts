import type { CharacterSeriesMarker } from './seriesColors.ts'
import type { SteamPlayerCountAppId } from '../types/steamPlayerCount.ts'

export interface SteamPlayerCountGameStyle {
  readonly color: string
  readonly dashArray: string | undefined
  readonly marker: CharacterSeriesMarker
}

const styles: Readonly<Record<SteamPlayerCountAppId, SteamPlayerCountGameStyle>> = Object.freeze({
  1364780: Object.freeze({ color: '#436b91', dashArray: undefined, marker: 'circle' }),
  1778820: Object.freeze({ color: '#ac5b2d', dashArray: '8 4', marker: 'square' }),
  1384160: Object.freeze({ color: '#397a63', dashArray: '3 4', marker: 'triangle' }),
  2157560: Object.freeze({ color: '#805b9c', dashArray: '10 3 2 3', marker: 'diamond' }),
  1498570: Object.freeze({ color: '#8b7030', dashArray: '2 3', marker: 'circle' }),
})
const labels: Readonly<Record<SteamPlayerCountAppId, string>> = Object.freeze({
  1364780: 'SF6', 1778820: 'TEKKEN 8', 1384160: 'GGST', 2157560: 'GBVSR', 1498570: 'KOF XV',
})
const unknownStyle: SteamPlayerCountGameStyle = Object.freeze({ color: '#666666', dashArray: '4 4', marker: 'square' })

/** Steam app IDs own their colors, independently of ordering and selection. */
export function steamPlayerCountGameStyle(appId: number): SteamPlayerCountGameStyle {
  return Object.hasOwn(styles, appId) ? styles[appId as SteamPlayerCountAppId] : unknownStyle
}

export function steamPlayerCountGameLabel(appId: number): string {
  return Object.hasOwn(labels, appId) ? labels[appId as SteamPlayerCountAppId] : `App ${appId}`
}
