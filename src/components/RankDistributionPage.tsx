import { useEffect, useMemo, useState } from 'react'
import { createRankDistributionRows, loadRankDistributionDataset, loadRankDistributionManifest, RANK_DISTRIBUTION_GROUPS } from '../lib/rankDistribution'
import { timestampLabel } from '../lib/dateTime'
import { leagueLabel } from '../lib/winRateConditions'
import type { RankDistributionDataset, RankDistributionManifest } from '../types/rankDistribution'
import { DataLoadState } from './DataLoadState'
import { RankDistributionTable } from './RankDistributionTable'
import { StatisticsPanel } from './StatisticsPanel'
import '../win-rates.css'
import '../rank-distribution.css'

type BootstrapState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; manifest: RankDistributionManifest }

type DatasetState =
  | { key: string; status: 'loading' }
  | { key: string; status: 'error' }
  | { key: string; status: 'ready'; dataset: RankDistributionDataset }

const integerFormat = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 0 })
const captureDateFormat = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', dateStyle: 'medium' })
const captureTimeFormat = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', timeStyle: 'short' })
const displayLabel = (group: string) => group === 'ALL' ? 'ランク帯ごと' : `${leagueLabel(group)}の★別`

function CapturePeriod({ start, end }: { start: string; end: string }) {
  if (start === end) return <time dateTime={start}>{timestampLabel(start)}</time>
  const sameDate = captureDateFormat.format(new Date(start)) === captureDateFormat.format(new Date(end))
  return <><time dateTime={start}>{timestampLabel(start).replace(/ JST$/, '')}</time>
    〜<time dateTime={end}>{sameDate ? `${captureTimeFormat.format(new Date(end))} JST` : timestampLabel(end)}</time></>
}

