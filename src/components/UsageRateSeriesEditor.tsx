import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { MAX_USAGE_RATE_COMPARISON_SERIES } from '../lib/usageRateComparison'
import { USAGE_RATE_EDITION_LEAGUES } from '../lib/usageRates'
import type { UsageRateComparisonRow } from '../types/usageRateComparison'
import type { UsageRateEdition } from '../types/usageRates'
import { StatisticsPanel } from './StatisticsPanel'
import { UsageRateHistorySeriesKey } from './UsageRateHistoryChart'
import { usageRateLeagueLabel } from './controlTypeRatioFormatting'
import '../usage-rate-history.css'

type Character = { characterId: string; name: string }
type Condition = Pick<UsageRateComparisonRow, 'characterId' | 'characterName' | 'league' | 'controlType'>

const CONTROL_LABELS = { combined: '合算', classic: 'クラシック', modern: 'モダン' } as const
const GENERAL_CONTROLS = ['combined', 'classic', 'modern'] as const
const MASTER_CONTROLS = ['combined'] as const

function conditionKey(row: Pick<Condition, 'characterId' | 'league' | 'controlType'>): string {
  return JSON.stringify([row.characterId, row.league, row.controlType])
}

export function UsageRateSeriesEditor({ edition, rows, characters, onChange }: {
  edition: UsageRateEdition
  rows: readonly UsageRateComparisonRow[]
  characters: readonly Character[]
  onChange: (rows: UsageRateComparisonRow[]) => void
}) {
  const idPrefix = useId()
  const nextId = useRef(0)
  const characterSelects = useRef(new Map<string, HTMLSelectElement>())
  const addButton = useRef<HTMLButtonElement>(null)
  const pendingFocus = useRef<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const controls = edition === 'master' ? MASTER_CONTROLS : GENERAL_CONTROLS
  const leagues = USAGE_RATE_EDITION_LEAGUES[edition]

  useEffect(() => { setError(null) }, [edition])
  useLayoutEffect(() => {
    if (!pendingFocus.current) return
    const target = characterSelects.current.get(pendingFocus.current)
    if (target) target.focus()
    else addButton.current?.focus()
    pendingFocus.current = null
  }, [rows])

  function updateRow(rowId: string, patch: Partial<Condition>): void {
    const original = rows.find(row => row.id === rowId)
    if (!original) return
    const updated = { ...original, ...patch }
    if (rows.some(row => row.id !== rowId && conditionKey(row) === conditionKey(updated))) {
      setError('同じ条件の系列があります。')
      return
    }
    setError(null)
    onChange(rows.map(row => row.id === rowId ? updated : row))
  }

  function addRow(): void {
    if (rows.length >= MAX_USAGE_RATE_COMPARISON_SERIES) return
    const roster = new Map(characters.map(character => [character.characterId, character]))
    for (const row of rows) {
      if (!roster.has(row.characterId)) roster.set(row.characterId, { characterId: row.characterId, name: row.characterName })
    }
    const last = rows.at(-1)
    const firstCharacter = last ? roster.get(last.characterId) : roster.values().next().value
    if (!firstCharacter) { setError('追加できるキャラクターがありません。'); return }
    const league = last && leagues.includes(last.league) ? last.league : 'MASTER'
    const controlType = last && controls.some(control => control === last.controlType) ? last.controlType : controls[0]
    const condition = (character: Character, selectedLeague: string, control: Condition['controlType']): Condition => ({
      characterId: character.characterId, characterName: character.name, league: selectedLeague, controlType: control,
    })
    const candidates: Condition[] = [
      ...controls.filter(control => control !== controlType).map(control => condition(firstCharacter, league, control)),
      ...[...roster.values()].filter(character => character.characterId !== firstCharacter.characterId)
        .map(character => condition(character, league, controlType)),
      ...leagues.filter(item => item !== league).map(item => condition(firstCharacter, item, controlType)),
      ...[...roster.values()].flatMap(character => leagues.flatMap(item => controls.map(control => condition(character, item, control)))),
    ]
    const usedConditions = new Set(rows.map(conditionKey))
    const selected = candidates.find(candidate => !usedConditions.has(conditionKey(candidate)))
    if (!selected) { setError('追加できる条件がありません。'); return }
    const usedSlots = new Set(rows.map(row => row.colorSlot))
    const colorSlot = Array.from({ length: MAX_USAGE_RATE_COMPARISON_SERIES }, (_, index) => index)
      .find(slot => !usedSlots.has(slot))
    if (colorSlot === undefined) return
    let id: string
    do { id = `${idPrefix}-usage-series-${nextId.current++}` } while (rows.some(row => row.id === id))
    setError(null)
    pendingFocus.current = id
    onChange([...rows, { ...selected, id, colorSlot }])
  }

  function removeRow(rowId: string): void {
    if (rows.length <= 1) return
    const index = rows.findIndex(row => row.id === rowId)
    if (index < 0) return
    const remaining = rows.filter(row => row.id !== rowId)
    pendingFocus.current = remaining[Math.min(index, remaining.length - 1)].id
    setError(null)
    onChange(remaining)
  }

  return <StatisticsPanel title="表示する系列" headerContent={<span className="monthly-statistics-panel-summary">{rows.length} / {MAX_USAGE_RATE_COMPARISON_SERIES} 系列</span>}>
    <div className="usage-rate-series-editor">
      {rows.map((row, index) => {
        const number = `系列${index + 1}`
        return <div className="usage-rate-series-row" key={row.id} role="group" aria-label={number}>
          <span className="usage-rate-series-number"><UsageRateHistorySeriesKey colorSlot={row.colorSlot} />{number}</span>
          <label className="usage-rate-series-character"><span>キャラクター</span>
            <select aria-label={`${number}のキャラクター`} value={row.characterId}
              ref={element => { if (element) characterSelects.current.set(row.id, element); else characterSelects.current.delete(row.id) }}
              onChange={event => {
                const character = characters.find(item => item.characterId === event.target.value)
                if (character) updateRow(row.id, { characterId: character.characterId, characterName: character.name })
              }}>
              {!characters.some(character => character.characterId === row.characterId)
                && <option value={row.characterId}>{row.characterName}</option>}
              {characters.map(character => <option key={character.characterId} value={character.characterId}>{character.name}</option>)}
            </select>
          </label>
          <label><span>リーグ</span><select aria-label={`${number}のリーグ`} value={row.league}
            onChange={event => updateRow(row.id, { league: event.target.value })}>
            {leagues.map(league => <option key={league} value={league}>{usageRateLeagueLabel(league)}</option>)}
          </select></label>
          <label><span>操作タイプ</span><select aria-label={`${number}の操作タイプ`} value={row.controlType}
            disabled={controls.length === 1}
            onChange={event => updateRow(row.id, { controlType: event.target.value as Condition['controlType'] })}>
            {controls.map(control => <option key={control} value={control}>{CONTROL_LABELS[control]}</option>)}
          </select></label>
          <button type="button" className="win-rates-button usage-rate-series-remove" aria-label={`${number}を削除`}
            disabled={rows.length <= 1} onClick={() => removeRow(row.id)}>削除</button>
        </div>
      })}
      <div className="usage-rate-series-actions">
        <button ref={addButton} type="button" className="win-rates-button" disabled={rows.length >= MAX_USAGE_RATE_COMPARISON_SERIES}
          onClick={addRow}>系列を追加</button>
        {error && <span className="usage-rate-series-error" role="alert">{error}</span>}
      </div>
    </div>
  </StatisticsPanel>
}
