import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { loadCharacterManifest } from '../lib/characters'
import { filterCharacterReleases, loadCharacterReleaseCatalog } from '../lib/characterReleases'
import { timestampLabel } from '../lib/dateTime'
import { characterHash } from '../lib/routes'
import type { CharacterManifest } from '../types/characters'
import type { CharacterReleaseCatalog, CharacterReleaseFilters, CharacterReleaseOrder } from '../types/characterReleases'
import type { CharacterReleaseTimelineDirection } from '../types/characterReleaseTimeline'
import { CharacterReleaseTimeline } from './CharacterReleaseTimeline'
import { DataLoadState } from './DataLoadState'
import { StatisticsPanel } from './StatisticsPanel'
import '../win-rates.css'
import '../control-type-ratio.css'
import '../table.css'
import '../character-releases.css'

type BootstrapState = { status: 'loading' } | { status: 'error' }
  | { status: 'ready'; manifest: CharacterManifest; catalog: CharacterReleaseCatalog }

export function CharacterReleasesPage() {
  const [bootstrap, setBootstrap] = useState<BootstrapState>({ status: 'loading' })
  const [version, setVersion] = useState(0)
  const [filters, setFilters] = useState<CharacterReleaseFilters>({ characterId: 'all', kind: 'all' })
  const [order, setOrder] = useState<CharacterReleaseOrder>('desc')
  const [timelineDirection, setTimelineDirection] = useState<CharacterReleaseTimelineDirection>('horizontal')
  const timelineId = useId()
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let current = true
    setBootstrap({ status: 'loading' })
    void loadCharacterManifest().then(async manifest => {
      const catalog = await loadCharacterReleaseCatalog(manifest)
      if (current) setBootstrap({ status: 'ready', manifest, catalog })
    }).catch(() => { if (current) setBootstrap({ status: 'error' }) })
    return () => { current = false }
  }, [version])

  const rows = useMemo(() => bootstrap.status === 'ready'
    ? filterCharacterReleases(bootstrap.catalog, bootstrap.manifest, filters, order) : [], [bootstrap, filters, order])

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = 0
      scrollRef.current.scrollLeft = 0
    }
  }, [filters, order])

  if (bootstrap.status === 'loading') return <DataLoadState loading message="キャラ実装日を読み込み中…" />
  if (bootstrap.status === 'error') return <DataLoadState message="キャラ実装日を読み込めませんでした。" onRetry={() => setVersion(value => value + 1)} />

  const { manifest, catalog } = bootstrap
  const characterName = filters.characterId === 'all' ? '全キャラ' : manifest.characters.find(character => character.id === filters.characterId)?.name ?? filters.characterId
  const kindLabel = filters.kind === 'all' ? '' : filters.kind === 'initial' ? '初期キャラ' : '追加キャラ'
  const unverifiedCount = rows.filter(row => row.status === 'unverified').length
  const scheduledCount = rows.filter(row => row.status === 'scheduled').length

  return <section className="character-releases-page" aria-label="キャラ実装日">
    <StatisticsPanel title="条件選択" headerContent={<span className="monthly-statistics-panel-summary">{characterName}{kindLabel && ` · ${kindLabel}`}</span>}>
      <div className="win-rates-filters control-ratio-filters character-release-filters">
        <label><span>キャラクター</span><select aria-label="キャラクター" value={filters.characterId}
          onChange={event => setFilters({ ...filters, characterId: event.target.value })}>
          <option value="all">すべて</option>{manifest.characters.map(character => <option key={character.id} value={character.id}>{character.name}</option>)}
        </select></label>
        <label><span>区分</span><select aria-label="区分" value={filters.kind}
          onChange={event => setFilters({ ...filters, kind: event.target.value as CharacterReleaseFilters['kind'] })}>
          <option value="all">すべて</option><option value="initial">初期キャラ</option><option value="additional">追加キャラ</option>
        </select></label>
        <label><span>並び順</span><select aria-label="並び順" value={order}
          onChange={event => setOrder(event.target.value as CharacterReleaseOrder)}>
          <option value="desc">実装日の新しい順</option><option value="asc">実装日の古い順</option>
        </select></label>
      </div>
    </StatisticsPanel>

    <StatisticsPanel title="タイムライン" headerContent={<div className="win-rates-view-selector" role="group" aria-label="タイムラインの表示方向">
      {([['vertical', '縦向き'], ['horizontal', '横向き']] as const).map(([direction, label]) => <button key={direction}
        type="button" className="win-rates-button" aria-pressed={timelineDirection === direction} aria-controls={timelineId}
        onClick={() => setTimelineDirection(direction)}>{label}</button>)}
    </div>}>
      <CharacterReleaseTimeline id={timelineId} rows={rows} direction={timelineDirection} />
    </StatisticsPanel>

    <StatisticsPanel title="テーブル" headerContent={<span className="monthly-statistics-panel-summary" aria-live="polite">
      {rows.length}キャラ{scheduledCount > 0 && ` · 配信予定 ${scheduledCount}キャラ`}{unverifiedCount > 0 && ` · 実装日未確認 ${unverifiedCount}キャラ`}
    </span>}>
      <div className="character-release-table-content">
        {rows.length === 0 ? <p className="character-release-state" role="status">この条件に一致するキャラはいません。</p>
          : <div ref={scrollRef} className="data-table-scroll character-release-scroll" role="region" tabIndex={0} aria-label="キャラ実装日一覧・スクロール領域">
            <table className="data-table character-release-table">
              <caption className="win-rates-visually-hidden">キャラクターごとの家庭用・PC版の実装日と公式出典</caption>
              <colgroup><col className="character-release-date-column" /><col /><col className="character-release-kind-column" /><col className="character-release-source-column" /></colgroup>
              <thead><tr><th scope="col" aria-sort={order === 'asc' ? 'ascending' : 'descending'}>実装日</th><th scope="col">キャラクター</th><th scope="col">区分</th><th scope="col">公式</th></tr></thead>
              <tbody>{rows.map(row => <tr key={row.characterId}>
                <td className="character-release-date">{row.releaseDate ? <><time dateTime={row.releaseDate}>{row.releaseDate.replaceAll('-', '/')}</time>{row.status === 'scheduled' && '（配信予定）'}</> : '未確認'}</td>
                <th scope="row"><a href={characterHash(row.characterId)} aria-label={`${row.character.name}のキャラ情報を開く`}>{row.character.name}</a></th>
                <td>{row.kind === 'initial' ? '初期' : '追加'}</td>
                <td>{row.source ? <a href={row.source.url} target="_blank" rel="noreferrer" aria-label={`${row.character.name}の公式告知（新しいタブ）`}>公式告知</a> : '—'}</td>
              </tr>)}</tbody>
            </table>
          </div>}
        <details className="win-rates-details"><summary>日付の定義・出典</summary><div className="win-rates-details-content character-release-help">
          <p>家庭用・PC版で対戦キャラクターとして初めて使用可能になった日本の日付です。初期キャラは発売日、追加キャラは配信開始日を表示します。アーケード版や後から発売された機種の配信日、告知記事の公開日とは区別します。</p>
          <p>実装日を公式情報で確認できない場合は「未確認」と表示します。配信予定日は「配信予定」と表示し、日付が過ぎても自動で実装済みには変更しません。</p>
          <p>各行の「公式告知」から日付の根拠を確認できます。同日実装のキャラは既存のキャラ一覧順に並べます。</p>
          <dl className="win-rates-source">
            <div><dt>確認日時</dt><dd><time dateTime={catalog.checkedAt}>{timestampLabel(catalog.checkedAt)}</time></dd></div>
            <div><dt>生成日時</dt><dd><time dateTime={catalog.generatedAt}>{timestampLabel(catalog.generatedAt)}</time></dd></div>
          </dl>
        </div></details>
      </div>
    </StatisticsPanel>
  </section>
}
