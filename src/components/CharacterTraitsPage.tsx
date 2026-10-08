import { useEffect, useId, useMemo, useRef, useState, type RefObject } from 'react'
import { CHARACTER_TRAITS, loadCharacterTraitsDataset } from '../lib/characterTraits'
import { timestampLabel } from '../lib/dateTime'
import { characterHash } from '../lib/routes'
import type { CharacterControlType } from '../types/characters'
import type {
  CharacterTraitEvidence, CharacterTraitId, CharacterTraitStatus,
  CharacterTraitsCharacter, CharacterTraitsDataset,
} from '../types/characterTraits'
import { DataLoadState as CharacterDataLoadState } from './DataLoadState'
import '../table.css'
import '../win-rates.css'
import '../characters.css'
import '../character-traits.css'

const STATUS_LABELS: Record<CharacterTraitStatus, string> = {
  confirmed: 'データで確認', 'not-found': '該当記載なし', unknown: '未確認',
}
const STATUSES: CharacterTraitStatus[] = ['confirmed', 'not-found', 'unknown']
type StatusFilter = 'all' | CharacterTraitStatus
type LoadState = { status: 'loading' } | { status: 'error' } | { status: 'ready'; data: CharacterTraitsDataset }

export function CharacterTraitsPage() {
  const [state, setState] = useState<LoadState>({ status: 'loading' })
  const [retry, setRetry] = useState(0)

  useEffect(() => {
    let current = true
    setState({ status: 'loading' })
    void loadCharacterTraitsDataset().then((data) => {
      if (current) setState({ status: 'ready', data })
    }).catch(() => {
      if (current) setState({ status: 'error' })
    })
    return () => { current = false }
  }, [retry])

  if (state.status === 'loading') return <CharacterDataLoadState loading message="キャラ分類データを読み込み中…" />
  if (state.status === 'error') return <CharacterDataLoadState message="キャラ分類データを読み込めませんでした。" onRetry={() => setRetry((value) => value + 1)} />
  return <TraitClassification dataset={state.data} />
}

