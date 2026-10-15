import { useMemo, type MouseEvent } from 'react'
import { useSelectedRowScroll } from '../hooks/useSelectedRowScroll'
import { balanceAdjustmentPatchDetails } from '../lib/balanceAdjustmentDetails'
import { buildBalanceAdjustmentCountRows } from '../lib/balanceAdjustmentCountChart'
import { balanceAdjustmentDetailHash } from '../lib/routes'
import type { BalanceAdjustment } from '../types/balanceAdjustments'
import type { BalanceAdjustmentChange, BalanceAdjustmentCharacterDetails, BalanceAdjustmentDetailsLoadState, BalanceAdjustmentPatchDetails } from '../types/balanceAdjustmentDetails'
import '../table.css'
import '../win-rate-history-chart.css'

export const COMMON_ADJUSTMENT_SCOPE = '__common__'

export function balanceAdjustmentDateLabel(event: BalanceAdjustment): string {
  return `${event.date.replaceAll('-', '/')}${event.dateBasis === 'list' ? '（リスト日）' : ''}`
}

export function BalanceAdjustmentOverviewTable({ events, details, selectedId, detailScope, characterId = 'all', onOpen }: {
  events: readonly BalanceAdjustment[]
  details: BalanceAdjustmentDetailsLoadState
  selectedId: string | null
  detailScope: string | null
  characterId?: string
  onOpen: (event: MouseEvent<HTMLAnchorElement>, id: string, scope: string | null) => void
}) {
  const { scrollRef, selectedRowRef } = useSelectedRowScroll(events, selectedId, true)
  const counts = useMemo(() => new Map(buildBalanceAdjustmentCountRows(events,
    details.status === 'ready' ? details.catalog : null, characterId).map(row => [row.event.id, row])), [events, details, characterId])
  return <div ref={scrollRef} className="data-table-scroll balance-adjustment-scroll" role="region" tabIndex={0}
    aria-label="変更日別の履歴・スクロール領域">
    <table className="data-table balance-adjustment-overview-table">
      <caption className="win-rates-visually-hidden">公式の変更日別履歴と技別内容の収録状況</caption>
      <colgroup><col className="balance-adjustment-date-column" /><col /><col /><col /><col className="balance-adjustment-source-column" /></colgroup>
      <thead><tr><th scope="col">日付</th><th scope="col">種別</th><th scope="col">対象</th><th scope="col">技別内容</th><th scope="col">公式</th></tr></thead>
      <tbody>{events.map(event => {
        const patch = details.status === 'ready' ? balanceAdjustmentPatchDetails(details.catalog, event) : null
        const changed = patch?.characters.filter(character => character.status === 'ready' && character.changes.length > 0) ?? []
        const hasCommon = !!patch?.common.changes.length
        const character = characterId === 'all' ? null : patch?.characters.find(item => item.characterId === characterId)
        const target = characterId === 'all'
          ? patch ? [hasCommon ? '共通' : '', changed.length ? `${changed.length}キャラ` : ''].filter(Boolean).join('・') || '変更なし' : '未確認'
          : character?.name ?? '未確認'
        const row = counts.get(event.id)
        const state = details.status === 'loading' ? '読込中…' : details.status === 'error' ? '読込失敗'
          : row?.status === 'unlisted' ? '未掲載' : row?.itemCount == null ? '未取込' : `${row.itemCount}項目`
        return <tr key={event.id} ref={event.id === selectedId ? selectedRowRef : undefined} className={event.id === selectedId ? 'is-selected' : undefined}>
          <th scope="row" className="monthly-win-rate-month"><a className="monthly-win-rate-month-button balance-adjustment-detail-link"
            href={balanceAdjustmentDetailHash(event.id, detailScope)} aria-label={`${balanceAdjustmentDateLabel(event)}のバトル変更詳細を開く`}
            onClick={click => onOpen(click, event.id, detailScope)}>{balanceAdjustmentDateLabel(event)}</a></th>
          <td>{event.kindLabel}</td><td>{target}</td><td>{state}</td>
          <td><a href={event.source.url} target="_blank" rel="noreferrer">変更リスト<span className="win-rates-visually-hidden">（新しいタブ）</span></a></td>
        </tr>
      })}</tbody>
    </table>
  </div>
}

