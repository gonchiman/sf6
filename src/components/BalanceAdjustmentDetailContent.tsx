import { timestampLabel } from '../lib/dateTime'
import type { BalanceAdjustment, BalanceAdjustmentSource } from '../types/balanceAdjustments'
import type { BalanceAdjustmentChange, BalanceAdjustmentDetailsLoadState, BalanceAdjustmentPatchDetails } from '../types/balanceAdjustmentDetails'
import { COMMON_ADJUSTMENT_SCOPE } from './BalanceAdjustmentTable'
import { BalanceAdjustmentSubjectSection } from './BalanceAdjustmentSubjectSection'
import '../table.css'
import '../win-rates.css'
import '../balance-adjustments.css'

type Subject = {
  id: string
  name: string
  changes: readonly BalanceAdjustmentChange[]
  source: BalanceAdjustmentSource
}

/** The detail body has no page, panel, disclosure, or data-fetching dependency. */
export function BalanceAdjustmentDetailContent({ event, patch, status, scope }: {
  event: BalanceAdjustment
  patch: BalanceAdjustmentPatchDetails | null
  status: BalanceAdjustmentDetailsLoadState['status']
  /** null displays the whole patch; common is a separate scope from characters. */
  scope: string | null
}) {
  const character = scope && scope !== COMMON_ADJUSTMENT_SCOPE ? patch?.characters.find(item => item.characterId === scope) : null
  const source = character?.source ?? patch?.source ?? event.source
  const subjects: Subject[] = []

  if (status === 'ready' && patch) {
    if ((scope === null || scope === COMMON_ADJUSTMENT_SCOPE) && patch.common.changes.length > 0) {
      subjects.push({ id: COMMON_ADJUSTMENT_SCOPE, name: '共通', changes: patch.common.changes, source: patch.source })
    }
    for (const item of patch.characters) {
      if ((scope === null || scope === item.characterId) && item.status === 'ready' && item.changes.length > 0) {
        subjects.push({ id: item.characterId, name: item.name, changes: item.changes, source: item.source ?? patch.source })
      }
    }
  }

  const message = status === 'loading' ? '技別内容を読み込み中…'
    : status === 'error' ? '技別内容を読み込めませんでした。'
      : !patch ? 'この調整の技別内容は未取込です。'
        : scope && scope !== COMMON_ADJUSTMENT_SCOPE && !character ? 'このキャラクターの技別内容は未取込です。'
          : character?.status === 'unlisted' ? 'このキャラクターは、この版の公式変更リストに掲載されていません。'
            : subjects.length === 0 ? '確認した変更箇所はありません。' : null

  return <div className="balance-adjustment-detail-content">
    {message && <p role="status">{message}</p>}
    {subjects.length > 0 && <div className="balance-adjustment-subjects">
      {subjects.map(subject => <BalanceAdjustmentSubjectSection key={subject.id} name={subject.name} changes={subject.changes} source={subject.source} />)}
    </div>}
    <dl className="win-rates-source">
      <div><dt>日付</dt><dd><time dateTime={event.date}>{event.date}</time>（{event.dateBasis === 'effective' ? '実施日' : 'リスト日'}）</dd></div>
      <div><dt>出典</dt><dd><a href={source.url} target="_blank" rel="noreferrer">{source.title}<span className="win-rates-visually-hidden">（新しいタブ）</span></a></dd></div>
      {event.announcement && <div><dt>実施告知</dt><dd><a href={event.announcement.url} target="_blank" rel="noreferrer">{event.announcement.title}<span className="win-rates-visually-hidden">（新しいタブ）</span></a></dd></div>}
      {patch && <div><dt>技別内容の取得日時</dt><dd><time dateTime={patch.capturedAt}>{timestampLabel(patch.capturedAt)}</time></dd></div>}
    </dl>
  </div>
}
