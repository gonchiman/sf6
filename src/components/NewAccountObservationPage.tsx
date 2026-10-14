import { useEffect, useMemo, useState } from 'react'
import { timestampLabel } from '../lib/dateTime'
import {
  clearPlayerObservationRequests, filterPlayerObservationRuns, initialPlayerObservationSelection,
  loadPlayerObservations, playerObservationRunCountLabel, playerObservationRunStatusLabel,
} from '../lib/playerObservations'
import type { PlayerObservationDataset, PlayerObservationRun, PlayerObservationSelection } from '../types/playerObservations'
import { DataLoadState } from './DataLoadState'
import { PlayerObservationFilters } from './PlayerObservationFilters'
import { PlayerObservationTable } from './PlayerObservationTable'
import { StatisticsPanel } from './StatisticsPanel'
import '../win-rates.css'
import '../player-observations.css'

type LoadState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; dataset: PlayerObservationDataset }

const integerFormat = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 0 })
const countLabel = (value: number | null) => value === null ? '—' : integerFormat.format(value)
const targetLabel = '総合 · 最大LP · 全地域 · 全プラットフォーム'
const coverageLabels: Record<PlayerObservationRun['coverage'], string> = {
  sample: '一部のページを取得',
  'all-pages': '全対象ページを走査',
  incomplete: '未取得・失敗したページあり',
  none: '有効な取得なし',
}

function RecordedTime({ value }: { value: string | null }) {
  return value ? <time dateTime={value}>{timestampLabel(value)}</time> : <>—</>
}

function RunDetails({ dataset, run }: { dataset: PlayerObservationDataset; run: PlayerObservationRun }) {
  return <div className="player-observation-details-content">
    <dl className="player-observation-details">
      <div><dt>取得開始</dt><dd><RecordedTime value={run.startedAt} /></dd></div>
      <div><dt>取得終了</dt><dd><RecordedTime value={run.endedAt} /></dd></div>
      <div><dt>新規観測アカウント数</dt><dd>{playerObservationRunCountLabel(run)}</dd></div>
      <div><dt>観測ID数</dt><dd>{countLabel(run.observedIdCount)}{run.observedIdCount !== null && ' 件'}</dd></div>
      <div><dt>取得状態</dt><dd>{playerObservationRunStatusLabel(run)}</dd></div>
      <div><dt>取得範囲</dt><dd>{coverageLabels[run.coverage]}{run.scope === 'probe' && ' · 実地検証'}</dd></div>
    </dl>
    {run.phase === 'baseline' && <p className="player-observation-note">この観測回は基準となるIDの収集です。初回の観測ID数を新規参入数として数えません。</p>}
    {run.newObservedLowerBound !== null && <p className="player-observation-note">取得できた範囲で初めて観測したIDは少なくとも{integerFormat.format(run.newObservedLowerBound)}件です。未取得範囲を含む全体の新規数は確定していません。</p>}
    {run.failureReason && <p className="player-observation-message" role="status">取得できなかった理由：{run.failureReason}</p>}
    {run.warnings.length > 0 && <ul className="player-observation-warnings">{run.warnings.map((warning, index) => <li key={`${index}-${warning}`}>{warning}</li>)}</ul>}
    <ObservationEvidence dataset={dataset} run={run} />
  </div>
}

function ObservationEvidence({ dataset, run }: { dataset: PlayerObservationDataset; run?: PlayerObservationRun }) {
  return <details className="win-rates-details">
      <summary>取得範囲・出典・定義</summary>
      <div className="win-rates-details-content player-observation-evidence">
        {run && <dl className="player-observation-details">
          <div><dt>観測回ID</dt><dd>{run.id}</dd></div>
          <div><dt>予定日時</dt><dd><RecordedTime value={run.scheduledAt} /></dd></div>
          <div><dt>取得成功ページ</dt><dd>{integerFormat.format(run.pages.succeeded)} ページ</dd></div>
          <div><dt>取得失敗ページ</dt><dd>{integerFormat.format(run.pages.failed)} ページ</dd></div>
          <div><dt>対象ページ数</dt><dd>開始時 {countLabel(run.pages.expectedAtStart)} ／ 終了時 {countLabel(run.pages.expectedAtEnd)}</dd></div>
          {run.pages.sampledPages.length > 0 && <div><dt>検証したページ</dt><dd>{run.pages.sampledPages.map(value => integerFormat.format(value)).join('、')}</dd></div>}
          <div><dt>掲載総件数</dt><dd>開始時 {countLabel(run.reportedTotalAtStart)} ／ 終了時 {countLabel(run.reportedTotalAtEnd)}</dd></div>
        </dl>}
        <p>掲載総件数の増減は、新規観測アカウント数ではありません。走査中に掲載順位や件数が変わるため、全対象ページを訪問した場合も単一時点の名簿とは扱いません。</p>
        <p>基準作成後に、今回取得したCFN IDを過去すべての観測IDと比較し、初めて観測したIDを1アカウントとして数えます。途中で見つけたIDは元の観測回に保持し、再開時に重ねて数えません。</p>
        <p>初観測は初プレイ日を意味しません。既存プレイヤーが初めてランキングに掲載された場合や別アカウントも含みます。実際の新規プレイヤー人数や過去の参入人数は、この記録から確定できません。</p>
        <p>未取得・取得失敗・欠測・基準準備と、取得後に確認した0件を区別します。期間条件はJSTの日付で、取得開始から終了までの区間が重なる観測回を表示します。</p>
        <dl className="player-observation-details player-observation-source">
          <div><dt>出典</dt><dd><a href={dataset.source.url} target="_blank" rel="noreferrer">{dataset.source.title}<span className="win-rates-visually-hidden">（新しいタブ）</span></a></dd></div>
          <div><dt>取得条件</dt><dd>{targetLabel}</dd></div>
          <div><dt>対象</dt><dd>{dataset.source.population}</dd></div>
          <div><dt>指標</dt><dd>{dataset.source.metric}</dd></div>
          <div><dt>集計単位</dt><dd>CFNアカウント</dd></div>
          <div><dt>基準</dt><dd>{dataset.baseline.status === 'ready' ? '作成済み' : '準備中'}{dataset.baseline.completedAt && <> · <RecordedTime value={dataset.baseline.completedAt} /></>}</dd></div>
          <div><dt>データ生成日時</dt><dd><RecordedTime value={dataset.generatedAt} /></dd></div>
          <div><dt>観測系列</dt><dd>{dataset.seriesId}</dd></div>
          <div><dt>データ形式・定義</dt><dd>Version {dataset.schemaVersion} ／ 定義 Version {dataset.definitionVersion}</dd></div>
        </dl>
        {dataset.source.notes.length > 0 && <ul>{dataset.source.notes.map((note, index) => <li key={`${index}-${note}`}>{note}</li>)}</ul>}
      </div>
    </details>
}

