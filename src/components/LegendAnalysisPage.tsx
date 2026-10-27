import { useEffect, useMemo, useState } from 'react'
import { japaneseCharacterNames } from '../lib/characterNames'
import { loadCharacterManifest } from '../lib/characters'
import { timestampLabel } from '../lib/dateTime'
import {
  createLegendCharacterRows, findPreviousLegendAnalysisDescriptor, legendAnalysisCanCompare,
} from '../lib/legendAnalysis'
import { legendAnalysisFeed } from '../lib/legendAnalysisFeed'
import { usePublishedData } from '../lib/usePublishedData'
import type { LegendAnalysisDataset } from '../types/legendAnalysis'
import { DataLoadState } from './DataLoadState'
import { LegendAnalysisFilters } from './LegendAnalysisFilters'
import { LegendCharacterTable } from './LegendCharacterTable'
import { LegendMrDistributionChart } from './LegendMrDistributionChart'
import { LegendSourceDetails } from './LegendSourceDetails'
import { StatisticsPanel } from './StatisticsPanel'
import '../win-rates.css'
import '../legend-analysis.css'

type DatasetState = { key: string; version: number } & (
  { status: 'loading' | 'error' } | { status: 'ready'; dataset: LegendAnalysisDataset }
)
const integerFormat = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 0 })

