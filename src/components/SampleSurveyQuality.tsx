import { surveyConditionKey, surveyConditionLabel, surveyCoverageState } from '../lib/sampleSurveyPresentation'
import { SAMPLE_SURVEY_MAX_BOUNDARY_DELTA, SAMPLE_SURVEY_MAX_BOUNDARY_RELATIVE_DELTA } from '../lib/sampleSurvey'
import type { SampleSurveyBoundaryAcceptance, SampleSurveyRun, SampleSurveyTarget } from '../types/sampleSurvey'
import { DistributionCapturePeriod } from './DistributionCapturePeriod'
import { SAMPLE_SURVEY_THEMES } from './SampleSurveyTabs'

const count = (value: number | null | undefined) => value == null ? '—' : value.toLocaleString('ja-JP')
const signedCount = (value: number) => `${value > 0 ? '+' : ''}${count(value)}`
const boundaryTime = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', dateStyle: 'medium', timeStyle: 'medium' })

function BoundaryTime({ value }: { value: string }) {
  return <time dateTime={value}>{boundaryTime.format(new Date(value))} JST</time>
}

function BoundaryAcceptanceRecord({ value }: { value: SampleSurveyBoundaryAcceptance | undefined }) {
  if (!value) return <>未採用</>
  const startDelta = value.start - value.referenceStart, endDelta = value.end - value.referenceEnd
  const limit = Math.min(2 * SAMPLE_SURVEY_MAX_BOUNDARY_DELTA,
    Math.floor((value.referenceEnd - value.referenceStart) / (1 / SAMPLE_SURVEY_MAX_BOUNDARY_RELATIVE_DELTA)))
  return <>
    <div>開始：{count(value.referenceStart)} → {count(value.start)}（差 {signedCount(startDelta)}）</div>
    <div>終了：{count(value.referenceEnd)} → {count(value.end)}（差 {signedCount(endDelta)}）</div>
    <span className="sample-survey-cell-detail">採用：{value.mode === 'approximate' ? '近似' : '一致'} · 抽出区間幅：{count(value.end - value.start)}枠</span>
    <span className="sample-survey-cell-detail">移動量合計：{count(Math.abs(startDelta) + Math.abs(endDelta))}位置 · 許容：{count(limit)}位置</span>
    <span className="sample-survey-cell-detail">初期観測：<BoundaryTime value={value.referenceCheckedAt} /></span>
    <span className="sample-survey-cell-detail">開始観測：<BoundaryTime value={value.startObservedAt} /></span>
    <span className="sample-survey-cell-detail">終了観測：<BoundaryTime value={value.endObservedAt} /></span>
  </>
}

