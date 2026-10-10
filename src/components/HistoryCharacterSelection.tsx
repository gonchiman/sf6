import type { ReactNode } from 'react'
import type { WinRateFighter } from '../types/winRates'
import { CharacterSeriesKey } from './CharacterSeriesKey'
import { ComparisonSelection } from './ComparisonSelection'

type Props = {
  characters: readonly WinRateFighter[]
  selectedIds: readonly string[]
  onChange: (ids: string[]) => void
  renderKey?: (id: string) => ReactNode
}

export function HistoryCharacterSelection({ characters, selectedIds, onChange, renderKey }: Props) {
  return <ComparisonSelection items={characters.map(fighter => ({ id: fighter.characterId, name: fighter.name }))}
    selectedIds={selectedIds} onChange={onChange} label="キャラクター" selectionLabel="選択中のキャラクター"
    pickerLabel="キャラを選択" legendLabel="比較するキャラクター" searchLabel="キャラを検索"
    emptyLabel="該当するキャラがありません" renderKey={renderKey ?? (id => <CharacterSeriesKey characterId={id} />)} />
}
