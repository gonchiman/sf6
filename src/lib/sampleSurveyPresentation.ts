import type { SampleSurveyInsightDataset, SampleSurveyInsightMetric as Metric, SampleSurveyInsightMode, SampleSurveyInsightPeriod, SampleSurveyMetricValue } from '../types/sampleSurveyInsights.ts'
import { SAMPLE_SURVEY_INSIGHT_THEME_METRICS, sampleSurveyMetricValue } from './sampleSurveyInsights.ts'

type MetricDefinition = { label: string; unit: string }
const definition = (label: string, unit: string): MetricDefinition => ({ label, unit })
export const SAMPLE_SURVEY_METRIC_LABELS: Record<Metric, MetricDefinition> = {
  activeShare: definition('期間内の対戦あり', '%'), meanBattles: definition('平均対戦数', '戦'), meanCharacters: definition('平均使用キャラ数', 'キャラ'),
  userShare: definition('使用者割合', '%'), wins: definition('勝数合計', '勝'), battles: definition('対戦数合計', '戦'), winRate: definition('勝数合計 ÷ 対戦数合計', '%'), medianLp: definition('キャラ別LP中央値', 'LP'), medianMr: definition('キャラ別MR中央値', 'MR'), medianWinRate: definition('アカウント別勝率の中央値', '%'),
  driveParryShare: definition('ドライブパリィのゲージ割合', '%'), driveImpactShare: definition('ドライブインパクトのゲージ割合', '%'), overdriveShare: definition('ODアーツのゲージ割合', '%'), parryRushShare: definition('パリィラッシュのゲージ割合', '%'), cancelRushShare: definition('キャンセルラッシュのゲージ割合', '%'), driveReversalShare: definition('ドライブリバーサルのゲージ割合', '%'), driveDamageShare: definition('ダメージによるゲージ割合', '%'),
  reversalMean: definition('リバーサル使用回数', '回'), parryMean: definition('パリィ成功回数', '回'), perfectParryMean: definition('ジャストパリィ回数', '回'), parryThrowMean: definition('相手のパリィを投げた回数', '回'), parryThrownMean: definition('自分のパリィを投げられた回数', '回'),
  impactHitMean: definition('インパクトを決めた回数', '回'), impactPunishMean: definition('インパクトのパニッシュカウンター回数', '回'), impactCounterMean: definition('相手のインパクトに決めた回数', '回'), impactTakenMean: definition('インパクトを受けた回数', '回'), impactPunishTakenMean: definition('インパクトのパニッシュカウンターを受けた回数', '回'), impactCounteredMean: definition('インパクトで返された回数', '回'),
  sa1Share: definition('Lv1 SA使用割合', '%'), sa2Share: definition('Lv2 SA使用割合', '%'), sa3Share: definition('Lv3 SA使用割合', '%'), caShare: definition('CA使用割合', '%'),
  stunMean: definition('スタンさせた回数', '回'), stunnedMean: definition('スタンさせられた回数', '回'), throwMean: definition('投げを決めた回数', '回'), thrownMean: definition('投げを受けた回数', '回'), throwTechMean: definition('投げ抜け回数', '回'), cornerAttackMean: definition('壁際に追い詰めた時間', '秒'), cornerDefenseMean: definition('壁際に追い詰められた時間', '秒'),
  records: definition('取得記録数', '件'), recentActiveShare: definition('7日以内の対戦記録あり', '%'), classicRecords: definition('C記録数', '件'), modernRecords: definition('M記録数', '件'), unknownRecords: definition('操作不明の記録数', '件'), modernShare: definition('取得戦歴内のモダン使用割合', '%'), losses: definition('敗数合計', '敗'),
  categoryShare: definition('設定値の割合', '%'), meanPlayPoints: definition('平均プレイポイント', 'PT'), meanEnjoy: definition('平均エンジョイ数', '件'), clubShare: definition('メインクラブ設定あり', '%'), medianFavoriteRankHours: definition('ランクマッチ掲載時間の中央値', '時間'), vMasterShare: definition('Vライバル最高到達Master', '%'), meanChallengeClears: definition('平均チャレンジクリア回数', '回'),
}
export const SAMPLE_SURVEY_MODE_LABELS: Record<SampleSurveyInsightMode, string> = { all: 'すべて', rank: 'ランクマッチ', casual: 'カジュアルマッチ', custom: 'ルームマッチ', hub: 'バトルハブマッチ' }
export const SAMPLE_SURVEY_CATEGORY_LABELS = { 'region-jp': '日本', 'region-us': '米国', 'region-other': 'その他の設定地域', 'region-unset': '未設定', 'platform-steam': 'Steam', 'platform-cross': 'CrossPlatform表示', 'platform-unknown': '判別不可' } as const
export function surveyPeriodLabel(period: SampleSurveyInsightPeriod): string {
  return period.kind === 'act' ? `Act ${period.act}` : ({ lifetime: '累計', capture: '取得時点', 'last-100': '各アカウントの過去100戦', 'recent-10': '直近最大10件 / アカウント' })[period.kind]
}
export const surveyConditionKey = (dataset: SampleSurveyInsightDataset) => JSON.stringify([dataset.period, dataset.mode])
export const surveyConditionLabel = (dataset: SampleSurveyInsightDataset) => [surveyPeriodLabel(dataset.period), dataset.mode === null ? null : SAMPLE_SURVEY_MODE_LABELS[dataset.mode]].filter(Boolean).join(' · ')
export const surveyMetricKeys = (dataset: SampleSurveyInsightDataset): Metric[] => SAMPLE_SURVEY_INSIGHT_THEME_METRICS[dataset.theme].filter(key => dataset.rows.some(row => row.metrics[key] !== undefined))
export function surveyCellState(cell: SampleSurveyMetricValue | undefined): string {
  return cell === undefined ? '未取得' : sampleSurveyMetricValue(cell) === null ? '算出不可' : '取得済み'
}
export function surveyCellDetail(cell: SampleSurveyMetricValue | undefined): string | null {
  if (!cell) return null
  const nf = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 0 })
  return cell.kind === 'ratio' ? `${nf.format(cell.numerator)} / ${nf.format(cell.denominator)} · n=${nf.format(cell.n)}` : `n=${nf.format(cell.n)}`
}
export function surveyCoverageState(attempted: number, valid: number, failed: number): string {
  return attempted === 0 ? '未取得' : valid === 0 && failed > 0 ? '取得失敗' : failed > 0 ? '一部欠測' : '取得済み'
}
