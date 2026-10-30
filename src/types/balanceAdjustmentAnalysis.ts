import type { BalanceAdjustmentSource } from './balanceAdjustments.ts'

export type AdjustmentAnalysisCategoryId =
  | 'damage' | 'startup' | 'active' | 'recovery' | 'frame-advantage'
  | 'hitbox' | 'hurtbox' | 'invincibility' | 'gauge' | 'movement'
  | 'pushback' | 'cancel' | 'input' | 'hit-effect' | 'unclassified'

export type AdjustmentAnalysisDirection = '増加' | '減少' | '拡大' | '縮小' | '追加' | '削除' | '変更' | '不明'

/** Rule candidates describe the wording, not a buff/nerf judgment. */
export interface AdjustmentAnalysisRow {
  id: string
  sourceChangeId: string
  subjectId: string
  subjectName: string
  target: string
  officialCategoryLabel: string
  description: string
  source: BalanceAdjustmentSource
  categoryId: AdjustmentAnalysisCategoryId
  elementLabel: string
  direction: AdjustmentAnalysisDirection
  beforeValue: string | null
  afterValue: string | null
  deltaValue: string | null
  /** Null means that a condition was not extracted, not that the change is unconditional. */
  condition: string | null
  evidence: { start: number; end: number }
  status: 'candidate' | 'unclassified'
}

export interface AdjustmentAnalysisResult {
  rows: AdjustmentAnalysisRow[]
  sourceRowCount: number
}

export interface AdjustmentAnalysisFilters {
  subjectId: string
  categoryId: 'all' | AdjustmentAnalysisCategoryId
  status: 'all' | 'candidate' | 'unclassified'
}