function TraitClassification({ dataset }: { dataset: CharacterTraitsDataset }) {
  const pageId = useId()
  const [featureId, setFeatureId] = useState<CharacterTraitId>('full')
  const [controlType, setControlType] = useState<CharacterControlType>('classic')
  const [filter, setFilter] = useState<StatusFilter>('all')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const featureRef = useRef<HTMLSelectElement>(null)
  const detailHeadingRef = useRef<HTMLHeadingElement>(null)
  const detailTriggerRef = useRef<HTMLButtonElement | null>(null)
  const feature = CHARACTER_TRAITS.find((entry) => entry.id === featureId)!
  const selected = dataset.characters.find((entry) => entry.id === selectedId)
  const counts = useMemo(() => Object.fromEntries(STATUSES.map((status) => [status,
    dataset.characters.filter((entry) => entry.traits[controlType][featureId].status === status).length,
  ])) as Record<CharacterTraitStatus, number>, [dataset.characters, controlType, featureId])
  const visible = useMemo(() => dataset.characters.filter((entry) => filter === 'all'
    || entry.traits[controlType][featureId].status === filter), [dataset.characters, controlType, featureId, filter])
  const captureTimes = dataset.characters.map((entry) => entry.capturedAt).sort((a, b) => Date.parse(a) - Date.parse(b))
  const versions = [...new Set(dataset.characters.map((entry) => entry.gameVersion ?? '未確認'))]

  useEffect(() => {
    if (!selectedId) return
    const frame = window.requestAnimationFrame(() => focusDetailHeading(detailHeadingRef.current))
    return () => window.cancelAnimationFrame(frame)
  }, [selectedId])

  const closeDetail = () => {
    setSelectedId(null)
    window.requestAnimationFrame(() => {
      if (detailTriggerRef.current?.isConnected) detailTriggerRef.current.focus()
      else featureRef.current?.focus()
    })
  }
  const openDetail = (characterId: string, trigger: HTMLButtonElement) => {
    detailTriggerRef.current = trigger
    if (selectedId === characterId) window.requestAnimationFrame(() => focusDetailHeading(detailHeadingRef.current))
    setSelectedId(characterId)
  }

  return <section className="character-traits-page" aria-label="キャラ分類">
    <div className="character-move-filters character-trait-filters">
      <label className="character-control-filter"><span>操作タイプ</span>
        <select aria-label="操作タイプ" value={controlType} onChange={(event) => {
          setControlType(event.target.value as CharacterControlType); setSelectedId(null)
        }}><option value="classic">クラシック</option><option value="modern">モダン</option></select>
      </label>
      <label className="character-trait-feature-filter"><span>特徴</span>
        <select ref={featureRef} aria-label="分類する特徴" value={featureId} onChange={(event) => {
          setFeatureId(event.target.value as CharacterTraitId); setFilter('all'); setSelectedId(null)
        }}>{CHARACTER_TRAITS.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}</select>
      </label>
      <span className="character-trait-scope">{featureId === 'air' ? '必殺技・通常版' : '必殺技・通常／OD'}</span>
    </div>

    <div className="character-trait-status-filters" role="group" aria-label="判定で絞り込む">
      {(['all', ...STATUSES] as StatusFilter[]).map((status) => <button type="button" className="win-rates-button"
        key={status} aria-pressed={filter === status} onClick={() => { setFilter(status); setSelectedId(null) }}>
        {status === 'all' ? 'すべて' : STATUS_LABELS[status]} <span>{status === 'all' ? dataset.characters.length : counts[status]}</span>
      </button>)}
    </div>

    <section className="character-trait-results" aria-labelledby={`${pageId}-results`}>
      <div className="character-move-heading"><h2 id={`${pageId}-results`}>{feature.label}</h2>
        <span role="status" aria-live="polite">{visible.length} / {dataset.characters.length} キャラ</span>
      </div>
      {visible.length === 0 ? <div className="character-empty-state" role="status">
        <p>この判定のキャラはいません。</p>
        <button type="button" className="win-rates-button" onClick={() => {
          setFilter('all'); window.requestAnimationFrame(() => featureRef.current?.focus())
        }}>すべて表示</button>
      </div> : <div className="data-table-scroll character-trait-scroll" tabIndex={0} role="region" aria-label={`${feature.label}のキャラ分類・スクロール領域`}>
        <table className="data-table character-trait-table">
          <caption className="win-rates-visually-hidden">{feature.label}・{controlType === 'classic' ? 'クラシック' : 'モダン'}のキャラ分類</caption>
          <thead><tr><th scope="col">キャラ</th><th scope="col">判定</th><th scope="col">該当技・根拠</th></tr></thead>
          <tbody>{visible.map((character) => {
            const result = character.traits[controlType][featureId]
            const first = result.evidence[0]
            const evidenceMoveCount = new Set(result.evidence.map((entry) => entry.moveId)).size
            return <tr key={character.id} className={selectedId === character.id ? 'character-move-selected' : undefined}>
              <th scope="row"><button type="button" className="character-move-open"
                aria-label={`${character.name}の分類根拠を表示`} aria-expanded={selectedId === character.id}
                aria-controls={`${pageId}-detail`} onClick={(event) => openDetail(character.id, event.currentTarget)}>{character.name}</button></th>
              <td className="character-trait-status">{STATUS_LABELS[result.status]}</td>
              <td>{first ? <>
                <span className="character-trait-move-name">{first.moveName}</span>
                <span className="character-trait-excerpt">{first.excerpt}</span>
                {evidenceMoveCount > 1 && <button type="button" className="character-trait-more"
                  aria-controls={`${pageId}-detail`} aria-expanded={selectedId === character.id}
                  aria-label={`${character.name}の該当技をすべて表示`} onClick={(event) => openDetail(character.id, event.currentTarget)}>ほか {evidenceMoveCount - 1} 技</button>}
              </> : result.status === 'unknown' ? result.reason ?? '記載を判定できませんでした。' : '—'}</td>
            </tr>
          })}</tbody>
        </table>
      </div>}
    </section>

    <div id={`${pageId}-detail`} hidden={!selected}>
      {selected && <TraitEvidenceDetail character={selected} featureId={featureId} controlType={controlType}
        titleRef={detailHeadingRef} onClose={closeDetail} />}
    </div>

    <dl className="win-rates-source character-source">
      <div><dt>取得日時</dt><dd><time dateTime={captureTimes[0]}>{timestampLabel(captureTimes[0])}</time>
        {captureTimes[0] !== captureTimes.at(-1) && <> ～ <time dateTime={captureTimes.at(-1)}>{timestampLabel(captureTimes.at(-1)!)}</time></>}</dd></div>
      <div><dt>パッチ</dt><dd>{versions.join('／')}</dd></div>
      <div><dt>出典</dt><dd>CAPCOM 公式フレームデータ</dd></div>
    </dl>

    <details className="win-rates-details character-trait-help">
      <summary>分類条件と判定の意味</summary>
      <div className="win-rates-details-content">
        <dl>{CHARACTER_TRAITS.map((entry) => <div key={entry.id}><dt>{entry.label}</dt><dd>{entry.description}</dd></div>)}</dl>
        <p>「データで確認」は対象の必殺技に該当記載が1つ以上ある状態です。最初の該当技を一覧に表示し、キャラ名からすべての根拠を確認できます。</p>
        <p>「該当記載なし」は、保存済みデータで条件に合う記載が見つからない状態です。実際の性能がないとは断定しません。「未確認」はデータ不足や読み取れない表現がある状態です。</p>
        <p>通常版は非ODの技を指し、強化状態・派生を含みます。部位・フレーム・状態などの条件は技名と原文で確認してください。SA・通常技・共通システムは対象外です。</p>
        <p>取得日時とパッチ日は別です。現在の技データと過去の勝率の対応は未確認です。</p>
      </div>
    </details>
  </section>
}

