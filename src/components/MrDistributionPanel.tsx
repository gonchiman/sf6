import { useEffect, useMemo, useState } from 'react'
import { timestampLabel } from '../lib/dateTime'
import { createMrDistributionRows, loadMrDistributionDataset, loadMrDistributionManifest } from '../lib/mrDistribution'
import type { RankDistributionChartMetric } from '../lib/rankDistributionChart'
import type { MrDistributionDataset, MrDistributionManifest } from '../types/mrDistribution'
import { DataLoadState } from './DataLoadState'
import { DistributionCapturePeriod } from './DistributionCapturePeriod'
import { RankDistributionChart } from './RankDistributionChart'
import { RankDistributionTable } from './RankDistributionTable'
import { StatisticsPanel } from './StatisticsPanel'

type BootstrapState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; manifest: MrDistributionManifest }

type DatasetState =
  | { key: string; status: 'loading' }
  | { key: string; status: 'error' }
  | { key: string; status: 'ready'; dataset: MrDistributionDataset }

const integerFormat = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 0 })
const denominatorDescription = '割合と累積割合の分母は、取得終了時のMRランキング掲載総数です。LP側のMASTER総数とは異なる対象です。'

export function MrDistributionPanel() {
  const [bootstrap, setBootstrap] = useState<BootstrapState>({ status: 'loading' })
  const [bootstrapVersion, setBootstrapVersion] = useState(0)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [chartMetric, setChartMetric] = useState<RankDistributionChartMetric>('percent')
  const [datasetState, setDatasetState] = useState<DatasetState | null>(null)
  const [datasetVersion, setDatasetVersion] = useState(0)

  useEffect(() => {
    let current = true
    setBootstrap({ status: 'loading' })
    void loadMrDistributionManifest().then(manifest => {
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
    void loadMrDistributionDataset(descriptor, manifest.generatedAt).then(dataset => {
      if (current) setDatasetState({ key, status: 'ready', dataset })
    }).catch(() => { if (current) setDatasetState({ key, status: 'error' }) })
    return () => { current = false }
  }, [manifest, descriptor, requestKey, datasetVersion])

  // Keep the requested capture's population separate from any previous date or the LP panel.
  const currentState = datasetState?.key === requestKey ? datasetState : null
  const dataset = currentState?.status === 'ready' ? currentState.dataset : null
  const rows = useMemo(() => dataset ? createMrDistributionRows(dataset) : [], [dataset])

  if (bootstrap.status === 'loading') return <DataLoadState loading message="MR分布の取得日を読み込み中…" />
  if (bootstrap.status === 'error' || !manifest) return <DataLoadState message="MR分布の取得日を読み込めませんでした。"
    onRetry={() => setBootstrapVersion(version => version + 1)} />

  const availability = manifest.availability
  const emptyLabel = availability?.status === 'collection-failed' ? '取得失敗'
    : availability?.status === 'verification-pending' ? '検証待ち' : '未取得'

  return <section className="rank-distribution-page" aria-label="MR帯の分布">
    <p className="rank-distribution-scope">今Act（取得時）の最大MR · 全地域 · 全プラットフォーム</p>
    <StatisticsPanel title="条件選択">
      <div className="win-rates-filters rank-distribution-filters">
        <label><span>取得日</span><select aria-label="MR分布の取得日" value={selectedId ?? ''} disabled={descriptors.length < 2}
          onChange={event => setSelectedId(event.target.value)}>
          {descriptors.length === 0 && <option value="">未取得</option>}
          {descriptors.map(item => <option key={item.id} value={item.id}>{timestampLabel(item.captureEndedAt)}</option>)}
        </select></label>
      </div>
      <p className="rank-distribution-note mr-distribution-condition-note">MRランキングの掲載アカウントが対象です。LP側のMASTER全体の内訳ではありません。</p>
    </StatisticsPanel>

    {availability && <p className="rank-distribution-state" role="status">{emptyLabel}（確認日時：<time dateTime={availability.checkedAt}>{timestampLabel(availability.checkedAt)}</time>）：{availability.message}
      <br />取得状況は、この確認日時に保存した記録です。
    </p>}

    {dataset && <StatisticsPanel title="MR帯ごとのグラフ" headerContent={<span className="rank-distribution-total">
      MR掲載総数 <strong>{integerFormat.format(dataset.totalCount)}</strong> 件
    </span>}>
      <div className="rank-distribution-content">
        <div className="rank-distribution-period">取得期間 <DistributionCapturePeriod start={dataset.captureStartedAt} end={dataset.captureEndedAt} /></div>
        <p className="rank-distribution-note">数値は取得期間中の概数です。実人数・アクティブ人口ではありません。</p>
        {dataset.totalCount === 0 && <p className="rank-distribution-state" role="status">MRランキング掲載総数は0件です。件数は0、割合と累積割合は分母が0のため「—」で表示します。</p>}
        <div className="win-rates-filters rank-distribution-chart-controls">
          <label><span>棒の値</span><select aria-label="MRグラフの棒の値" value={chartMetric}
            onChange={event => setChartMetric(event.target.value as RankDistributionChartMetric)}>
            <option value="percent">MR一覧比（%）</option>
            <option value="count">アカウント数（件）</option>
          </select></label>
        </div>
        <RankDistributionChart rows={rows} metric={chartMetric} estimated label="MR分布" categoryLabel="MR帯"
          percentLabel="MR一覧比" denominatorDescription={denominatorDescription} compactCategories />
        <p className="rank-distribution-note">100MR刻みの全26区分を表示します。幅に応じて軸の区間名を間引きます。各区間の数値は棒のツールチップと下の表で確認できます。</p>
      </div>
    </StatisticsPanel>}

    <StatisticsPanel title="MR帯ごとの数値">
      <div className="rank-distribution-content">
        {!descriptor ? !availability && <p className="rank-distribution-state" role="status">未取得：MR分布のデータはまだ登録されていません。</p>
          : !currentState || currentState.status === 'loading' ? <DataLoadState loading message="選択した取得日のMR分布を読み込み中…" />
            : currentState.status === 'error' ? <DataLoadState message="選択した取得日のMR分布を読み込めませんでした。"
              onRetry={() => setDatasetVersion(version => version + 1)} /> : null}
        {dataset && <>
          <RankDistributionTable rows={rows} label="MR帯ごとの数値" estimated categoryLabel="MR区間" percentLabel="MR一覧比"
            cumulativeLabel="このMR以上" denominatorDescription={`件数・割合・累積割合は取得期間中の概数です。${denominatorDescription}`} />
          <p className="rank-distribution-note">「このMR以上」は、区間の下限以上のMRを合わせた累積割合です。</p>
        </>}
        <p className="rank-distribution-note">出典：<a href={manifest.source.url} target="_blank" rel="noreferrer">{manifest.source.title}<span className="win-rates-visually-hidden">（新しいタブ）</span></a></p>
        <details className="win-rates-details">
          <summary>集計方法・取得情報</summary>
          <div className="win-rates-details-content rank-distribution-evidence">
            <p>今Act（取得時）の最大MR一覧で100MRごとの境界位置を観測し、隣り合う境界の差から掲載アカウント数の概数を求めます。0〜99から2400〜2499までは100MR刻み、最後は2500以上です。</p>
            <p>MRランキング掲載者の分布です。LP側のMASTER全体と対象が一致することは確認しておらず、MASTER全体をこの割合で分割しません。実人数への統合や、最終プレイ日時でアクティブ人口を絞り込む処理も行いません。</p>
            <p>取得中にもMR・順位・掲載総数が変わるため、同一瞬間の分布とは扱いません。Actが切り替わると対象集団も変わります。取得日は勝率統計の対象月とは別の条件です。</p>
            <p>{denominatorDescription}総数の開始・終了の差や観測範囲は、各区間の誤差上限を表しません。</p>
            <p>全25境界の観測と再確認、先頭・末尾、件数と条件の整合性を確認したデータを表示します。未取得・検証待ち・取得失敗・読込失敗を、確認済みの0件と区別します。</p>
            <dl className="win-rates-source">
              <div><dt>一覧生成日時</dt><dd><time dateTime={manifest.generatedAt}>{timestampLabel(manifest.generatedAt)}</time></dd></div>
              <div><dt>データ形式</dt><dd>Version {manifest.schemaVersion}</dd></div>
              {availability && <div><dt>取得状況の確認日時</dt><dd><time dateTime={availability.checkedAt}>{timestampLabel(availability.checkedAt)}</time></dd></div>}
              {dataset && <>
                <div><dt>取得期間</dt><dd><DistributionCapturePeriod start={dataset.captureStartedAt} end={dataset.captureEndedAt} /></dd></div>
                <div><dt>MR掲載総数（取得終了時）</dt><dd>{integerFormat.format(dataset.totalCount)} 件</dd></div>
                <div><dt>開始時の総数</dt><dd>{integerFormat.format(dataset.observation.totalAtStart)} 件</dd></div>
                <div><dt>観測した総数の範囲</dt><dd>{integerFormat.format(dataset.observation.minTotal)}〜{integerFormat.format(dataset.observation.maxTotal)} 件</dd></div>
                <div><dt>データ生成日時</dt><dd><time dateTime={dataset.generatedAt}>{timestampLabel(dataset.generatedAt)}</time></dd></div>
                <div><dt>対象</dt><dd>{dataset.source.population}</dd></div>
                <div><dt>指標</dt><dd>{dataset.source.metric}</dd></div>
                <div><dt>集計単位</dt><dd>ファイターアカウント</dd></div>
                <div><dt>区分</dt><dd>100MR刻み（2500以上は合算）</dd></div>
                <div><dt>検証状況</dt><dd>全25境界を観測・再確認した概数</dd></div>
              </>}
            </dl>
            {dataset && <ul>{[...new Set([...dataset.source.notes, ...dataset.validation.notes])]
              .map(note => <li key={note}>{note}</li>)}</ul>}
          </div>
        </details>
      </div>
    </StatisticsPanel>
  </section>
}
