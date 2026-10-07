import { useRef, useState, type KeyboardEvent } from 'react'
import type { WinRateDataset, WinRateFighter } from '../types/winRates'
import '../table.css'

type CellPosition = { row: number; column: number }

function fighterLabel(fighter: WinRateFighter): string {
  const control = fighter.controlType === 'classic' ? 'C' : fighter.controlType === 'modern' ? 'M' : null
  return control ? `${fighter.name} (${control})` : fighter.name
}

export function WinRateTable({ dataset }: { dataset: WinRateDataset }) {
  const [selection, setSelection] = useState<CellPosition | null>(null)
  const [focusPosition, setFocusPosition] = useState<CellPosition>({ row: 0, column: 0 })
  const tableRef = useRef<HTMLTableElement>(null)
  const rowsById = new Map(dataset.rows.map((row) => [row.fighterId, row]))
  const fighters = dataset.fighters
  const selectedRow = selection ? fighters[selection.row] : null
  const selectedOpponent = selection ? fighters[selection.column] : null
  const selectedCell = selection && selectedRow ? rowsById.get(selectedRow.id)?.cells[selection.column] : null

  const selectCell = (position: CellPosition) => {
    setSelection(position)
    setFocusPosition(position)
  }

  const navigateCells = (event: KeyboardEvent<HTMLButtonElement>, position: CellPosition) => {
    let { row, column } = position
    if (event.key === 'ArrowUp') row -= 1
    else if (event.key === 'ArrowDown') row += 1
    else if (event.key === 'ArrowLeft') column -= 1
    else if (event.key === 'ArrowRight') column += 1
    else if (event.key === 'Home') { column = 0; if (event.ctrlKey) row = 0 }
    else if (event.key === 'End') { column = fighters.length - 1; if (event.ctrlKey) row = fighters.length - 1 }
    else return
    event.preventDefault()
    row = Math.max(0, Math.min(fighters.length - 1, row))
    column = Math.max(0, Math.min(fighters.length - 1, column))
    selectCell({ row, column })
    const target = tableRef.current?.querySelector<HTMLButtonElement>(`[data-row="${row}"][data-column="${column}"]`)
    target?.focus({ preventScroll: true })
    target?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }

  return <div className="win-rate-table-section">
    <div className="win-rate-selection" role="status" aria-live="polite" aria-atomic="true">
      <div>
        <span className="win-rate-selection-label">組み合わせ</span>
        <strong>{selectedRow && selectedOpponent ? `${fighterLabel(selectedRow)} → ${fighterLabel(selectedOpponent)}` : '—'}</strong>
      </div>
      <div className="win-rate-selection-value">
        <span className="win-rate-selection-label">公式値</span>
        <strong>{selectedCell?.text ?? '—'}{selectedCell?.lowSample && <><span className="win-rate-sample-mark" aria-hidden="true">i</span><span className="win-rates-visually-hidden">（試合数が少ない）</span></>}</strong>
      </div>
    </div>
    <div className="data-table-scroll win-rate-table-scroll" role="region" tabIndex={0} aria-label="キャラクター別勝率表・縦横スクロール領域">
      <table ref={tableRef} className="data-table win-rate-table">
        <caption className="win-rates-visually-hidden">行のキャラクターから見た、列の対戦相手との公式の勝率表</caption>
        <thead>
          <tr>
            <th scope="col" className="win-rate-corner"><span>自分 ↓</span><span>対戦相手 →</span></th>
            {fighters.map((fighter, column) => <th
              scope="col"
              id={`win-rate-column-${column}`}
              key={fighter.id}
              className={selection?.column === column ? 'win-rate-heading-active' : undefined}
            >{fighterLabel(fighter)}</th>)}
          </tr>
        </thead>
        <tbody>
          {fighters.map((fighter, row) => <tr key={fighter.id}>
            <th scope="row" id={`win-rate-row-${row}`} className={`win-rate-row-heading${selection?.row === row ? ' win-rate-heading-active' : ''}`}>{fighterLabel(fighter)}</th>
            {rowsById.get(fighter.id)!.cells.map((cell, column) => <td key={fighters[column].id} headers={`win-rate-row-${row} win-rate-column-${column}`}>
              <button
                type="button"
                className="win-rate-cell"
                data-row={row}
                data-column={column}
                aria-label={`${fighterLabel(fighter)} 対 ${fighterLabel(fighters[column])}：${cell.text}${cell.lowSample ? '、試合数が少ない' : ''}`}
                aria-pressed={selection?.row === row && selection.column === column}
                tabIndex={focusPosition.row === row && focusPosition.column === column ? 0 : -1}
                onClick={() => selectCell({ row, column })}
                onKeyDown={(event) => navigateCells(event, { row, column })}
              >
                {cell.text}{cell.lowSample && <span className="win-rate-sample-mark" aria-hidden="true">i</span>}
              </button>
            </td>)}
          </tr>)}
        </tbody>
      </table>
    </div>
  </div>
}
