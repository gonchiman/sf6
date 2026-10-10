import type { WinRateFighter } from '../types/winRates'
import { CharacterSeriesKey } from './CharacterSeriesKey'
import { ComparisonSelection } from './ComparisonSelection'

type Props = {
  characters: readonly WinRateFighter[]
  selectedIds: readonly string[]
  onChange: (ids: string[]) => void
}

export function HistoryCharacterSelection({ characters, selectedIds, onChange }: Props) {
  return <ComparisonSelection items={characters.map(fighter => ({ id: fighter.characterId, name: fighter.name }))}
    selectedIds={selectedIds} onChange={onChange} label="キャラクター" selectionLabel="選択中のキャラクター"
    pickerLabel="キャラを選択" legendLabel="比較するキャラクター" searchLabel="キャラを検索"
    emptyLabel="該当するキャラがありません" renderKey={id => <CharacterSeriesKey characterId={id} />} />
}
