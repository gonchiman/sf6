import { useId, useMemo, useState } from 'react'
import { timestampLabel } from '../lib/dateTime'
import { useSampleSurveyResults } from '../lib/useSampleSurveyResults'
import type { SampleSurveyTarget } from '../types/sampleSurvey'
import { DataLoadState } from './DataLoadState'
import { DistributionCapturePeriod } from './DistributionCapturePeriod'
import { StatisticsPanel } from './StatisticsPanel'
import '../win-rates.css'
import '../table.css'
import '../sample-survey.css'

const integer = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 0 })
const decimal = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 1 })
const metricLabels = { mean: '平均', min: '最小', max: '最大' } as const

export function SampleSurveyPage() {
  const { descriptors, selectedId, setSelectedId, run: selectedRun, loading, error, refreshError, refresh, updatedAt } = useSampleSurveyResults()
  const contentId = useId()
  const [source, setSource] = useState<SampleSurveyTarget>('lp')
  const [metric, setMetric] = useState<keyof typeof metricLabels>('mean')
  const orderedDescriptors = useMemo(() => [...descriptors].sort((left, right) =>
    Date.parse(right.captureEndedAt) - Date.parse(left.captureEndedAt)), [descriptors])
  const rows = selectedRun?.strata.filter(row => row.target === source) ?? []
  const validCount = rows.reduce((sum, row) => sum + row.succeeded, 0)
  const seriesLabel = source === 'lp' ? 'ランク別' : 'MR帯別'
  const sourceLabel = source === 'lp' ? '最大LP一覧' : '取得時の今Act・最大MR一覧'

  return <section className="sample-survey-page" aria-label="標本調査">
    <div className="win-rates-view-selector" role="group" aria-label="標本調査の対象">
      {([['lp', 'LPランク'], ['mr', 'MR帯']] as const).map(([value, label]) => <button key={value}
        type="button" className="win-rates-button" aria-pressed={source === value} aria-controls={contentId}
        onClick={() => setSource(value)}>{label}</button>)}
    </div>

    <StatisticsPanel title="表示条件" headerContent={<span className="monthly-statistics-panel-summary">日時はJST</span>}>
      <div className="win-rates-filters sample-survey-filters">
        <label><span>取得日</span><select aria-label="取得日" value={selectedId ?? ''} disabled={orderedDescriptors.length < 2}
          onChange={event => setSelectedId(event.target.value)}>
          {orderedDescriptors.length === 0 && <option value="">{loading ? '読み込み中' : error ? '読み込み失敗' : '未取得'}</option>}
          {orderedDescriptors.map(item => <option key={item.id} value={item.id}>{timestampLabel(item.captureEndedAt)}</option>)}
        </select></label>
        <label><span>統計量</span><select aria-label="統計量" value={metric} disabled={rows.length === 0}
          onChange={event => setMetric(event.target.value as keyof typeof metricLabels)}>
          {Object.entries(metricLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select></label>
      </div>
    </StatisticsPanel>

    <StatisticsPanel id={contentId} title={`${seriesLabel}の調査結果`} headerContent={<span className="monthly-statistics-panel-summary">
      {selectedRun && rows.length > 0 ? `有効標本数 ${integer.format(validCount)}件` : '標本内の統計量'}
    </span>}>
      {refreshError && <div className="sample-survey-message" role="status">
        <span>{refreshError}</span>
        <button className="win-rates-button" type="button" onClick={refresh}>更新を再確認</button>
      </div>}
      {loading && !selectedRun ? <DataLoadState loading message="標本調査の結果を読み込み中…" />
        : error && !selectedRun ? <DataLoadState message={error} onRetry={refresh} />
          : !selectedRun ? <p className="sample-survey-empty" role="status">未取得：標本調査の結果はまだありません。</p>
            : <>
              <div className="sample-survey-capture">
                <span>観測期間：{selectedRun.finishedAt ? <DistributionCapturePeriod start={selectedRun.startedAt} end={selectedRun.finishedAt} /> : '—'}</span>
                <span>層別抽出 · 掲載アカウント単位</span>
              </div>
              {selectedRun.frameChanged && <p className="sample-survey-message" role="status">取得中に掲載総数・抽出範囲の変化あり</p>}
              {rows.length === 0 ? <p className="sample-survey-empty" role="status">この取得日は{seriesLabel}の調査対象なし</p>
                : <div className="data-table-scroll sample-survey-scroll" role="region" tabIndex={0} aria-label={`${seriesLabel}の標本調査結果・スクロール領域`}>
                  <table className="data-table sample-survey-table"><thead><tr>
                    <th scope="col">{source === 'lp' ? 'ランク' : 'MR帯'}</th><th scope="col">抽出標本数</th><th scope="col">有効標本数</th>
                    <th scope="col">欠測</th><th scope="col">重複</th><th scope="col">{metricLabels[metric]}{source === 'lp' ? 'LP' : 'MR'}</th>
                  </tr></thead><tbody>{rows.map(row => <tr key={row.id}>
                    <th scope="row">{row.label}</th><td>{row.population === null ? '—' : integer.format(row.selected)}</td>
                    <td>{integer.format(row.succeeded)}</td><td>{integer.format(row.missing)}</td><td>{integer.format(row.duplicates)}</td>
                    <td>{row[metric] === null ? '—' : decimal.format(row[metric])}</td>
                  </tr>)}</tbody></table>
                </div>}
              <div className="sample-survey-result-meta"><span>標本内の統計量 · 母集団全体の推定値ではありません</span></div>
            </>}
      <div className="sample-survey-result-meta">
        <span>出典：<a href={`https://www.streetfighter.com/6/buckler/ja-jp/ranking/${source === 'lp' ? 'league' : 'master'}`} target="_blank" rel="noreferrer">Buckler {sourceLabel}<span className="win-rates-visually-hidden">（新しいタブ）</span></a></span>
        {updatedAt && <span>配信データ更新：<time dateTime={updatedAt}>{timestampLabel(updatedAt)}</time></span>}
      </div>
    </StatisticsPanel>
  </section>
}
