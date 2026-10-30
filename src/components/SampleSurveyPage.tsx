import { useId, useMemo, useState } from 'react'
import { timestampLabel } from '../lib/dateTime'
import { useSampleSurveyResults } from '../lib/useSampleSurveyResults'
import type { SampleSurveyTarget } from '../types/sampleSurvey'
import { DataLoadState } from './DataLoadState'
import { DistributionCapturePeriod } from './DistributionCapturePeriod'
import { StatisticsPanel } from './StatisticsPanel'
import { SampleSurveyTabs, type SampleSurveyTheme } from './SampleSurveyTabs'
import { SampleSurveyRatingResults } from './SampleSurveyRatingResults'
import { SampleSurveyInsightResults } from './SampleSurveyInsightResults'
import { SampleSurveyQuality } from './SampleSurveyQuality'
import '../win-rates.css'
import '../table.css'
import '../sample-survey.css'

export function SampleSurveyPage() {
  const { descriptors, selectedId, setSelectedId, run, loading, error, refreshError, refresh, updatedAt } = useSampleSurveyResults()
  const prefix = useId(), panelId = prefix + '-results'
  const [source, setSource] = useState<SampleSurveyTarget>('lp')
  const [theme, setTheme] = useState<SampleSurveyTheme>('rating')
  const ordered = useMemo(() => [...descriptors].sort((a, b) => Date.parse(b.captureEndedAt) - Date.parse(a.captureEndedAt)), [descriptors])
  const rows = run?.strata.filter(row => row.target === source) ?? []
  const review = run?.observation?.strata.some(row => rows.some(item => item.id === row.id) && row.status === 'review-required')
  const approximate = run?.observation?.method === 'rank-position-tolerant-v1'
    && run.observation.strata.some(row => rows.some(item => item.id === row.id) && row.boundaryAcceptance?.mode === 'approximate')
  return <section className="sample-survey-page" aria-label="標本調査">
    <StatisticsPanel title="表示条件" headerContent={<span className="monthly-statistics-panel-summary">日時はJST</span>}>
      <div className="win-rates-filters sample-survey-filters">
        <label><span>取得日</span><select aria-label="取得日" value={selectedId ?? ''} disabled={ordered.length < 2} onChange={event => setSelectedId(event.target.value)}>
          {ordered.length === 0 && <option value="">{loading ? '読み込み中' : error ? '読み込み失敗' : '未取得'}</option>}
          {ordered.map(item => <option key={item.id} value={item.id}>{timestampLabel(item.captureEndedAt)}</option>)}
        </select></label>
        <div className="sample-survey-target"><span>取得時の区分</span><div className="win-rates-view-selector" role="group" aria-label="取得時の区分">
          {([['lp', 'LPランク'], ['mr', 'MR帯']] as const).map(([value, label]) => <button key={value} type="button" className="win-rates-button" aria-pressed={source === value} onClick={() => setSource(value)}>{label}</button>)}
        </div></div>
      </div>
      <div className="sample-survey-result-meta"><span>抽出元：{source === 'lp' ? '最大LP一覧' : '取得時の今Act・最大MR一覧'}</span><span>集計範囲：標本内</span>
        {run?.finishedAt && <span>取得期間：<DistributionCapturePeriod start={run.startedAt} end={run.finishedAt} /></span>}</div>
    </StatisticsPanel>
    <SampleSurveyTabs value={theme} onChange={setTheme} idPrefix={prefix} panelId={panelId} />
    {refreshError && <div className="sample-survey-message" role="status"><span>{refreshError}</span><button className="win-rates-button" type="button" onClick={refresh}>更新を再確認</button></div>}
    {review && <div className="sample-survey-change-status" role="status">境界の確認状態：{approximate ? '近似採用・要確認を含む' : '要確認を含む'}</div>}
    <div id={panelId} role="tabpanel" aria-labelledby={prefix + '-tab-' + theme} className="sample-survey-results">
      {loading && !run ? <DataLoadState loading message="標本調査の結果を読み込み中…" />
        : error && !run ? <DataLoadState message={error} onRetry={refresh} />
          : !run ? <StatisticsPanel title="調査結果"><p className="sample-survey-empty" role="status">未取得</p></StatisticsPanel>
            : theme === 'rating' ? <SampleSurveyRatingResults run={run} source={source} />
              : <SampleSurveyInsightResults key={run.id + '-' + source + '-' + theme} run={run} source={source} theme={theme} />}
    </div>
    {run && <SampleSurveyQuality run={run} source={source} />}
    <div className="sample-survey-result-meta"><span>出典：<a href={'https://www.streetfighter.com/6/buckler/ja-jp/ranking/' + (source === 'lp' ? 'league' : 'master')} target="_blank" rel="noreferrer">Buckler<span className="win-rates-visually-hidden">（新しいタブ）</span></a></span>
      {updatedAt && <span>配信データ更新：<time dateTime={updatedAt}>{timestampLabel(updatedAt)}</time></span>}</div>
  </section>
}