export function SampleSurveyQuality({ run, source }: { run: SampleSurveyRun; source: SampleSurveyTarget }) {
  const strata = run.strata.filter(row => row.target === source)
  const observations = run.observation?.strata.filter(row => strata.some(stratum => stratum.id === row.id)) ?? []
  const totalChanged = run.observation?.changes.some(change => change.target === source && change.kind === 'total-count')
    || observations.some(row => row.totalCountBefore !== null && row.totalCountAfter !== null && row.totalCountBefore !== row.totalCountAfter)
  const datasets = run.insights?.datasets.filter(dataset => dataset.target === source) ?? []
  const coverageRows = datasets.flatMap(dataset => dataset.coverage.map(coverage => ({ dataset, coverage })))
  const stratumHeading = source === 'lp' ? '取得時ランク' : '取得時MR帯'
  const tolerant = run.observation?.method === 'rank-position-tolerant-v1'

  return <details className="sample-survey-quality">
    <summary>取得状況・集計条件</summary>
    <div className="sample-survey-quality-content">
      <dl className="sample-survey-quality-definitions">
        <div><dt>集計範囲</dt><dd>標本内</dd></div>
        <div><dt>集計単位</dt><dd>掲載アカウント</dd></div>
        <div><dt>母集団への推定</dt><dd>未実施</dd></div>
        <div><dt>抽出方式</dt><dd>{tolerant ? '順位枠抽出・小さな境界変動を許容' : run.observation ? '観測期間内の順位枠抽出' : '層別抽出（旧形式）'}</dd></div>
        {tolerant && <div><dt>境界移動の上限</dt><dd>各端{count(SAMPLE_SURVEY_MAX_BOUNDARY_DELTA)}位置・合計は初期区間幅の0.1％（切捨て）</dd></div>}
      </dl>
      <h3 className="sample-survey-quality-heading">抽出・境界確認</h3>
      {strata.length === 0 ? <p className="sample-survey-empty">この取得日は調査対象なし</p>
        : <div className="data-table-scroll sample-survey-scroll" role="region" tabIndex={0} aria-label="標本の抽出数と境界確認の記録">
          <table className="data-table sample-survey-table sample-survey-table-observed">
            <thead><tr><th scope="col">{stratumHeading}</th><th scope="col">予定数</th><th scope="col">抽出数</th><th scope="col">有効数</th>
              <th scope="col">欠測</th><th scope="col">重複</th><th scope="col">確認状態</th><th scope="col">掲載総数<br />取得前 → 取得後</th>
              {tolerant && <th scope="col">掲載位置の境界（0起点）<br />初期 → 採用（差）</th>}</tr></thead>
            <tbody>{strata.map(row => {
              const observed = observations.find(item => item.id === row.id)
              const uncollected = row.population === null
              const approximate = tolerant && observed?.boundaryAcceptance?.mode === 'approximate'
              const status = uncollected ? observed?.status === 'review-required' ? tolerant ? '未取得・確認不能' : '未取得・要確認' : '未取得'
                : approximate ? '近似採用・要確認' : observed?.status === 'checked' ? '前後一致'
                : observed?.status === 'review-required' ? '要確認' : observed?.status === 'collecting' ? '確認中' : '未確認'
              return <tr key={row.id}><th scope="row">{row.label}
                {observed?.startedAt && observed.finishedAt && <span className="sample-survey-row-period"><DistributionCapturePeriod start={observed.startedAt} end={observed.finishedAt} /></span>}
              </th><td>{run.schemaVersion === 1 ? '—' : count(row.requested)}</td><td>{uncollected ? '—' : count(row.selected)}</td>
                <td>{uncollected ? '—' : count(row.succeeded)}</td><td>{uncollected ? '—' : count(row.missing)}</td><td>{uncollected ? '—' : count(row.duplicates)}</td>
                <td className="sample-survey-quality-text-cell">{status}</td><td>{count(observed?.totalCountBefore)} → {count(observed?.totalCountAfter)}</td>
                {tolerant && <td className="sample-survey-quality-text-cell"><BoundaryAcceptanceRecord value={observed?.boundaryAcceptance} /></td>}
              </tr>
            })}</tbody>
          </table>
        </div>}
      <div className="sample-survey-result-meta">
        <span>件数：掲載アカウント</span><span>前後一致：抽出境界の確認結果</span>
        {totalChanged && <span>掲載総数の変化：あり</span>}
        {!run.observation && run.frameChanged && <span>掲載総数・抽出範囲の変化：あり</span>}
        {Boolean(run.observation?.omittedChanges) && <span>省略した変動記録（LP・MR合計）：{count(run.observation?.omittedChanges)}件</span>}
      </div>
      <h3 className="sample-survey-quality-heading">追加データの取得状況</h3>
      {coverageRows.length === 0 ? <p className="sample-survey-empty">未取得</p>
        : <div className="data-table-scroll sample-survey-scroll" role="region" tabIndex={0} aria-label="追加データの条件別取得状況">
          <table className="data-table sample-survey-table sample-survey-table-observed">
            <thead><tr><th scope="col">データ・集計条件</th><th scope="col">{stratumHeading}</th><th scope="col">試行数</th><th scope="col">有効数</th>
              <th scope="col">取得失敗</th><th scope="col">取得状態</th><th scope="col">取得期間</th></tr></thead>
            <tbody>{coverageRows.map(({ dataset, coverage }) => <tr key={[dataset.theme, dataset.target, surveyConditionKey(dataset), coverage.stratumId].join('|')}>
              <th scope="row">{SAMPLE_SURVEY_THEMES.find(([theme]) => theme === dataset.theme)?.[1]}<span className="sample-survey-row-period">{surveyConditionLabel(dataset)}</span></th>
              <td className="sample-survey-quality-text-cell">{strata.find(row => row.id === coverage.stratumId)?.label ?? coverage.stratumId}</td>
              <td>{count(coverage.attemptedAccounts)}</td><td>{count(coverage.validAccounts)}</td><td>{count(coverage.failedAccounts)}</td>
              <td className="sample-survey-quality-text-cell">{surveyCoverageState(coverage.attemptedAccounts, coverage.validAccounts, coverage.failedAccounts)}</td>
              <td className="sample-survey-quality-text-cell"><DistributionCapturePeriod start={dataset.capturedAt.start} end={dataset.capturedAt.end} /></td>
            </tr>)}</tbody>
          </table>
        </div>}
    </div>
  </details>
}
