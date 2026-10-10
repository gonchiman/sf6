export interface BalanceAdjustmentSource {
  url: string
  title: string
}

export interface BalanceAdjustment {
  id: string
  /** Japan calendar date; list dates are not treated as confirmed effective dates. */
  date: string
  dateBasis: 'effective' | 'list'
  kindLabel: string
  title: string
  source: BalanceAdjustmentSource
  announcement: BalanceAdjustmentSource | null
}

export interface BalanceAdjustmentCatalog {
  schemaVersion: 1
  generatedAt: string
  checkedAt: string
  source: BalanceAdjustmentSource
  /** An examined history range, including months with no listed changes. */
  coverage: {
    fromMonth: string
    toMonth: string
  }
  events: BalanceAdjustment[]
}

export interface BalanceAdjustmentMonth {
  month: string
  status: 'ready' | 'unverified'
  events: readonly BalanceAdjustment[]
}

export type BalanceAdjustmentLoadState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; catalog: BalanceAdjustmentCatalog }
