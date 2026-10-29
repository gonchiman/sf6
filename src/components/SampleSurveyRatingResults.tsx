import { useState } from 'react'
import type { SampleSurveyRun, SampleSurveyTarget } from '../types/sampleSurvey'
import { StatisticsPanel } from './StatisticsPanel'
import { SampleSurveyBarChart } from './SampleSurveyBarChart'

const format = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 1 })
const metrics = { mean: '平均', min: '最小', max: '最大' } as const
export function SampleSurveyRatingResults({ run, source }: { run: SampleSurveyRun; source: SampleSurveyTarget }) {
  const [metric, setMetric] = useState<keyof typeof metrics>('mean')
  const rows = run.strata.filter(row => row.target === source), unit = source === 'lp' ? 'LP' : 'MR'
  const count = rows.reduce((sum, row) => sum + row.succeeded, 0)
  const state = (row: typeof rows[number]) => row.population === null ? '未取得' : row.succeeded === 0 ? '算出不可' : '欠測'
  return <>
    <StatisticsPanel title={`${unit}の調査結果`} headerContent={<span className="monthly-statistics-panel-summary">{rows.length === 0 ? '調査対象なし' : rows.every(row => row.population === null) ? '未取得' : `有効標本数 ${count.toLocaleString('ja-JP')}件`}</span>}>
      {rows.length === 0 ? <p className="sample-survey-empty" role="status">この取得日は調査対象なし</p>
        : <div className="data-table-scroll" role="region" tabIndex={0} aria-label={`${unit}の標本集計表`}>
          <table className="data-table sample-survey-values-table"><thead><tr><th scope="col">{source === 'lp' ? '取得時ランク' : '取得時MR帯'}</th><th scope="col">有効標本 n</th>
            {Object.entries(metrics).map(([key, label]) => <th scope="col" key={key}>{label}{unit}</th>)}
          </tr></thead><tbody>{rows.map(row => <tr key={row.id}><th scope="row">{row.label}</th><td>{row.population === null ? '未取得' : row.succeeded.toLocaleString('ja-JP')}</td>
            {(Object.keys(metrics) as (keyof typeof metrics)[]).map(key => <td key={key}>{row[key] === null ? state(row) : format.format(row[key])}</td>)}</tr>)}</tbody></table>
        </div>}
      <div className="sample-survey-result-meta"><span>値：取得時点</span><span>集計単位：掲載アカウント</span></div>
    </StatisticsPanel>
    {rows.length > 0 && <StatisticsPanel title={`${source === 'lp' ? 'ランク' : 'MR帯'}別の比較`}>
      <div className="win-rates-filters sample-survey-local-filters"><label><span>グラフの指標</span><select value={metric} onChange={event => setMetric(event.target.value as keyof typeof metrics)}>
        {Object.entries(metrics).map(([key, label]) => <option key={key} value={key}>{label}{unit}</option>)}</select></label></div>
      <SampleSurveyBarChart title={`${metrics[metric]}${unit}`} unit={unit} rows={rows.map(row => ({ id: row.id, label: row.label, value: row[metric], stateLabel: state(row) }))} />
    </StatisticsPanel>}
  </>
}