export function NewAccountObservationPage() {
  const [loadState, setLoadState] = useState<LoadState>({ status: 'loading' })
  const [version, setVersion] = useState(0)
  const [selection, setSelection] = useState<PlayerObservationSelection | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  useEffect(() => {
    let current = true
    setLoadState({ status: 'loading' })
    void loadPlayerObservations().then(dataset => {
      if (!current) return
      setSelection(initialPlayerObservationSelection(dataset))
      setSelectedId(null)
      setLoadState({ status: 'ready', dataset })
    }).catch(() => { if (current) setLoadState({ status: 'error' }) })
    return () => { current = false }
  }, [version])

  const dataset = loadState.status === 'ready' ? loadState.dataset : null
  const runs = useMemo(() => dataset && selection ? filterPlayerObservationRuns(dataset, selection).reverse() : [], [dataset, selection])
  const selectedRun = runs.find(run => run.id === selectedId) ?? runs[0] ?? null
  const retry = () => {
    clearPlayerObservationRequests()
    setLoadState({ status: 'loading' })
    setVersion(value => value + 1)
  }

  if (loadState.status === 'loading') return <DataLoadState loading message="観測記録を読み込み中…" />
  if (loadState.status === 'error' || !dataset || !selection) return <DataLoadState message="観測記録を読み込めませんでした。" onRetry={retry} />

  return <section className="player-observation-page" aria-label="新規参入観測">
    <StatisticsPanel title="条件選択" headerContent={<span className="monthly-statistics-panel-summary">CFNアカウント単位 · JST</span>}>
      <PlayerObservationFilters dataset={dataset} selection={selection} onChange={setSelection} />
      <p className="player-observation-target">{targetLabel}</p>
    </StatisticsPanel>

    <StatisticsPanel title="新規観測アカウント数" headerContent={<span className="monthly-statistics-panel-summary">{integerFormat.format(runs.length)} ／ {integerFormat.format(dataset.runs.length)} 回表示</span>}>
      <div className="player-observation-results">
        <p className="player-observation-summary" role="status" aria-live="polite">{dataset.baseline.status === 'ready'
          ? <>基準作成済み{dataset.baseline.completedAt && <> · <RecordedTime value={dataset.baseline.completedAt} /></>}</>
          : '基準未作成 · 新規数は算出前'}</p>
        {dataset.runs.length === 0 ? <p className="player-observation-message" role="status">観測記録はまだ登録されていません。新規数は未取得です。</p>
          : runs.length === 0 ? <p className="player-observation-message" role="status">条件に一致する観測回がありません。期間または取得状態を変更してください。</p>
            : <PlayerObservationTable runs={runs} selectedId={selectedRun?.id ?? null} onSelect={setSelectedId} />}
        <p className="player-observation-note">初めて観測したCFN IDの件数です。実際の新規プレイヤー人数とは一致しません。観測回を選ぶと取得範囲と算出状態を確認できます。</p>
      </div>
    </StatisticsPanel>

    <StatisticsPanel title="選択した観測回" headerContent={selectedRun && <span className="monthly-statistics-panel-summary">{playerObservationRunStatusLabel(selectedRun)}</span>}>
      {selectedRun ? <RunDetails dataset={dataset} run={selectedRun} />
        : <div className="player-observation-details-content">
          <p className="player-observation-note player-observation-empty-detail">{dataset.runs.length === 0 ? '観測記録が登録されると、取得詳細を確認できます。' : '表示する観測回がありません。'}</p>
          <ObservationEvidence dataset={dataset} />
        </div>}
    </StatisticsPanel>
  </section>
}
