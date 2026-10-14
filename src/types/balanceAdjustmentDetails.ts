import type { BalanceAdjustmentSource } from './balanceAdjustments.ts'

/** Official wording is retained; category labels are not strength judgments. */
export interface BalanceAdjustmentChange {
  id: string
  /** Official cells may be blank; a blank is not a confirmed absence of changes. */
  target: string
  categoryLabel: string
  description: string
}

export interface BalanceAdjustmentCharacterDetails {
  characterId: string
  name: string
  /** Unlisted is confirmed absence in the official patch's character list. */
  status: 'ready' | 'unlisted'
  source: BalanceAdjustmentSource | null
  /** Empty only when the inspected official page has no policy paragraph. */
  policy: string
  /** With ready status, an empty array means an inspected page listed no changes. */
  changes: BalanceAdjustmentChange[]
}

export interface BalanceAdjustmentPatchDetails {
  adjustmentId: string
  /** Same Japan calendar date and date basis as the matching history event. */
  date: string
  capturedAt: string
  source: BalanceAdjustmentSource
  common: { policy: string; changes: BalanceAdjustmentChange[] }
  characters: BalanceAdjustmentCharacterDetails[]
}

export interface BalanceAdjustmentDetailsCatalog {
  schemaVersion: 1
  generatedAt: string
  patches: BalanceAdjustmentPatchDetails[]
}

export type BalanceAdjustmentDetailsLoadState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; catalog: BalanceAdjustmentDetailsCatalog }

export interface BalanceAdjustmentListFilters {
  /** The reserved value all disables character filtering. */
  characterId: string
  fromMonth: string
  toMonth: string
}
