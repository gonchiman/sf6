import { timestampLabel } from '../lib/dateTime'
import type { BalanceAdjustment } from '../types/balanceAdjustments'
import type { BalanceAdjustmentChange, BalanceAdjustmentDetailsLoadState, BalanceAdjustmentPatchDetails } from '../types/balanceAdjustmentDetails'
import { COMMON_ADJUSTMENT_SCOPE, balanceAdjustmentDateLabel } from './BalanceAdjustmentTable'

export function BalanceAdjustmentDetails({ event, patch, detailsState, scope, id }: {
  event: BalanceAdjustment
  patch: BalanceAdjustmentPatchDetails | null
  detailsState: BalanceAdjustmentDetailsLoadState
  /** null means the complete patch; the common scope is separate from character identities. */
  scope: string | null
  id: string
}) {
  const character = scope && scope !== COMMON_ADJUSTMENT_SCOPE ? patch?.characters.find(item => item.characterId === scope) : null
  const subject = scope === COMMON_ADJUSTMENT_SCOPE ? '共通' : character?.name
  const policy = scope === null || scope === COMMON_ADJUSTMENT_SCOPE ? patch?.common.policy : character?.policy
  const rows: { name: string; change: BalanceAdjustmentChange }[] = patch ? scope === null
    ? [...patch.common.changes.map(change => ({ name: '共通', change })), ...patch.characters.flatMap(item => item.changes.map(change => ({ name: item.name, change })))]
    : scope === COMMON_ADJUSTMENT_SCOPE ? patch.common.changes.map(change => ({ name: '共通', change }))
      : character?.changes.map(change => ({ name: character.name, change })) ?? [] : []
  const source = character?.source ?? patch?.source ?? event.source
  const message = detailsState.status === 'loading' ? '技別内容を読み込み中…'
    : detailsState.status === 'error' ? '技別内容を読み込めませんでした。'
      : !patch ? 'この調整の技別内容は未取込です。'
        : character?.status === 'unlisted' ? 'このキャラクターは、この版の公式変更リストに掲載されていません。'
          : rows.length === 0 ? '確認した変更箇所はありません。' : null

  return <details className="win-rates-details" id={id}>
    <summary>選択した調整の詳細 · {balanceAdjustmentDateLabel(event)}{subject ? ` · ${subject}` : ''}</summary>
    <div className="win-rates-details-content balance-adjustment-detail-content">
      {message && <p role="status">{message}</p>}
      {policy && <details className="win-rates-details"><summary>調整方針</summary><div className="win-rates-details-content"><p className="balance-adjustment-description">{policy}</p></div></details>}
      {rows.length > 0 && <div className="data-table-scroll balance-adjustment-detail-scroll" role="region" tabIndex={0} aria-label="選択した調整の技別詳細・スクロール領域">
        <table className="data-table balance-adjustment-detail-table">
          <caption className="win-rates-visually-hidden">公式の変更箇所、分類、調整・修正内容</caption>
          <colgroup><col className="balance-adjustment-detail-character-column" /><col className="balance-adjustment-target-column" /><col className="balance-adjustment-category-column" /><col /></colgroup>
          <thead><tr><th scope="col">キャラ・共通</th><th scope="col">変更箇所</th><th scope="col">分類</th><th scope="col">変更内容</th></tr></thead>
          <tbody>{rows.map(({ name, change }) => <tr key={`${name}-${change.id}`}><td>{name}</td><th scope="row" className="balance-adjustment-description">{change.target || '—'}</th>
            <td>{change.categoryLabel || '—'}</td><td className="balance-adjustment-description">{change.description}</td></tr>)}</tbody>
        </table>
      </div>}
      <dl className="win-rates-source">
        <div><dt>日付</dt><dd><time dateTime={event.date}>{event.date}</time>（{event.dateBasis === 'effective' ? '実施日' : 'リスト日'}）</dd></div>
        <div><dt>出典</dt><dd><a href={source.url} target="_blank" rel="noreferrer">{source.title}<span className="win-rates-visually-hidden">（新しいタブ）</span></a></dd></div>
        {event.announcement && <div><dt>実施告知</dt><dd><a href={event.announcement.url} target="_blank" rel="noreferrer">{event.announcement.title}<span className="win-rates-visually-hidden">（新しいタブ）</span></a></dd></div>}
        {patch && <div><dt>技別内容の取得日時</dt><dd><time dateTime={patch.capturedAt}>{timestampLabel(patch.capturedAt)}</time></dd></div>}
      </dl>
    </div>
  </details>
}
