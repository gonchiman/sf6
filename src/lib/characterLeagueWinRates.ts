import type { CharacterLeagueWinRates } from '../types/characterLeagueWinRates.ts'
import type { LeagueTotalWinRates, LeagueTotalWinRateSelection } from '../types/leagueTotalWinRates.ts'
import type { HistoryControlType, WinRateHistoryPoint } from '../types/winRateHistory.ts'

/** Extract one stable character ID without sorting, averaging, or replacing its published points. */
export function createCharacterLeagueWinRates(
  comparison: LeagueTotalWinRates,
  selection: LeagueTotalWinRateSelection,
  characterId: string,
  fallbackName: string,
): CharacterLeagueWinRates {
  const controls: HistoryControlType[] = selection.operationMode === 'combined' ? ['combined'] : ['classic', 'modern']
  const rows = comparison.rows.filter(row => row.characterId === characterId)
  const metadataByLeague = new Map(comparison.metadata.map(item => [item.league, item]))
  return {
    characterId,
    characterName: rows[0]?.name ?? fallbackName,
    leagues: [...comparison.leagues],
    series: controls.map(controlType => {
      const row = rows.find(item => item.controlType === (controlType === 'combined' ? null : controlType))
      return {
        controlType,
        points: row?.values ?? comparison.leagues.map((league): WinRateHistoryPoint => {
          const metadata = metadataByLeague.get(league)
          const dataset = metadata?.status === 'ready' ? metadata.result?.dataset : undefined
          return {
            month: selection.month,
            status: metadata?.status === 'ready' ? 'unlisted' : metadata?.status === 'error' ? 'error' : 'unavailable',
            total: null,
            percentHundredths: null,
            capturedAt: dataset?.capturedAt ?? null,
            source: dataset?.source ?? null,
          }
        }),
      }
    }),
  }
}
