import type { CategoryFilter } from '../lib/balanceAdjustmentCategories'
import '../league-total-win-rates.css'

export function BalanceAdjustmentCategoryFilter({ options, value, onChange, controls, disabled }: {
  options: readonly { key: string; label: string }[]
  value: CategoryFilter
  onChange: (value: CategoryFilter) => void
  controls: string
  disabled: boolean
}) {
  const selected = new Set(value.mode === 'all' ? options.map(option => option.key) : value.keys)
  const toggle = (key: string, checked: boolean) => {
    const keys = new Set(selected)
    if (checked) keys.add(key)
    else keys.delete(key)
    onChange({ mode: 'selected', keys: options.filter(option => keys.has(option.key)).map(option => option.key) })
  }

  return <fieldset className="balance-adjustment-category-filter" disabled={disabled}>
    <legend>分類</legend>
    <div className="balance-adjustment-category-actions">
      <label className="win-rates-chart-value-toggle"><input type="checkbox" checked={value.mode === 'all'} aria-controls={controls}
        onChange={event => onChange(event.target.checked ? { mode: 'all' } : { mode: 'selected', keys: [] })} />すべて</label>
      <button type="button" className="balance-adjustment-category-clear"
        aria-controls={controls} onClick={() => onChange({ mode: 'selected', keys: [] })}>選択を解除</button>
    </div>
    <div className="balance-adjustment-category-options">
      {options.map(option => <label key={option.key} className="win-rates-chart-value-toggle">
        <input type="checkbox" checked={selected.has(option.key)} aria-controls={controls}
          onChange={event => toggle(option.key, event.target.checked)} /><span>{option.label}</span>
      </label>)}
    </div>
  </fieldset>
}
