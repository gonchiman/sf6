import { useEffect, useMemo, useRef, useState } from 'react'
import { createTotalWinRateRows, formatTotalPercent, type TotalWinRateSort } from '../lib/totalWinRates'
import type { WinRateDataset } from '../types/winRates'
import '../table.css'
import '../total-win-rates.css'

export function TotalWinRateTable({ dataset }: { dataset: WinRateDataset }) {
  const [sort, setSort] = useState<TotalWinRateSort>('descending')
  const scrollRef = useRef<HTMLDivElement>(null)
  const rows = useMemo(() => createTotalWinRateRows(dataset, sort), [dataset, sort])
  const separateControls = dataset.operationMode === 'separate'
  const nextTotalSort = sort === 'descending' ? 'ascending' : 'descending'

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0
  }, [dataset.id, sort])

  return <div
    ref={scrollRef}
    className="data-table-scroll total-win-rate-scroll"
    role="region"
    tabIndex={0}
    aria-label="キャラクター別Total一覧・スクロール領域"
  >
    <table className="data-table total-win-rate-table">
      <caption className="win-rates-visually-hidden">キャラクター別の公式Totalを百分率に換算した一覧</caption>
      <colgroup>
        <col />
        {separateControls && <col className="total-win-rate-control-column" />}
        <col className="total-win-rate-value-column" />
      </colgroup>
      <thead>
        <tr>
          <th scope="col" className="total-win-rate-sort-heading" aria-sort={sort === 'official' ? 'other' : 'none'}>
            <button
              type="button"
              className="total-win-rate-sort-button"
              aria-label="キャラクターを公式順に並べる"
              onClick={() => setSort('official')}
            >
              <span>キャラクター</span>
              <span className="total-win-rate-sort-indicator" aria-hidden="true">{sort === 'official' ? '公式順' : '↕'}</span>
            </button>
          </th>
          {separateControls && <th scope="col">操作タイプ</th>}
          <th scope="col" className="total-win-rate-sort-heading" aria-sort={sort === 'official' ? 'none' : sort}>
            <button
              type="button"
              className="total-win-rate-sort-button"
              aria-label={`Totalを${nextTotalSort === 'ascending' ? '昇順' : '降順'}に並べる`}
              onClick={() => setSort(nextTotalSort)}
            >
              <span>Total（%換算）</span>
              <span className="total-win-rate-sort-indicator" aria-hidden="true">{sort === 'official' ? '↕' : sort === 'ascending' ? '▲' : '▼'}</span>
            </button>
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map(({ fighter, total }) => <tr key={fighter.id}>
          <th scope="row" className="total-win-rate-name">{fighter.name}</th>
          {separateControls && <td className="total-win-rate-control">{fighter.controlType === 'classic' ? 'クラシック' : fighter.controlType === 'modern' ? 'モダン' : '—'}</td>}
          <td className="total-win-rate-value">{formatTotalPercent(total.text)}</td>
        </tr>)}
      </tbody>
    </table>
  </div>
}
