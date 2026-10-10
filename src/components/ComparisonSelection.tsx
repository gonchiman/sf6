import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import '../win-rate-history.css'
import '../win-rate-history-chart.css'
import '../comparison-selection.css'

type Props = {
  items: readonly { id: string; name: string }[]
  selectedIds: readonly string[]
  onChange: (ids: string[]) => void
  label: string
  selectionLabel: string
  pickerLabel: string
  legendLabel: string
  renderKey: (id: string) => ReactNode
  searchLabel?: string
  emptyLabel?: string
  showOptionKeys?: boolean
  layout?: 'picker' | 'grid'
  selectionCountLabel?: (count: number) => string
  minimumSelectionLabel?: string
}

/** Shared comparison selection; the picker restores focus after chip removal. */
export function ComparisonSelection({ items, selectedIds, onChange, label, selectionLabel, pickerLabel,
  legendLabel, renderKey, searchLabel, emptyLabel = '該当する項目がありません', showOptionKeys = false,
  layout = 'picker', selectionCountLabel = count => `${count}件選択中`, minimumSelectionLabel = '1件以上選択' }: Props) {
  const [search, setSearch] = useState('')
  const searchId = useId()
  const labelId = useId()
  const hintId = useId()
  const detailsRef = useRef<HTMLDetailsElement>(null)
  const chipListRef = useRef<HTMLUListElement>(null)
  const removedIndexRef = useRef<number | null>(null)
  const selected = new Set(selectedIds)
  const visible = items.filter(item => `${item.name} ${item.id}`.toLowerCase().includes(search.trim().toLowerCase()))
  const name = (id: string) => items.find(item => item.id === id)?.name ?? id.toUpperCase()
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

  if (layout === 'grid') return <div className="comparison-selection comparison-selection-grid">
    <div className="comparison-grid-heading">
      <span id={labelId}>{label}</span>
      <span className="comparison-grid-count" aria-live="polite" aria-atomic="true">{selectionCountLabel(selectedIds.length)}</span>
    </div>
    <div className="comparison-grid-options" role="group" aria-labelledby={labelId} aria-describedby={hintId}>
      {items.map(item => <button key={item.id} type="button" className="comparison-grid-option"
        aria-pressed={selected.has(item.id)} aria-disabled={selectedIds.length === 1 && selected.has(item.id)}
        aria-describedby={hintId} onClick={() => toggle(item.id, !selected.has(item.id))}>
        {showOptionKeys && renderKey(item.id)}<span className="comparison-grid-name">{item.name}</span>
        <span className="comparison-grid-check" aria-hidden="true">✓</span>
      </button>)}
    </div>
    <p id={hintId} className="comparison-grid-hint">{minimumSelectionLabel}</p>
  </div>

  return <div className="comparison-selection history-character-selection">
    <div className="history-chosen-characters" aria-label={selectionLabel}>
      <span className="history-character-label">{label}</span>
      <ul ref={chipListRef}>{selectedIds.map((id, index) => <li key={id}>
        {renderKey(id)}<span>{name(id)}</span>
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
      <summary>{pickerLabel}</summary>
      <fieldset>
        <legend className="win-rate-history-visually-hidden">{legendLabel}</legend>
        {searchLabel && <label className="history-character-search" htmlFor={searchId}>
          <span className="win-rate-history-visually-hidden">{searchLabel}</span>
          <input id={searchId} type="search" aria-label={searchLabel} placeholder={searchLabel}
            value={search} onChange={event => setSearch(event.target.value)} />
        </label>}
        <div className="history-character-options">{visible.map(item => <label key={item.id}>
          <input type="checkbox" checked={selected.has(item.id)} disabled={selectedIds.length === 1 && selected.has(item.id)}
            onChange={event => toggle(item.id, event.target.checked)} />
          {showOptionKeys && renderKey(item.id)}<span>{item.name}</span>
        </label>)}</div>
        {visible.length === 0 && <p className="history-character-empty" role="status">{emptyLabel}</p>}
      </fieldset>
    </details>
  </div>
}
