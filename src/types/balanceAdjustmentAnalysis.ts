import type { BalanceAdjustmentSource } from './balanceAdjustments.ts'

export type AdjustmentAnalysisCategoryId =
  | 'damage' | 'startup' | 'active' | 'recovery' | 'frame-advantage'
  | 'hitbox' | 'hurtbox' | 'invincibility' | 'gauge' | 'movement'
  | 'pushback' | 'cancel' | 'input' | 'hit-effect' | 'unclassified'

export type AdjustmentAnalysisDirection = '増加' | '減少' | '拡大' | '縮小' | '追加' | '削除' | '変更' | '不明'
export type AdjustmentAnalysisVerdict = 'buff' | 'nerf' | 'unjudged'

/** A local, rule-based evaluation of the extracted change; not overall character strength. */
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
  evaluation: { verdict: AdjustmentAnalysisVerdict; reason: string; ruleId: string | null }
}

export interface AdjustmentAnalysisResult {
  rows: AdjustmentAnalysisRow[]
  sourceRowCount: number
}

export interface AdjustmentAnalysisFilters {
  subjectId: string
  categoryId: 'all' | AdjustmentAnalysisCategoryId
  status: 'all' | 'candidate' | 'unclassified'
  verdict?: 'all' | AdjustmentAnalysisVerdict
}
