import { useEffect, useState, type ReactNode } from 'react'
import { loadCharacterManifest } from '../lib/characters'
import { japaneseCharacterNames } from '../lib/characterNames'
import { sampleSurveyMetricValue } from '../lib/sampleSurveyInsights'
import { sampleSurveyBarNumber } from '../lib/sampleSurveyBarChart'
import { SAMPLE_SURVEY_CATEGORY_LABELS, SAMPLE_SURVEY_METRIC_LABELS, surveyCellDetail, surveyCellState, surveyConditionKey, surveyConditionLabel, surveyCoverageState, surveyMetricKeys } from '../lib/sampleSurveyPresentation'
import type { SampleSurveyRun, SampleSurveyTarget } from '../types/sampleSurvey'
import type { SampleSurveyInsightDataset, SampleSurveyInsightMetric, SampleSurveyInsightRow, SampleSurveyInsightTheme } from '../types/sampleSurveyInsights'
import { StatisticsPanel } from './StatisticsPanel'
import { DistributionCapturePeriod } from './DistributionCapturePeriod'
import { SampleSurveyBarChart } from './SampleSurveyBarChart'
import { SAMPLE_SURVEY_THEMES } from './SampleSurveyTabs'

const themeConditions: Record<SampleSurveyInsightTheme, string[]> = {
  activity: ['対戦あり：対象期間に1戦以上', '平均：0戦・0キャラを含む有効アカウント'],
  character: ['使用者：対象期間にそのキャラで1戦以上', '勝率：標本内の勝数合計 ÷ 対戦数合計'],
  matchup: ['勝率：1戦以上あるアカウントの掲載勝率中央値'],
  battle: ['平均：アカウントごとの公式集計値の単純平均', '期間：各アカウントの過去100戦'],
  recent: ['集計単位：アカウント側の戦歴記録（同じ試合の重複を含む）', 'モダン割合：M記録数 ÷ C・M記録数', '活動判定：取得時から7日以内'],
  attributes: ['地域：プロフィールの設定値', 'ランクマッチ時間：お気に入り情報の掲載者のみ'],
}
function missingState(dataset: SampleSurveyInsightDataset, row: SampleSurveyInsightRow) {
  const coverage = dataset.coverage.find(item => item.stratumId === row.stratumId)
  return coverage && coverage.attemptedAccounts > 0 && coverage.validAccounts === 0 ? '取得失敗' : '未取得'
}
export function SampleSurveyInsightResults({ run, source, theme }: { run: SampleSurveyRun; source: SampleSurveyTarget; theme: SampleSurveyInsightTheme }) {
  const datasets = run.insights?.datasets.filter(dataset => dataset.target === source && dataset.theme === theme) ?? []
  const [condition, setCondition] = useState('')
  const dataset = datasets.find(item => surveyConditionKey(item) === condition) ?? datasets[0]
  const title = SAMPLE_SURVEY_THEMES.find(([key]) => key === theme)![1]
  if (!dataset) return <StatisticsPanel title={title}><p className="sample-survey-empty" role="status">{run.strata.some(row => row.target === source) ? '未取得' : 'この取得日は調査対象なし'}</p></StatisticsPanel>
  return <SampleSurveyInsightDatasetResults run={run} dataset={dataset} title={title}
    conditionControl={datasets.length > 1 ? <label><span>集計期間・モード</span><select value={surveyConditionKey(dataset)} onChange={event => setCondition(event.target.value)}>
      {datasets.map(item => <option key={surveyConditionKey(item)} value={surveyConditionKey(item)}>{surveyConditionLabel(item)}</option>)}</select></label> : null} />
}

