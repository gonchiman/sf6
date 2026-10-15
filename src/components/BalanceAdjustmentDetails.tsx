import type { BalanceAdjustment } from '../types/balanceAdjustments'
import type { BalanceAdjustmentDetailsLoadState, BalanceAdjustmentPatchDetails } from '../types/balanceAdjustmentDetails'
import { COMMON_ADJUSTMENT_SCOPE, balanceAdjustmentDateLabel } from './BalanceAdjustmentTable'
import { BalanceAdjustmentDetailContent } from './BalanceAdjustmentDetailContent'
import { StatisticsPanel } from './StatisticsPanel'

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
  return <StatisticsPanel id={id} title="バトル変更詳細" headerContent={<span className="monthly-statistics-panel-summary">
    {balanceAdjustmentDateLabel(event)}{subject ? ` · ${subject}` : ''}
  </span>}>
    <BalanceAdjustmentDetailContent event={event} patch={patch} status={detailsState.status} scope={scope} />
  </StatisticsPanel>
}
