import { useId, useLayoutEffect, useRef, useState } from 'react'
import type { WinRateFighter } from '../types/winRates'
import { CharacterSeriesKey } from './CharacterSeriesKey'

type Props = {
  characters: readonly WinRateFighter[]
  selectedIds: readonly string[]
  onChange: (ids: string[]) => void
}

export function HistoryCharacterSelection({ characters, selectedIds, onChange }: Props) {
  const [search, setSearch] = useState('')
  const searchId = useId()
  const detailsRef = useRef<HTMLDetailsElement>(null)
  const chipListRef = useRef<HTMLUListElement>(null)
  const removedIndexRef = useRef<number | null>(null)
  const selected = new Set(selectedIds)
  const visibleCharacters = characters.filter(fighter => `${fighter.name} ${fighter.characterId}`.toLowerCase().includes(search.trim().toLowerCase()))
  const name = (id: string) => characters.find(fighter => fighter.characterId === id)?.name ?? id.toUpperCase()
  const toggle = (id: string, checked: boolean) => {
    if (checked && !selected.has(id)) onChange([...selectedIds, id])
    else if (!checked && selectedIds.length > 1) onChange(selectedIds.filter(value => value !== id))
  }
  useLayoutEffect(() => {
    const index = removedIndexRef.current
    if (index === null) return
    removedIndexRef.current = null
    const buttons = chipListRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')
    const next = buttons?.[Math.min(index, buttons.length - 1)]
    if (next) next.focus()
    else detailsRef.current?.querySelector('summary')?.focus()
  }, [selectedIds])

  return <div className="history-character-selection">
    <div className="history-chosen-characters" aria-label="選択中のキャラクター">
      <span className="history-character-label">キャラクター</span>
      <ul ref={chipListRef}>{selectedIds.map((id, index) => <li key={id}>
        <CharacterSeriesKey characterId={id} /><span>{name(id)}</span>
        <button type="button" aria-label={`${name(id)}を比較から外す`} disabled={selectedIds.length === 1}
          onClick={() => { removedIndexRef.current = index; toggle(id, false) }}>×</button>
      </li>)}</ul>
    </div>
    <details ref={detailsRef} className="history-character-picker" onKeyDown={event => {
      if (event.key === 'Escape') {
        event.preventDefault()
        if (detailsRef.current) {
          detailsRef.current.open = false
          detailsRef.current.querySelector('summary')?.focus()
        }
      }
    }}>
      <summary>キャラを選択</summary>
      <fieldset>
        <legend className="win-rate-history-visually-hidden">比較するキャラクター</legend>
        <label className="history-character-search" htmlFor={searchId}><span className="win-rate-history-visually-hidden">キャラを検索</span>
          <input id={searchId} type="search" aria-label="キャラを検索" placeholder="キャラを検索" value={search} onChange={event => setSearch(event.target.value)} />
        </label>
        <div className="history-character-options">{visibleCharacters.map(fighter => <label key={fighter.characterId}>
          <input type="checkbox" checked={selected.has(fighter.characterId)}
            disabled={selectedIds.length === 1 && selected.has(fighter.characterId)}
            onChange={event => toggle(fighter.characterId, event.target.checked)} />
          <span>{fighter.name}</span>
        </label>)}</div>
        {visibleCharacters.length === 0 && <p className="history-character-empty" role="status">該当するキャラがありません</p>}
      </fieldset>
    </details>
  </div>
}