function changeTargets(character: BalanceAdjustmentCharacterDetails): string {
  if (character.status === 'unlisted') return '未掲載'
  if (character.changes.length === 0) return '変更なし'
  const targets = [...new Set(character.changes.map(change => change.target || '—'))]
  return `${targets.slice(0, 2).join('、')}${targets.length > 2 ? ` ほか${targets.length - 2}項目` : ''}`
}

function changeCategories(changes: readonly BalanceAdjustmentChange[]): string {
  return [...new Set(changes.flatMap(change => change.categoryLabel.split('・').map(label => label.trim()).filter(Boolean)))].join('・') || '—'
}

export function BalanceAdjustmentCharactersTable({ patch, characters, includeCommon, selectedScope, onOpen }: {
  patch: BalanceAdjustmentPatchDetails
  characters: readonly BalanceAdjustmentCharacterDetails[]
  includeCommon: boolean
  selectedScope: string | null
  onOpen: (event: MouseEvent<HTMLAnchorElement>, scope: string) => void
}) {
  const commonVisible = includeCommon && (patch.common.changes.length > 0 || patch.common.policy.length > 0)
  const rows = useMemo(() => [...(commonVisible ? [{ id: COMMON_ADJUSTMENT_SCOPE }] : []), ...characters.map(character => ({ id: character.characterId }))], [commonVisible, characters])
  const { scrollRef, selectedRowRef } = useSelectedRowScroll(rows, selectedScope, true)
  const detailLink = (scope: string, label: string) => <a className="monthly-win-rate-month-button balance-adjustment-detail-link"
    href={balanceAdjustmentDetailHash(patch.adjustmentId, scope)} aria-label={`${label}のバトル変更詳細を開く`} onClick={click => onOpen(click, scope)}>{label}</a>
  return <div ref={scrollRef} className="data-table-scroll balance-adjustment-scroll" role="region" tabIndex={0}
    aria-label="共通・キャラ別の変更内容・スクロール領域">
    <table className="data-table balance-adjustment-character-table">
      <caption className="win-rates-visually-hidden">共通と各キャラの変更箇所・分類・項目数</caption>
      <colgroup><col className="balance-adjustment-character-column" /><col /><col className="balance-adjustment-category-column" /><col className="balance-adjustment-count-column" /><col className="balance-adjustment-source-column" /></colgroup>
      <thead><tr><th scope="col">キャラクター</th><th scope="col">変更箇所</th><th scope="col">分類</th><th scope="col">項目数</th><th scope="col">公式</th></tr></thead>
      <tbody>
        {commonVisible && <tr ref={selectedScope === COMMON_ADJUSTMENT_SCOPE ? selectedRowRef : undefined} className={selectedScope === COMMON_ADJUSTMENT_SCOPE ? 'is-selected' : undefined}>
          <th scope="row" className="monthly-win-rate-month">{detailLink(COMMON_ADJUSTMENT_SCOPE, '共通')}</th>
          <td>{patch.common.changes.map(change => change.target || '—').join('、') || '調整方針'}</td>
          <td>{changeCategories(patch.common.changes)}</td>
          <td className="balance-adjustment-count">{patch.common.changes.length}</td><td><a href={patch.source.url} target="_blank" rel="noreferrer">変更リスト<span className="win-rates-visually-hidden">（新しいタブ）</span></a></td>
        </tr>}
        {characters.map(character => <tr key={character.characterId} ref={selectedScope === character.characterId ? selectedRowRef : undefined}
          className={selectedScope === character.characterId ? 'is-selected' : undefined}>
          <th scope="row" className="monthly-win-rate-month">{detailLink(character.characterId, character.name)}</th>
          <td>{changeTargets(character)}</td><td>{character.status === 'unlisted' ? '—' : changeCategories(character.changes)}</td>
          <td className="balance-adjustment-count">{character.status === 'unlisted' ? '—' : character.changes.length}</td>
          <td>{character.source ? <a href={character.source.url} target="_blank" rel="noreferrer">変更リスト<span className="win-rates-visually-hidden">（新しいタブ）</span></a> : '—'}</td>
        </tr>)}
      </tbody>
    </table>
  </div>
}
