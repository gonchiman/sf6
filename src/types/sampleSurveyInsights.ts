import type { SampleSurveyTarget } from './sampleSurvey.ts'

export type SampleSurveyInsightTheme = 'activity' | 'character' | 'matchup' | 'battle' | 'recent' | 'attributes'
export type SampleSurveyInsightPeriod = { kind: 'act'; act: number }
  | { kind: 'lifetime' | 'capture' | 'last-100' | 'recent-10' }
export type SampleSurveyInsightMode = 'all' | 'rank' | 'casual' | 'custom' | 'hub'
export type SampleSurveyInsightCategory = 'region-jp' | 'region-us' | 'region-other' | 'region-unset'
  | 'platform-steam' | 'platform-cross' | 'platform-unknown'

/** Aggregate cells only. n always counts contributing sampled accounts, not matches. */
export type SampleSurveyMetricValue =
  | { kind: 'count'; n: number; count: number }
  | { kind: 'ratio'; n: number; numerator: number; denominator: number }
  | { kind: 'mean'; n: number; total: number }
  | { kind: 'median'; n: number; value: number | null }

/** IDs and aggregation kinds are fixed; published payloads cannot introduce arbitrary fields. */
export const SAMPLE_SURVEY_INSIGHT_METRICS = {
  activeShare: 'ratio', meanBattles: 'mean', meanCharacters: 'mean',
  userShare: 'ratio', wins: 'count', battles: 'count', winRate: 'ratio', medianLp: 'median', medianMr: 'median',
  medianWinRate: 'median',
  driveParryShare: 'mean', driveImpactShare: 'mean', overdriveShare: 'mean', parryRushShare: 'mean',
  cancelRushShare: 'mean', driveReversalShare: 'mean', driveDamageShare: 'mean',
  reversalMean: 'mean', parryMean: 'mean', perfectParryMean: 'mean', parryThrowMean: 'mean', parryThrownMean: 'mean',
  impactHitMean: 'mean', impactPunishMean: 'mean', impactCounterMean: 'mean', impactTakenMean: 'mean',
  impactPunishTakenMean: 'mean', impactCounteredMean: 'mean',
  sa1Share: 'mean', sa2Share: 'mean', sa3Share: 'mean', caShare: 'mean',
  stunMean: 'mean', stunnedMean: 'mean', throwMean: 'mean', thrownMean: 'mean', throwTechMean: 'mean',
  cornerAttackMean: 'mean', cornerDefenseMean: 'mean',
  records: 'count', recentActiveShare: 'ratio', classicRecords: 'count', modernRecords: 'count',
  unknownRecords: 'count', modernShare: 'ratio', losses: 'count',
  categoryShare: 'ratio', meanPlayPoints: 'mean', meanEnjoy: 'mean', clubShare: 'ratio',
  medianFavoriteRankHours: 'median', vMasterShare: 'ratio', meanChallengeClears: 'mean',
} as const
export type SampleSurveyInsightMetric = keyof typeof SAMPLE_SURVEY_INSIGHT_METRICS
export type SampleSurveyInsightMetrics = Partial<Record<SampleSurveyInsightMetric, SampleSurveyMetricValue>>

export interface SampleSurveyInsightRow {
  stratumId: string
  validAccounts: number
  characterId?: string
  opponentCharacterId?: string
  category?: SampleSurveyInsightCategory
  metrics: SampleSurveyInsightMetrics
}
export interface SampleSurveyInsightCoverage {
  stratumId: string
  attemptedAccounts: number
  validAccounts: number
  failedAccounts: number
}
export interface SampleSurveyInsightDataset {
  theme: SampleSurveyInsightTheme
  target: SampleSurveyTarget
  period: SampleSurveyInsightPeriod
  mode: SampleSurveyInsightMode | null
  capturedAt: { start: string; end: string }
  coverage: SampleSurveyInsightCoverage[]
  rows: SampleSurveyInsightRow[]
}
export interface SampleSurveyInsights {
  schemaVersion: 1
  datasets: SampleSurveyInsightDataset[]
}