export function LegendAnalysisPage() {
  const { status, publication, selectedId, setSelectedId, refreshError, retry } = usePublishedData(legendAnalysisFeed)
  const [loaded, setLoaded] = useState<DatasetState | null>(null)
  const [datasetVersion, setDatasetVersion] = useState(0)
  const [previousLoaded, setPreviousLoaded] = useState<DatasetState | null>(null)
  const [previousVersion, setPreviousVersion] = useState(0)
  const [names, setNames] = useState<ReadonlyMap<string, string> | null>(null)
  const [namesError, setNamesError] = useState(false)
  const [namesVersion, setNamesVersion] = useState(0)

  useEffect(() => {
    let current = true
    setNamesError(false)
    void loadCharacterManifest().then(manifest => {
      if (current) setNames(japaneseCharacterNames(manifest.characters))
    }).catch(() => { if (current) setNamesError(true) })
    return () => { current = false }
  }, [namesVersion])

  const manifest = publication?.manifest ?? null
  const descriptors = useMemo(() => manifest ? [...manifest.datasets]
    .sort((a, b) => Date.parse(b.captureEndedAt) - Date.parse(a.captureEndedAt)) : [], [manifest])
  const descriptor = descriptors.find(item => item.id === selectedId) ?? null
  const previousDescriptor = useMemo(() => manifest && descriptor
    ? findPreviousLegendAnalysisDescriptor(manifest, descriptor) : null, [manifest, descriptor])
  const requestKey = publication && descriptor ? JSON.stringify([publication.baseUrl, manifest!.generatedAt, descriptor]) : null
  const previousKey = manifest && previousDescriptor ? JSON.stringify([requestKey, previousDescriptor]) : null

  useEffect(() => {
    if (!publication || !descriptor || !requestKey) return
    let current = true
    const key = requestKey
    setLoaded({ key, version: datasetVersion, status: 'loading' })
    void legendAnalysisFeed.loadDataset(publication, descriptor).then(dataset => {
      if (current) setLoaded({ key, version: datasetVersion, status: 'ready', dataset })
    }).catch(() => { if (current) setLoaded({ key, version: datasetVersion, status: 'error' }) })
    return () => { current = false }
  }, [publication, descriptor, requestKey, datasetVersion])

  useEffect(() => {
    if (!publication || !previousDescriptor || !previousKey) return
    let current = true
    const key = previousKey
    setPreviousLoaded({ key, version: previousVersion, status: 'loading' })
    void legendAnalysisFeed.loadDataset(publication, previousDescriptor).then(dataset => {
      if (current) setPreviousLoaded({ key, version: previousVersion, status: 'ready', dataset })
    }).catch(() => { if (current) setPreviousLoaded({ key, version: previousVersion, status: 'error' }) })
    return () => { current = false }
  }, [publication, previousDescriptor, previousKey, previousVersion])

  // A changed selection or retry must never display the previous request's numbers.
  const current = loaded?.key === requestKey && loaded.version === datasetVersion ? loaded : null
  const dataset = current?.status === 'ready' ? current.dataset : null
  const previousState = previousLoaded?.key === previousKey && previousLoaded.version === previousVersion ? previousLoaded : null
  const previousDataset = previousState?.status === 'ready' ? previousState.dataset : null
  const previous = dataset && previousDataset && legendAnalysisCanCompare(dataset, previousDataset) ? previousDataset : null
  const rows = useMemo(() => dataset ? createLegendCharacterRows(dataset, previous) : [], [dataset, previous])

  if (status === 'loading') return <DataLoadState loading message="レジェンド帯分析の取得日を読み込み中…" />
  if (!manifest) return <DataLoadState message="レジェンド帯分析の取得日を読み込めませんでした。"
    onRetry={retry} />

  const availability = manifest.availability
  const availabilityLabel = availability?.status === 'collection-failed' ? '取得失敗'
    : availability?.status === 'verification-pending' ? '検証待ち' : '未取得'
  const previousStatus = !previousDescriptor ? '同じAct・集計定義・取得条件で比較できる前回の記録はありません。前回差は「—」で表示します。'
    : !previousState || previousState.status === 'loading' ? '同じAct内の前回データを読み込み中…'
      : previousState.status === 'error' ? '前回データを読み込めませんでした。今回の数値を表示し、前回差は「—」で表示します。'
        : !previous ? '取得条件を確認できないため、前回差は「—」で表示します。' : null

  return <section className="legend-analysis-page" aria-label="レジェンド帯分析">
    <p className="legend-analysis-scope">掲載エントリーのキャラ構成とMR分布 · アカウント × キャラ単位</p>
    {(refreshError || publication?.source === 'bundled') && <div className="legend-analysis-message" role="status">
      <div>{publication?.source === 'bundled' ? '最新データを確認できません。同梱データを表示しています。' : '更新を確認できません。前回読み込んだデータを表示しています。'}</div>
      <button className="win-rates-button" type="button" onClick={retry}>更新を再確認</button>
    </div>}
    <StatisticsPanel title="条件選択" headerContent={<span className="monthly-statistics-panel-summary">日時はJST</span>}>
      <LegendAnalysisFilters descriptors={descriptors} actId={descriptor?.actId ?? null} selectedId={selectedId}
        actLabel={dataset?.act.label}
        onActChange={actId => setSelectedId(descriptors.find(item => item.actId === actId)?.id ?? null)}
        onCaptureChange={setSelectedId} />
      {dataset && <dl className="legend-analysis-capture">
        <div><dt>取得区間</dt><dd><time dateTime={dataset.captureStartedAt}>{timestampLabel(dataset.captureStartedAt)}</time><br />
          〜 <time dateTime={dataset.captureEndedAt}>{timestampLabel(dataset.captureEndedAt)}</time></dd></div>
        <div><dt>掲載エントリー数</dt><dd><strong>{integerFormat.format(dataset.totalCount)}</strong> 件</dd></div>
        <div><dt>対象</dt><dd>{dataset.act.label}<br />{dataset.conditions.region === 'all' ? '全地域' : dataset.conditions.region}
          {' · '}{dataset.conditions.platform === 'all' ? '全プラットフォーム' : dataset.conditions.platform}</dd></div>
      </dl>}
    </StatisticsPanel>

    {availability && <p className="legend-analysis-message" role="status">{availabilityLabel}（確認日時：<time dateTime={availability.checkedAt}>{timestampLabel(availability.checkedAt)}</time>）：{availability.message}</p>}
    {!descriptor ? !availability && <p className="legend-analysis-message" role="status">未取得：検証済みのレジェンド帯分析データはまだ登録されていません。</p>
      : !current || current.status === 'loading' ? <DataLoadState loading message="選択した取得日のレジェンド帯データを読み込み中…" />
        : current.status === 'error' ? <DataLoadState message="選択した取得日のレジェンド帯データを読み込めませんでした。"
          onRetry={() => setDatasetVersion(value => value + 1)} /> : null}

    {dataset && <>
      {dataset.totalCount === 0 && <p className="legend-analysis-message" role="status">取得・検証済みの掲載数は0件です。件数は0、構成比とMRの要約値は算出できないため「—」で表示します。</p>}
      {previousStatus && <div className="legend-analysis-message" role={previousState?.status === 'error' ? 'alert' : 'status'}>
        <div>{previousStatus}</div>
        {previousState?.status === 'error' && <button className="win-rates-button" type="button" onClick={() => setPreviousVersion(value => value + 1)}>前回データを再読み込み</button>}
      </div>}
      {previous && <p className="legend-analysis-note">比較する前回：<time dateTime={previous.captureStartedAt}>{timestampLabel(previous.captureStartedAt)}</time>
        {' 〜 '}<time dateTime={previous.captureEndedAt}>{timestampLabel(previous.captureEndedAt)}</time> · {integerFormat.format(previous.totalCount)}件</p>}

      <StatisticsPanel title="キャラ構成" headerContent={<span className="monthly-statistics-panel-summary">掲載あり {rows.filter(row => row.count > 0).length} ／ {rows.length} キャラ</span>}>
        <div className="legend-analysis-content">
          <p className="legend-analysis-note">今回の掲載数に占める割合です。前回差は各回の掲載集団を比較した値で、ppはパーセントポイントを表します。</p>
          {namesError && <div className="legend-analysis-message" role="status"><div>キャラ名の日本語一覧を読み込めなかったため、取得元のキャラ名を表示しています。</div>
            <button className="win-rates-button" type="button" onClick={() => setNamesVersion(value => value + 1)}>キャラ名を再読み込み</button></div>}
          <LegendCharacterTable rows={rows} names={names} />
        </div>
      </StatisticsPanel>

      <StatisticsPanel title="MR分布" headerContent={<span className="monthly-statistics-panel-summary">50 MR刻み · 各回の掲載数を分母に集計</span>}>
        <LegendMrDistributionChart current={dataset.mr} previous={previous?.mr ?? null}
          currentLabel={timestampLabel(dataset.captureEndedAt)} previousLabel={previous ? timestampLabel(previous.captureEndedAt) : null} />
      </StatisticsPanel>
    </>}

    <LegendSourceDetails manifest={manifest} dataset={dataset} previous={previous} />
  </section>
}
