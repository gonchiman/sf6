import { useEffect, useMemo, useState } from 'react'
import { japaneseCharacterNames } from '../lib/characterNames'
import { loadCharacterManifest } from '../lib/characters'
import { timestampLabel } from '../lib/dateTime'
import { legendPlayersFeed } from '../lib/legendPlayersFeed'
import { usePublishedData } from '../lib/usePublishedData'
import type { LegendPlayersDataset } from '../types/legendPlayers'
import { DataLoadState } from './DataLoadState'
import { LegendPlayersTable } from './LegendPlayersTable'
import { StatisticsPanel } from './StatisticsPanel'
import '../win-rates.css'
import '../legend-players.css'

type DatasetState = { key: string; version: number } & (
  { status: 'loading' | 'error' } | { status: 'ready'; dataset: LegendPlayersDataset }
)
const integerFormat = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 0 })

export function LegendPlayersPage() {
  const { status, publication, selectedId, setSelectedId, refreshError, retry } = usePublishedData(legendPlayersFeed)
  const [loaded, setLoaded] = useState<DatasetState | null>(null)
  const [datasetVersion, setDatasetVersion] = useState(0)
  const [names, setNames] = useState<ReadonlyMap<string, string> | null>(null)
  const [namesError, setNamesError] = useState(false)
  const [namesVersion, setNamesVersion] = useState(0)

  useEffect(() => {
    let active = true
    setNamesError(false)
    void loadCharacterManifest().then(manifest => {
      if (active) setNames(japaneseCharacterNames(manifest.characters))
    }).catch(() => { if (active) setNamesError(true) })
    return () => { active = false }
  }, [namesVersion])

  const manifest = publication?.manifest ?? null
  const descriptors = useMemo(() => manifest ? [...manifest.datasets]
    .sort((a, b) => Date.parse(b.captureEndedAt) - Date.parse(a.captureEndedAt) || a.id.localeCompare(b.id)) : [], [manifest])
  const descriptor = descriptors.find(item => item.id === selectedId) ?? null
  const requestKey = publication && descriptor ? JSON.stringify([publication.baseUrl, manifest!.generatedAt, descriptor]) : null

  useEffect(() => {
    if (!publication || !descriptor || !requestKey) return
    let active = true
    const key = requestKey
    setLoaded({ key, version: datasetVersion, status: 'loading' })
    void legendPlayersFeed.loadDataset(publication, descriptor).then(dataset => {
      if (active) setLoaded({ key, version: datasetVersion, status: 'ready', dataset })
    }).catch(() => { if (active) setLoaded({ key, version: datasetVersion, status: 'error' }) })
    return () => { active = false }
  }, [publication, descriptor, requestKey, datasetVersion])

  const current = loaded?.key === requestKey && loaded.version === datasetVersion ? loaded : null
  const dataset = current?.status === 'ready' ? current.dataset : null
  const loadingDataset = Boolean(descriptor && (!current || current.status === 'loading'))
  const availability = manifest?.availability
  const availabilityLabel = availability?.status === 'collection-failed' ? '取得失敗'
    : availability?.status === 'verification-pending' ? '検証待ち' : '未取得'
  const emptyMessage = !descriptor ? availabilityLabel
    : current?.status === 'error' ? '読込失敗' : loadingDataset ? '読み込み中…' : '0件（取得確認済み）'

  if (status === 'loading') return <DataLoadState loading message="取得記録を読み込み中…" />
  if (!manifest) return <DataLoadState message="取得記録の読込失敗" onRetry={retry} />

  return <section className="legend-players-page" aria-label="レジェンド帯分析2">
    <div className="legend-players-toolbar">
      {descriptors.length > 0 && <label className="legend-players-capture-select"><span>取得日</span>
        <select value={selectedId ?? ''} onChange={event => setSelectedId(event.target.value)}>
          {descriptors.map(item => <option key={item.id} value={item.id}>{item.actId.replace(/^act-/, 'Act ')} · {timestampLabel(item.captureEndedAt)}</option>)}
        </select>
      </label>}
      <a href={manifest.source.url} target="_blank" rel="noreferrer">出典：Buckler</a>
      <span>アカウント×キャラ</span>
      {publication?.source === 'bundled' && descriptors.length > 0 && <span>同梱データ</span>}
    </div>

    {dataset && <dl className="legend-players-capture">
      <div><dt>取得区間</dt><dd><time dateTime={dataset.captureStartedAt}>{timestampLabel(dataset.captureStartedAt)}</time>
        {' 〜 '}<time dateTime={dataset.captureEndedAt}>{timestampLabel(dataset.captureEndedAt)}</time></dd></div>
      <div><dt>対象</dt><dd>{dataset.act.label} · {dataset.conditions.region === 'all' ? '全地域' : dataset.conditions.region}
        {' · '}{dataset.conditions.platform === 'all' ? '全プラットフォーム' : dataset.conditions.platform}</dd></div>
    </dl>}

    {(refreshError || availability?.status === 'collection-failed' || availability?.status === 'verification-pending') && <div className="legend-players-status" role="status">
      <span>{refreshError ? '更新確認失敗' : availabilityLabel}</span>
      {availability && <time dateTime={availability.checkedAt}>{timestampLabel(availability.checkedAt)}</time>}
      <button className="win-rates-button" type="button" onClick={retry}>更新を再確認</button>
    </div>}
    {dataset && namesError && <div className="legend-players-status" role="status">
      <span>キャラ名未取得（ID表示）</span>
      <button className="win-rates-button" type="button" onClick={() => setNamesVersion(value => value + 1)}>キャラ名を再読み込み</button>
    </div>}

    <StatisticsPanel title="プレイヤー一覧" headerContent={dataset && <span className="monthly-statistics-panel-summary">{integerFormat.format(dataset.totalCount)} 件</span>}>
      <LegendPlayersTable rows={dataset?.players ?? []} names={names} emptyMessage={emptyMessage} loading={loadingDataset} />
      {current?.status === 'error' && <div className="legend-players-status" role="alert">
        <button className="win-rates-button" type="button" onClick={() => setDatasetVersion(value => value + 1)}>一覧を再読み込み</button>
      </div>}
    </StatisticsPanel>
  </section>
}
