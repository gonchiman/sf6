import { timestampLabel } from '../lib/dateTime'
import { monthLabel } from '../lib/winRateHistory'
import type { BalanceAdjustment, BalanceAdjustmentCatalog } from '../types/balanceAdjustments'

type Props = {
  selected: BalanceAdjustment | null
  catalog: BalanceAdjustmentCatalog | null
  detailsId: string
  measureLabel: '勝率' | '使用率'
  onClose: () => void
}

/** Shared patch evidence and date interpretation for monthly distribution statistics. */
export function MonthlyStatisticsAdjustments({ selected, catalog, detailsId, measureLabel, onClose }: Props) {
  const dateLabel = selected ? `${Number(selected.date.slice(0, 4))}年${Number(selected.date.slice(5, 7))}月${Number(selected.date.slice(8))}日` : ''
  return <>
    <div id={detailsId} hidden={!selected} aria-live="polite" aria-atomic="true">
      {selected && <section className="monthly-adjustment-details" aria-labelledby={`${detailsId}-title`}>
        <div className="monthly-adjustment-details-heading">
          <h3 id={`${detailsId}-title`}><time dateTime={selected.date}>{dateLabel}</time><span>{selected.kindLabel}</span></h3>
          <button type="button" className="win-rates-button" onClick={onClose}>閉じる</button>
        </div>
        <dl className="win-rates-source">
          <div><dt>日付</dt><dd>{selected.dateBasis === 'effective' ? '実施日（日本時間）' : 'リスト日（実施日は未確認）'}</dd></div>
          <div><dt>変更内容</dt><dd><a href={selected.source.url} target="_blank" rel="noreferrer">{selected.source.title}<span className="win-rates-visually-hidden">（新しいタブ）</span></a></dd></div>
          {selected.announcement && <div><dt>実施告知</dt><dd><a href={selected.announcement.url} target="_blank" rel="noreferrer">{selected.announcement.title}<span className="win-rates-visually-hidden">（新しいタブ）</span></a></dd></div>}
        </dl>
      </section>}
    </div>
    <details className="win-rates-details"><summary>調整日の見方・出典</summary><div className="win-rates-details-content monthly-statistics-data-details">
      <p>調整日とその種類を表示しています。公式のバトル変更履歴に含まれる不具合修正も表示します。同じ月に複数の変更がある場合は、すべて表示します。</p>
      <p>月の途中に変更がある場合、その月の{measureLabel}には変更前後のデータが含まれます。統計値は月単位のままで、調整前後には分割していません。</p>
      <p>「—」は確認した範囲内に変更履歴がない月、「履歴未確認」は確認範囲外の月です。「リスト日」は公式の変更リストの日付で、実施日を確認できていません。</p>
      {catalog && <dl className="win-rates-source">
        <div><dt>確認範囲</dt><dd>{monthLabel(catalog.coverage.fromMonth)}〜{monthLabel(catalog.coverage.toMonth)}</dd></div>
        <div><dt>出典</dt><dd><a href={catalog.source.url} target="_blank" rel="noreferrer">{catalog.source.title}<span className="win-rates-visually-hidden">（新しいタブ）</span></a></dd></div>
        <div><dt>確認日時</dt><dd><time dateTime={catalog.checkedAt}>{timestampLabel(catalog.checkedAt)}</time></dd></div>
        <div><dt>一覧生成日時</dt><dd><time dateTime={catalog.generatedAt}>{timestampLabel(catalog.generatedAt)}</time></dd></div>
        <div><dt>データ形式</dt><dd>Version {catalog.schemaVersion}</dd></div>
      </dl>}
    </div></details>
  </>
}