export function RankDistributionPage() {
  const [bootstrap, setBootstrap] = useState<BootstrapState>({ status: 'loading' })
  const [bootstrapVersion, setBootstrapVersion] = useState(0)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [group, setGroup] = useState('ALL')
  const [datasetState, setDatasetState] = useState<DatasetState | null>(null)
  const [datasetVersion, setDatasetVersion] = useState(0)

  useEffect(() => {
    let current = true
    setBootstrap({ status: 'loading' })
    void loadRankDistributionManifest().then(manifest => {
      if (!current) return
      const latest = [...manifest.datasets].sort((left, right) => Date.parse(right.captureEndedAt) - Date.parse(left.captureEndedAt))[0]
      setSelectedId(previous => manifest.datasets.some(descriptor => descriptor.id === previous) ? previous : latest?.id ?? null)
      setBootstrap({ status: 'ready', manifest })
    }).catch(() => { if (current) setBootstrap({ status: 'error' }) })
    return () => { current = false }
  }, [bootstrapVersion])

  const manifest = bootstrap.status === 'ready' ? bootstrap.manifest : null
  const descriptors = useMemo(() => manifest ? [...manifest.datasets]
    .sort((left, right) => Date.parse(right.captureEndedAt) - Date.parse(left.captureEndedAt)) : [], [manifest])
  const descriptor = descriptors.find(item => item.id === selectedId) ?? null
  const requestKey = manifest && descriptor ? JSON.stringify([manifest.generatedAt, descriptor]) : null

  useEffect(() => {
    if (!manifest || !descriptor || !requestKey) return
    let current = true
    const key = requestKey
    setDatasetState({ key, status: 'loading' })
    void loadRankDistributionDataset(descriptor, manifest.generatedAt).then(dataset => {
      if (current) setDatasetState({ key, status: 'ready', dataset })
    }).catch(() => { if (current) setDatasetState({ key, status: 'error' }) })
    return () => { current = false }
  }, [manifest, descriptor, requestKey, datasetVersion])

  // A new capture must never show the previous capture's counts while loading.
  const currentState = datasetState?.key === requestKey ? datasetState : null
  const dataset = currentState?.status === 'ready' ? currentState.dataset : null
  const estimated = dataset?.method === 'boundary-search-estimate'
  const observation = estimated ? dataset.observation : undefined
  const rows = useMemo(() => dataset ? createRankDistributionRows(dataset, group) : [], [dataset, group])
  const tableLabel = group === 'ALL' ? 'ランク帯ごとの分布' : `${leagueLabel(group)}の★別分布`

  if (bootstrap.status === 'loading') return <DataLoadState loading message="ランク分布の取得日を読み込み中…" />
  if (bootstrap.status === 'error' || !manifest) return <DataLoadState message="ランク分布の取得日を読み込めませんでした。"
    onRetry={() => setBootstrapVersion(version => version + 1)} />

  const availability = manifest.availability
  const emptyLabel = availability?.status === 'collection-failed' ? '取得失敗'
    : availability?.status === 'verification-pending' ? '検証待ち' : '未取得'

  return <section className="rank-distribution-page" aria-label="ランク分布">
    <p className="rank-distribution-scope">最大LPの総合一覧 · 全地域 · 全プラットフォーム</p>
    <StatisticsPanel title="条件選択">
      <div className="win-rates-filters rank-distribution-filters">
        {descriptors.length > 1 && <label><span>取得日</span><select aria-label="取得日" value={selectedId ?? ''}
          onChange={event => setSelectedId(event.target.value)}>
          {descriptors.map(item => <option key={item.id} value={item.id}>{timestampLabel(item.captureEndedAt)}</option>)}
        </select></label>}
        <label><span>表示区分</span><select aria-label="表示区分" value={group} onChange={event => setGroup(event.target.value)}>
          <option value="ALL">ランク帯ごと</option>
          {RANK_DISTRIBUTION_GROUPS.filter(value => value !== 'MASTER').map(value => <option key={value} value={value}>{displayLabel(value)}</option>)}
        </select></label>
      </div>
    </StatisticsPanel>

    <StatisticsPanel title={tableLabel} headerContent={dataset && <span className="rank-distribution-total">
      掲載総数 <strong>{integerFormat.format(dataset.totalCount)}</strong> 件
    </span>}>
      <div className="rank-distribution-content">
        {availability && <p className="rank-distribution-state" role="status">{emptyLabel}（確認日時：<time dateTime={availability.checkedAt}>{timestampLabel(availability.checkedAt)}</time>）：{availability.message}
          <br />取得状況は、この確認日時に保存した記録です。
        </p>}
        {!descriptor ? !availability && <p className="rank-distribution-state" role="status">未取得：ランク分布のデータはまだ登録されていません。</p>
          : !currentState || currentState.status === 'loading' ? <DataLoadState loading message="選択した取得日のランク分布を読み込み中…" />
            : currentState.status === 'error' ? <DataLoadState message="選択した取得日のランク分布を読み込めませんでした。"
              onRetry={() => setDatasetVersion(version => version + 1)} /> : null}
        {dataset && <>
          <div className="rank-distribution-period">取得期間 <CapturePeriod start={dataset.captureStartedAt} end={dataset.captureEndedAt} /></div>
          <p className="rank-distribution-note">{estimated ? '数値は取得期間中の概数です。' : '掲載ファイターアカウントの分布です。'}実人数・アクティブ人口ではありません。</p>
          {dataset.totalCount === 0 && <p className="rank-distribution-state" role="status">掲載アカウント総数は0件です。件数は0、割合と累積割合は分母が0のため「—」で表示します。</p>}
          <RankDistributionTable rows={rows} label={tableLabel} estimated={estimated} />
          <p className="rank-distribution-note">割合は★別でも全体基準。「このランク以上」は上位ランクを含む累積割合です。</p>
        </>}
        <p className="rank-distribution-note">出典：<a href={manifest.source.url} target="_blank" rel="noreferrer">{manifest.source.title}<span className="win-rates-visually-hidden">（新しいタブ）</span></a></p>
        <details className="win-rates-details">
          <summary>集計方法・取得情報</summary>
          <div className="win-rates-details-content rank-distribution-evidence">
            <p>{estimated ? '最大LPの総合一覧で各ランク以上になる境界位置を観測し、隣り合う境界の差からランクごとの掲載アカウント数の概数を求めます。' : '最大LPの総合一覧の各ファイターアカウントを、取得時の最大LPに対応する最高ランクへ1回だけ分類します。'}MASTERは1つのランク帯として扱います。</p>
            <p>全地域・全プラットフォームの掲載アカウントが対象です。同じ人が複数のプラットフォームやアカウントを使っていても、実人数への統合は行いません。最終プレイ日時でアクティブ人口を絞り込んだ値でもありません。</p>
            <p>取得には開始から終了までの時間幅があります。その間にLPやランキングが変わる可能性があるため、同一瞬間の分布とは扱いません。取得日と勝率統計の対象月は別の条件です。</p>
            <p>{estimated ? '割合と累積割合の分母は取得終了時の掲載アカウント総数です。' : '割合と累積割合の分母は掲載アカウント全体です。'}★別表示でも、選んだランク内だけで100%に換算しません。「このランク以上」は、その行のランクとすべての上位ランクを合わせた累積割合です。</p>
            {estimated && <p>総数の開始・終了の差や観測範囲は、各ランクの誤差上限を表しません。</p>}
            <p>{estimated ? '概数は全35境界の観測と再確認、件数の整合性、取得条件を確認したデータです。個別アカウントの全件照合を行った値ではありません。' : '全ランクの件数と総数、取得条件、検証済みの取得記録を確認したデータを表示します。'}欠けたランクや確認できない値は0件で補完しません。未取得・検証待ち・取得失敗・読込失敗と、確認済みの0件を区別します。</p>
            <dl className="win-rates-source">
              <div><dt>一覧生成日時</dt><dd><time dateTime={manifest.generatedAt}>{timestampLabel(manifest.generatedAt)}</time></dd></div>
              <div><dt>データ形式</dt><dd>Version {manifest.schemaVersion}</dd></div>
              {availability && <div><dt>取得状況の確認日時</dt><dd><time dateTime={availability.checkedAt}>{timestampLabel(availability.checkedAt)}</time></dd></div>}
              {dataset && <>
                <div><dt>取得期間</dt><dd><CapturePeriod start={dataset.captureStartedAt} end={dataset.captureEndedAt} /></dd></div>
                <div><dt>{estimated ? '掲載総数（取得終了時）' : '掲載総数'}</dt><dd>{integerFormat.format(dataset.totalCount)} 件</dd></div>
                {observation && <>
                  <div><dt>開始時の総数</dt><dd>{integerFormat.format(observation.totalAtStart)} 件</dd></div>
                  <div><dt>観測した総数の範囲</dt><dd>{integerFormat.format(observation.minTotal)}〜{integerFormat.format(observation.maxTotal)} 件</dd></div>
                </>}
                <div><dt>データ生成日時</dt><dd><time dateTime={dataset.generatedAt}>{timestampLabel(dataset.generatedAt)}</time></dd></div>
                <div><dt>対象</dt><dd>{dataset.source.population}</dd></div>
                <div><dt>指標</dt><dd>{dataset.source.metric}</dd></div>
                <div><dt>集計単位</dt><dd>ファイターアカウント</dd></div>
                <div><dt>取得方法</dt><dd>{estimated ? '全ランク境界のページと行の位置から概数を集計' : 'ランク境界のページと行の位置を検証して集計'}</dd></div>
                <div><dt>検証状況</dt><dd>{estimated ? '全35境界を観測・再確認した概数' : '全掲載アカウントを対象とする取得記録を検証済み'}</dd></div>
              </>}
            </dl>
            {dataset && [...dataset.source.notes, ...dataset.validation.notes].length > 0 && <ul>
              {[...new Set([...dataset.source.notes, ...dataset.validation.notes])].map(note => <li key={note}>{note}</li>)}
            </ul>}
          </div>
        </details>
      </div>
    </StatisticsPanel>
  </section>
}
