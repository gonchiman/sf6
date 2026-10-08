import { useEffect, useId, useMemo, useRef, useState, type RefObject } from 'react'
import {
  characterMoveCategories,
  filterCharacterMoves,
  loadCharacterDataset,
  loadCharacterManifest,
  sortCharacterMoves,
} from '../lib/characters'
import type { CharacterDataset, CharacterManifest, CharacterMove, CharacterNumericSortKey } from '../types/characters'
import { DataLoadState as LoadState } from './DataLoadState'
import '../table.css'
import '../win-rates.css'
import '../characters.css'

type CharactersPageProps = {
  characterId: string | null
  onCharacterChange: (id: string) => void
}

type DatasetState =
  | { id: string; status: 'loading' }
  | { id: string; status: 'ready'; data: CharacterDataset }
  | { id: string; status: 'error' }

type MoveSort = { key: CharacterNumericSortKey; direction: 'asc' | 'desc' } | null

export function CharactersPage({ characterId, onCharacterChange }: CharactersPageProps) {
  const [manifest, setManifest] = useState<CharacterManifest | null>(null)
  const [manifestLoading, setManifestLoading] = useState(true)
  const [manifestError, setManifestError] = useState(false)
  const [manifestVersion, setManifestVersion] = useState(0)
  const [datasetVersion, setDatasetVersion] = useState(0)
  const [datasetState, setDatasetState] = useState<DatasetState | null>(null)

  useEffect(() => {
    let current = true
    setManifestLoading(true)
    setManifestError(false)
    void loadCharacterManifest().then((next) => {
      if (current) setManifest(next)
    }).catch(() => {
      if (current) setManifestError(true)
    }).finally(() => {
      if (current) setManifestLoading(false)
    })
    return () => { current = false }
  }, [manifestVersion])

  const initialCharacter = manifest?.characters.find((character) => character.id === 'ryu') ?? manifest?.characters[0]
  const selected = characterId === null ? initialCharacter : manifest?.characters.find((character) => character.id === characterId)

  useEffect(() => {
    if (!selected || manifestLoading || manifestError || !manifest) return
    let current = true
    const requested = selected
    setDatasetState({ id: requested.id, status: 'loading' })
    void loadCharacterDataset(requested, manifest.generatedAt).then((data) => {
      if (!current) return
      if (data.id !== requested.id) throw new Error('Character data does not match the selection')
      setDatasetState({ id: requested.id, status: 'ready', data })
    }).catch(() => {
      if (current) setDatasetState({ id: requested.id, status: 'error' })
    })
    return () => { current = false }
  }, [selected, manifest, manifestLoading, manifestError, datasetVersion])

  if (manifestLoading) return <LoadState loading message="キャラ一覧を読み込み中…" />
  if (manifestError) return <LoadState message="キャラ一覧を読み込めませんでした。" onRetry={() => setManifestVersion((version) => version + 1)} />
  if (!manifest || manifest.characters.length === 0) return <LoadState message="表示できるキャラデータはまだ登録されていません。" />

  // Hide stale data immediately during selection changes, before the request effect runs.
  const currentState = selected && datasetState?.id === selected.id ? datasetState : null

  return <section className="characters-page" aria-label="キャラ情報">
    <div className="win-rates-filters character-picker">
      <label>
        <span>キャラクター</span>
        <select aria-label="キャラクター" value={selected?.id ?? ''} onChange={(event) => onCharacterChange(event.target.value)}>
          {!selected && <option value="" disabled>キャラが見つかりません</option>}
          {manifest.characters.map((character) => <option value={character.id} key={character.id}>{character.name}</option>)}
        </select>
      </label>
    </div>
    {!selected ? <LoadState message="指定されたキャラのデータは登録されていません。" />
      : currentState?.status === 'error' ? <LoadState message="キャラ情報を読み込めませんでした。" onRetry={() => setDatasetVersion((version) => version + 1)} />
        : currentState?.status === 'ready' ? <CharacterContent key={currentState.data.id} dataset={currentState.data} />
          : <LoadState loading message="キャラ情報を読み込み中…" />}
  </section>
}