function SampleSurveyInsightDatasetResults({ run, dataset, title, conditionControl }: { run: SampleSurveyRun; dataset: SampleSurveyInsightDataset; title: string; conditionControl: ReactNode }) {
  const { theme, target } = dataset
  const strata = run.strata.filter(row => row.target === target)
  const [selectedStratum, setSelectedStratum] = useState(strata.find(row => dataset.rows.some(item => item.stratumId === row.id))?.id ?? strata[0]?.id ?? '')
  const [selectedCharacter, setSelectedCharacter] = useState('')
  const [selectedMetric, setSelectedMetric] = useState<SampleSurveyInsightMetric | ''>('')
  const [categoryGroup, setCategoryGroup] = useState<'region' | 'platform'>('region')
  const [names, setNames] = useState<ReadonlyMap<string, string> | null>(null)
  useEffect(() => {
    if (theme !== 'character' && theme !== 'matchup') return
    let active = true
    void loadCharacterManifest().then(manifest => { if (active) setNames(japaneseCharacterNames(manifest.characters)) }).catch(() => {})
    return () => { active = false }
  }, [theme])
  const metrics = surveyMetricKeys(dataset)
  const metric = metrics.includes(selectedMetric as SampleSurveyInsightMetric) ? selectedMetric as SampleSurveyInsightMetric : metrics[0]
  const categories = metric === 'categoryShare'
  const groups = (['region', 'platform'] as const).filter(group => dataset.rows.some(row => row.category?.startsWith(group)))
  const group = groups.includes(categoryGroup) ? categoryGroup : groups[0]
  const byCharacter = theme === 'character' || theme === 'matchup'
  const singleStratum = byCharacter || categories
  const characters = [...new Set(dataset.rows.filter(row => row.stratumId === selectedStratum).flatMap(row => row.characterId ? [row.characterId] : []))]
  const character = characters.includes(selectedCharacter) ? selectedCharacter : characters[0]
  const rowMetrics = theme === 'battle' || theme === 'attributes' ? (metric ? [metric] : []) : metrics
  const sourceRows = dataset.rows.filter(row => (!singleStratum || row.stratumId === selectedStratum)
    && (theme !== 'matchup' || row.characterId === character)
    && (categories ? row.category?.startsWith(group) : row.category === undefined))
  // A missing stratum is a visible missing result, never an observed zero.
  const rows: SampleSurveyInsightRow[] = singleStratum ? sourceRows : strata.map(stratum => sourceRows.find(row => row.stratumId === stratum.id) ?? { stratumId: stratum.id, validAccounts: 0, metrics: {} })
  const label = (row: SampleSurveyInsightRow) => row.opponentCharacterId ? names?.get(row.opponentCharacterId) ?? row.opponentCharacterId
    : row.characterId ? names?.get(row.characterId) ?? row.characterId
      : row.category ? SAMPLE_SURVEY_CATEGORY_LABELS[row.category] : strata.find(stratum => stratum.id === row.stratumId)!.label
  const key = (row: SampleSurveyInsightRow) => [row.stratumId, row.characterId, row.opponentCharacterId, row.category].join('|')
  const outside = (row: SampleSurveyInsightRow, column: SampleSurveyInsightMetric) => target === 'lp' && row.stratumId !== 'lp-MASTER' && column === 'medianMr'
  const valueFor = (row: SampleSurveyInsightRow, column: SampleSurveyInsightMetric) => outside(row, column) ? null : sampleSurveyMetricValue(row.metrics[column])
  const state = (row: SampleSurveyInsightRow, column: SampleSurveyInsightMetric) => outside(row, column) ? '対象外' : row.metrics[column] === undefined ? missingState(dataset, row) : surveyCellState(row.metrics[column])
  const coverage = dataset.coverage.filter(row => !singleStratum || row.stratumId === selectedStratum)
  const attempted = coverage.reduce((sum, row) => sum + row.attemptedAccounts, 0), valid = coverage.reduce((sum, row) => sum + row.validAccounts, 0), failed = coverage.reduce((sum, row) => sum + row.failedAccounts, 0)
  const conditions = theme === 'character' && dataset.period.kind === 'capture' ? ['値：取得時点のキャラ別LP・MR', 'MR：掲載値があるアカウントのみ'] : themeConditions[theme]
  return <>
    <StatisticsPanel title={title} headerContent={<span className="monthly-statistics-panel-summary">{surveyCoverageState(attempted, valid, failed)} · 有効 {valid.toLocaleString('ja-JP')}件</span>}>
      <div className="win-rates-filters sample-survey-local-filters">
        {conditionControl}
        {singleStratum && <label><span>{target === 'lp' ? '取得時ランク' : '取得時MR帯'}</span><select value={selectedStratum} onChange={event => setSelectedStratum(event.target.value)}>{strata.map(row => <option key={row.id} value={row.id}>{row.label}</option>)}</select></label>}
        {theme === 'matchup' && characters.length > 0 && <label><span>使用キャラ</span><select value={character} onChange={event => setSelectedCharacter(event.target.value)}>{characters.map(id => <option key={id} value={id}>{names?.get(id) ?? id}</option>)}</select></label>}
        {(theme === 'battle' || theme === 'attributes') && metrics.length > 1 && <label><span>指標</span><select value={metric} onChange={event => setSelectedMetric(event.target.value as SampleSurveyInsightMetric)}>{metrics.map(key => <option key={key} value={key}>{SAMPLE_SURVEY_METRIC_LABELS[key].label}</option>)}</select></label>}
        {categories && groups.length > 1 && <label><span>属性</span><select value={group} onChange={event => setCategoryGroup(event.target.value as typeof group)}>{groups.map(value => <option key={value} value={value}>{value === 'region' ? '設定地域' : 'プラットフォーム'}</option>)}</select></label>}
      </div>
      <div className="sample-survey-capture"><span>{surveyConditionLabel(dataset)}</span><span>取得期間：<DistributionCapturePeriod start={dataset.capturedAt.start} end={dataset.capturedAt.end} /></span></div>
      {!metric || rows.length === 0 ? <p className="sample-survey-empty" role="status">{valid === 0 ? surveyCoverageState(attempted, valid, failed) : '未取得'}</p>
        : <div className="data-table-scroll" role="region" tabIndex={0} aria-label={`${title}の標本集計表`}><table className="data-table sample-survey-insights-table"><thead><tr>
          <th scope="col">{theme === 'matchup' ? '相手キャラ' : theme === 'character' ? 'キャラ' : categories ? group === 'region' ? '設定地域' : 'プラットフォーム' : target === 'lp' ? '取得時ランク' : '取得時MR帯'}</th>
          {rowMetrics.map(key => <th key={key} scope="col">{SAMPLE_SURVEY_METRIC_LABELS[key].label}<span className="sample-survey-cell-detail">{SAMPLE_SURVEY_METRIC_LABELS[key].unit}</span></th>)}
        </tr></thead><tbody>{rows.map(row => <tr key={key(row)}><th scope="row">{label(row)}</th>{rowMetrics.map(column => {
          const cell = row.metrics[column], value = valueFor(row, column)
          return <td key={column}>{value === null ? state(row, column) : sampleSurveyBarNumber(value)}<span className="sample-survey-cell-detail">{outside(row, column) ? null : surveyCellDetail(cell)}</span></td>
        })}</tr>)}</tbody></table></div>}
      <div className="sample-survey-result-meta"><span>n：指標ごとの有効アカウント数</span>{conditions.map(text => <span key={text}>{text}</span>)}</div>
    </StatisticsPanel>
    {metric && rows.length > 0 && <StatisticsPanel title="標本内の比較">
      {theme !== 'battle' && theme !== 'attributes' && metrics.length > 1 && <div className="win-rates-filters sample-survey-local-filters"><label><span>グラフの指標</span><select value={metric} onChange={event => setSelectedMetric(event.target.value as SampleSurveyInsightMetric)}>{metrics.map(key => <option key={key} value={key}>{SAMPLE_SURVEY_METRIC_LABELS[key].label}</option>)}</select></label></div>}
      <SampleSurveyBarChart title={SAMPLE_SURVEY_METRIC_LABELS[metric].label} unit={SAMPLE_SURVEY_METRIC_LABELS[metric].unit} percent={SAMPLE_SURVEY_METRIC_LABELS[metric].unit === '%'}
        rows={rows.map(row => ({ id: key(row), label: label(row), value: valueFor(row, metric), stateLabel: state(row, metric) }))} />
    </StatisticsPanel>}
  </>
}