function focusDetailHeading(heading: HTMLHeadingElement | null): void {
  heading?.focus({ preventScroll: true })
  heading?.scrollIntoView({ block: 'start', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
}

function TraitEvidenceDetail({ character, featureId, controlType, titleRef, onClose }: {
  character: CharacterTraitsCharacter
  featureId: CharacterTraitId
  controlType: CharacterControlType
  titleRef: RefObject<HTMLHeadingElement | null>
  onClose: () => void
}) {
  const titleId = useId()
  const feature = CHARACTER_TRAITS.find((entry) => entry.id === featureId)!
  const result = character.traits[controlType][featureId]
  const renderEvidence = (entries: CharacterTraitEvidence[]) => <div className="data-table-scroll character-trait-evidence-scroll"
    tabIndex={0} role="region" aria-label={`${character.name}の該当記載・スクロール領域`}>
    <table className="data-table character-trait-evidence-table">
      <caption className="win-rates-visually-hidden">{character.name}の{feature.label}の根拠</caption>
      <thead><tr><th scope="col">技名</th><th scope="col">通常／OD</th><th scope="col">記載</th></tr></thead>
      <tbody>{entries.map((entry, index) => <tr key={`${entry.moveId}-${entry.field}-${index}`}>
        <th scope="row">{entry.moveName}</th><td>{entry.variant === 'od' ? 'OD' : '通常'}</td>
        <td><span className="character-trait-field">{entry.field === 'notes' ? '備考' : '属性'}</span>{entry.text}</td>
      </tr>)}</tbody>
    </table>
  </div>
  return <section className="character-move-detail character-trait-detail" aria-labelledby={titleId}>
    <header><h2 id={titleId} ref={titleRef} tabIndex={-1}>{character.name}の分類根拠</h2>
      <button type="button" className="win-rates-button" onClick={onClose}>閉じる</button>
    </header>
    <div className="character-trait-detail-meta"><span>{feature.label}</span><span>{STATUS_LABELS[result.status]}</span>
      <span>{controlType === 'classic' ? 'クラシック' : 'モダン'}</span></div>
    {result.evidence.length > 0 ? renderEvidence(result.evidence) : <p className="character-trait-no-evidence">{result.reason ?? 'この条件に該当する記載は見つかりませんでした。'}</p>}
    {result.unresolved.length > 0 && <details className="win-rates-details"><summary>未確認の記載 {result.unresolved.length}</summary>{renderEvidence(result.unresolved)}</details>}
    <dl className="win-rates-source character-trait-detail-source">
      <div><dt>取得日時</dt><dd><time dateTime={character.capturedAt}>{timestampLabel(character.capturedAt)}</time></dd></div>
      <div><dt>パッチ</dt><dd>{character.gameVersion ?? '未確認'}</dd></div>
      <div><dt>出典</dt><dd><a href={character.source.url} target="_blank" rel="noreferrer">公式フレームデータ<span className="win-rates-visually-hidden">（新しいタブ）</span><span aria-hidden="true"> ↗</span></a></dd></div>
    </dl>
    <a className="character-trait-character-link" href={characterHash(character.id)}>キャラ情報を開く</a>
  </section>
}