function CharacterContent({ dataset }: { dataset: CharacterDataset }) {
  const contentId = useId()
  const [controlType, setControlType] = useState<'classic' | 'modern'>('classic')
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('ALL')
  const [extraColumns, setExtraColumns] = useState(false)
  const [sort, setSort] = useState<MoveSort>(null)
  const [selectedMoveId, setSelectedMoveId] = useState<string | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const detailTitleRef = useRef<HTMLHeadingElement>(null)
  const moveButtonRefs = useRef(new Map<string, HTMLButtonElement>())
  const controlMoves = useMemo(() => dataset.moves.filter((move) => move.controlType === controlType), [dataset.moves, controlType])
  const categories = useMemo(() => characterMoveCategories(controlMoves), [controlMoves])
  const visibleMoves = useMemo(() => sortCharacterMoves(filterCharacterMoves(controlMoves, { query, category }), sort), [controlMoves, query, category, sort])
  const selectedMove = controlMoves.find((move) => move.id === selectedMoveId)

  useEffect(() => {
    if (!selectedMoveId) return
    const frame = window.requestAnimationFrame(() => {
      const heading = detailTitleRef.current
      heading?.focus({ preventScroll: true })
      heading?.scrollIntoView({ block: 'start', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [selectedMoveId])

  const closeDetail = () => {
    const previous = selectedMoveId
    setSelectedMoveId(null)
    window.requestAnimationFrame(() => {
      const trigger = previous ? moveButtonRefs.current.get(previous) : undefined
      if (trigger?.isConnected) trigger.focus()
      else searchRef.current?.focus()
    })
  }

  const changeSort = (key: CharacterNumericSortKey) => setSort((previous) => ({
    key,
    direction: previous?.key === key ? (previous.direction === 'asc' ? 'desc' : 'asc') : 'asc',
  }))

  const changeControlType = (next: 'classic' | 'modern') => {
    setControlType(next)
    setSelectedMoveId(null)
    if (category !== 'ALL' && !dataset.moves.some((move) => move.controlType === next && move.category === category)) setCategory('ALL')
  }

  return <>
    <div className="character-overview">
      <div className="character-identity"><h2>{dataset.name}</h2><span lang="en">{dataset.englishName}</span></div>
      <dl className="character-health"><dt>体力</dt><dd>{dataset.health === null ? '—' : new Intl.NumberFormat('ja-JP').format(dataset.health)}</dd></dl>
      <a href={dataset.source.url} target="_blank" rel="noreferrer" className="character-official-link">公式データ<span className="win-rates-visually-hidden">（新しいタブ）</span><span aria-hidden="true"> ↗</span></a>
    </div>

    <section className="character-moves" aria-labelledby={`${contentId}-moves-heading`}>
      <div className="character-move-filters">
        <label className="character-control-filter"><span>操作タイプ</span><select aria-label="操作タイプ" value={controlType} onChange={(event) => changeControlType(event.target.value as 'classic' | 'modern')}>
          <option value="classic">クラシック</option><option value="modern">モダン</option>
        </select></label>
        <label className="character-search-filter"><span>技名・入力など</span><input ref={searchRef} type="search" aria-label="技名・入力など" value={query} placeholder="技を検索" onChange={(event) => setQuery(event.target.value)} /></label>
        <label className="character-category-filter"><span>分類</span><select aria-label="技の分類" value={category} onChange={(event) => setCategory(event.target.value)}>
          <option value="ALL">すべて</option>
          {categories.map((value) => <option value={value} key={value}>{value}</option>)}
        </select></label>
        <button type="button" className="win-rates-button" aria-pressed={extraColumns} onClick={() => setExtraColumns((value) => !value)}>詳細列</button>
        <button type="button" className="win-rates-button" disabled={!sort} onClick={() => setSort(null)}>公式順</button>
      </div>
      <div className="character-move-heading"><h3 id={`${contentId}-moves-heading`}>技一覧</h3><span role="status" aria-live="polite">{visibleMoves.length} / {controlMoves.length} 技</span></div>
      {visibleMoves.length === 0 ? <div className="character-empty-state" role="status">
        <p>条件に一致する技がありません。</p>
        <button type="button" className="win-rates-button" onClick={() => { setQuery(''); setCategory('ALL'); searchRef.current?.focus() }}>条件をリセット</button>
      </div> : <div className="data-table-scroll character-move-scroll" tabIndex={0} role="region" aria-label={`${dataset.name}の技一覧・スクロール領域`}>
        <table className={`data-table character-move-table${extraColumns ? ' with-extra-columns' : ''}`}>
          <caption className="win-rates-visually-hidden">{dataset.name}・{controlType === 'classic' ? 'クラシック' : 'モダン'}の技の性能</caption>
          <thead><tr>
            <th scope="col" className="character-move-name-column">技名</th>
            <SortHeader label="発生（F）" sortKey="startup" sort={sort} onSort={changeSort} />
            {extraColumns && <><th scope="col">持続</th><th scope="col">硬直（F）</th></>}
            <SortHeader label="ヒット（F）" sortKey="onHit" sort={sort} onSort={changeSort} />
            <SortHeader label="ガード（F）" sortKey="onBlock" sort={sort} onSort={changeSort} />
            <SortHeader label="ダメージ" sortKey="damage" sort={sort} onSort={changeSort} />
            {extraColumns && <th scope="col">キャンセル</th>}
          </tr></thead>
          <tbody>{visibleMoves.map((move) => <tr key={move.id} className={move.id === selectedMoveId ? 'character-move-selected' : undefined}>
            <th scope="row" className="character-move-name-column"><button
              type="button"
              className="character-move-open"
              ref={(element) => { if (element) moveButtonRefs.current.set(move.id, element); else moveButtonRefs.current.delete(move.id) }}
              aria-expanded={move.id === selectedMoveId}
              aria-controls={`${contentId}-move-detail`}
              aria-label={`${move.name}の詳細を表示`}
              onClick={() => setSelectedMoveId(move.id)}
            >{move.name}</button></th>
            <td>{displayValue(move.startup)}</td>
            {extraColumns && <><td>{displayValue(move.active)}</td><td>{displayValue(move.recovery)}</td></>}
            <td>{displayValue(move.onHit)}</td><td>{displayValue(move.onBlock)}</td><td>{displayValue(move.damage)}</td>
            {extraColumns && <td className="character-move-text">{displayValue(move.cancel)}</td>}
          </tr>)}</tbody>
        </table>
      </div>}
      <div id={`${contentId}-move-detail`} hidden={!selectedMove}>
        {selectedMove && <MoveDetail move={selectedMove} titleRef={detailTitleRef} onClose={closeDetail} />}
      </div>
    </section>

    <dl className="win-rates-source character-source">
      <div><dt>取得日時</dt><dd><time dateTime={dataset.capturedAt}>{timestampLabel(dataset.capturedAt)}</time></dd></div>
      <div><dt>パッチ</dt><dd>{dataset.gameVersion ?? '未確認'}</dd></div>
      <div><dt>出典</dt><dd><a href={dataset.source.url} target="_blank" rel="noreferrer">{dataset.source.title}<span className="win-rates-visually-hidden">（新しいタブ）</span></a></dd></div>
    </dl>
    <details className="win-rates-details">
      <summary>データの範囲と表記</summary>
      <div className="win-rates-details-content">
        <p>公式フレームデータを保存した内容です。取得日時はゲームのパッチ日とは別です。</p>
        <p>入力・掲載技は選択した操作タイプの公式表に基づきます。</p>
        <p>条件付きの数値や「全体」「着地後」などの表記はそのまま表示します。数値で比較できない行は並び替え時に末尾に置きます。</p>
        <p>技名を選ぶと入力・ゲージ・補正・備考を確認できます。Fはフレーム、ヒット・ガードは硬直差です。</p>
        <p>「—」は表記がない項目です。技の使用率・実戦での勝率は含みません。</p>
      </div>
    </details>
  </>
}

function SortHeader({ label, sortKey, sort, onSort }: {
  label: string
  sortKey: CharacterNumericSortKey
  sort: MoveSort
  onSort: (key: CharacterNumericSortKey) => void
}) {
  const active = sort?.key === sortKey
  const nextDirection = active && sort.direction === 'asc' ? '降順' : '昇順'
  return <th scope="col" className="character-sort-heading" aria-sort={active ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none'}>
    <button type="button" className="character-sort-button" aria-label={`${label}を${nextDirection}に並べる`} onClick={() => onSort(sortKey)}>
      <span>{label}</span><span aria-hidden="true" className="character-sort-indicator">{active ? (sort.direction === 'asc' ? '▲' : '▼') : '↕'}</span>
    </button>
  </th>
}

function MoveDetail({ move, titleRef, onClose }: {
  move: CharacterMove
  titleRef: RefObject<HTMLHeadingElement | null>
  onClose: () => void
}) {
  const titleId = useId()
  const rows = [
    ['操作タイプ', move.controlType === 'classic' ? 'クラシック' : 'モダン'], ['分類', move.category], ['入力（クラシック）', move.inputs.classic], ['入力（モダン）', move.inputs.modern],
    ['発生（F）', move.startup], ['持続', move.active], ['硬直（F）', move.recovery],
    ['ヒット硬直差（F）', move.onHit], ['ガード硬直差（F）', move.onBlock], ['キャンセル', move.cancel],
    ['ダメージ', move.damage], ['コンボ補正値', move.comboScaling], ['Dゲージ増加（ヒット）', move.driveGaugeGain],
    ['Dゲージ減少（ガード）', move.driveGaugeLoss], ['Dゲージ減少（パニッシュカウンター）', move.punishCounterDriveLoss],
    ['SAゲージ増加', move.superGaugeGain], ['属性', move.properties], ['備考', move.notes],
  ] as const
  return <section className="character-move-detail" aria-labelledby={titleId}>
    <header><h3 ref={titleRef} id={titleId} tabIndex={-1}>{move.name}</h3><button type="button" className="win-rates-button" onClick={onClose} aria-label={`${move.name}の詳細を閉じる`}>閉じる</button></header>
    <div className="data-table-scroll character-detail-scroll" tabIndex={0} role="region" aria-label={`${move.name}の詳細・スクロール領域`}>
      <table className="data-table character-detail-table"><tbody>{rows.map(([label, value]) => <tr key={label}><th scope="row">{label}</th><td>{displayValue(value)}</td></tr>)}</tbody></table>
    </div>
  </section>
}

function displayValue(value: string): string { return value.trim() ? value : '—' }

function timestampLabel(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : `${new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', dateStyle: 'medium', timeStyle: 'short' }).format(date)} JST`
}
