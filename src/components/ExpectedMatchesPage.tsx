import { useId, useMemo, useRef, useState, type FormEvent } from 'react'
import { useExpectedMatches } from '../hooks/useExpectedMatches'
import { DEFAULT_EXPECTED_MATCH_MODEL, EXPECTED_MATCH_RANK_THRESHOLDS } from '../lib/expectedMatches'
import { expectedMatchResultText } from '../lib/expectedMatchesChart'
import { characterBarSeriesStyle } from '../lib/characterBarColors'
import { timestampLabel } from '../lib/dateTime'
import { formatTotalPercent } from '../lib/totalWinRates'
import { WIN_RATE_EDITION_SOURCES, leagueLabel } from '../lib/winRateConditions'
import { monthLabel } from '../lib/winRateHistory'
import type { ExpectedMatchRankInput, ExpectedMatchRow, ExpectedMatchSettings } from '../types/expectedMatchData'
import { DataLoadState } from './DataLoadState'
import { ExpectedMatchesChart } from './ExpectedMatchesChart'
import { CharacterSeriesKey } from './CharacterSeriesKey'
import { HistoryCharacterSelection } from './HistoryCharacterSelection'
import { StatisticsPanel } from './StatisticsPanel'
import '../table.css'
import '../win-rates.css'
import '../expected-matches.css'

const CONTROL_LABELS = { combined: '合算', classic: 'クラシック', modern: 'モダン' } as const
const START_PRESETS = EXPECTED_MATCH_RANK_THRESHOLDS.map(rank => ({
  value: rank.minimumLp, label: `${leagueLabel(rank.id)} · ${rank.minimumLp.toLocaleString('ja-JP')} LP`,
}))
const integerFormat = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 0 })
const DEFAULT_COMPARISON_IDS = ['honda', 'luke', 'ryu', 'ken', 'cammy', 'jamie']

function sortRows(rows: readonly ExpectedMatchRow[]): ExpectedMatchRow[] {
  return rows.map((row, index) => ({ row, index })).sort((left, right) => {
    const category = (row: ExpectedMatchRow) => row.result.status === 'finite' ? 0 : row.result.status === 'infinite' ? 1 : 2
    const difference = category(left.row) - category(right.row)
    if (difference) return difference
    const leftValue = left.row.result.status === 'finite' ? left.row.result.expectedMatches : Number.POSITIVE_INFINITY
    const rightValue = right.row.result.status === 'finite' ? right.row.result.expectedMatches : Number.POSITIVE_INFINITY
    return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : left.index - right.index
  }).map(({ row }) => row)
}

function rankValueText(rank: ExpectedMatchRankInput): string {
  return rank.text !== null ? formatTotalPercent(rank.text) : '—'
}

function rankStatusText(rank: ExpectedMatchRankInput): string {
  switch (rank.status) {
    case 'value': return rank.lowSample ? '少数試合' : '掲載値'
    case 'missing': return '欠損'
    case 'unlisted': return '未掲載'
    case 'unavailable': return '未登録'
    case 'error': return '読込失敗'
  }
}

function integerError(value: string, label: string, minimum: number, maximum: number): string | null {
  const number = Number(value)
  return value.trim() !== '' && Number.isInteger(number) && number >= minimum && number <= maximum
    ? null : `${label}は${integerFormat.format(minimum)}〜${integerFormat.format(maximum)}の整数で入力してください。`
}

function TimestampRange({ values }: { values: readonly string[] }) {
  const timestamps = [...new Set(values)].sort()
  const first = timestamps[0]
  const last = timestamps.at(-1)
  if (!first) return <>—</>
  return <><time dateTime={first}>{timestampLabel(first)}</time>{last !== first && <>〜<time dateTime={last}>{timestampLabel(last!)}</time></>}</>
}

export function ExpectedMatchesPage() {
  const {
    bootstrap, selection, months, controls, changeSelection, retryManifest,
    dataState, retryData, calculation, run, cancel,
  } = useExpectedMatches()
  const inputErrorId = useId()
  const rankPanelId = useId()
  const startLpInput = useRef<HTMLInputElement>(null)
  const [startLp, setStartLp] = useState(String(DEFAULT_EXPECTED_MATCH_MODEL.startLp))
  const [customStart, setCustomStart] = useState(false)
  const [winLp, setWinLp] = useState(String(DEFAULT_EXPECTED_MATCH_MODEL.winLp))
  const [lossLp, setLossLp] = useState(String(DEFAULT_EXPECTED_MATCH_MODEL.lossLp))
  const [selectedCharacterId, setSelectedCharacterId] = useState('ryu')
  const [comparedCharacterIds, setComparedCharacterIds] = useState(DEFAULT_COMPARISON_IDS)
  const [useCharacterColors, setUseCharacterColors] = useState(true)
  const errors = {
    startLp: integerError(startLp, '開始LP', 0, DEFAULT_EXPECTED_MATCH_MODEL.targetLp),
    winLp: integerError(winLp, '勝利時のLP', 1, 1000),
    lossLp: integerError(lossLp, '敗北時の減少LP', 0, 1000),
  }
  const inputError = errors.startLp ?? errors.winLp ?? errors.lossLp
  const model: ExpectedMatchSettings | null = inputError ? null : {
    startLp: Number(startLp), targetLp: DEFAULT_EXPECTED_MATCH_MODEL.targetLp,
    winLp: Number(winLp), lossLp: Number(lossLp),
  }
  const data = dataState.status === 'ready' ? dataState.data : null
  const completed = calculation.status === 'ready' ? calculation : null
  const rows = useMemo(() => completed ? sortRows(completed.rows) : [], [completed])
  const selectedRow = rows.find(row => row.character.fighter.characterId === selectedCharacterId) ?? rows[0]
  const detailCharacterId = selectedRow?.character.fighter.characterId ?? selectedCharacterId
  const characters = useMemo(() => {
    const fighters = data?.characters.map(character => character.fighter)
      ?? (bootstrap.status === 'ready' ? bootstrap.roster : [])
    return [...new Map(fighters.map(fighter => [fighter.characterId, fighter])).values()]
  }, [data, bootstrap])
  const validComparedIds = comparedCharacterIds.filter(id => characters.some(fighter => fighter.characterId === id))
  const comparisonIds = validComparedIds.length ? validComparedIds : characters.slice(0, 1).map(fighter => fighter.characterId)
  const comparisonRows = rows.filter(row => comparisonIds.includes(row.character.fighter.characterId))
  const running = calculation.status === 'running'
  const stale = completed !== null && (!model || (['startLp', 'winLp', 'lossLp'] as const)
    .some(key => model[key] !== completed.model[key]))
  const submittedModel = completed?.model ?? model
  const source = data?.datasets[0]?.source ?? WIN_RATE_EDITION_SOURCES.general
  const startPreset = START_PRESETS.find(preset => preset.value === Number(startLp) && startLp.trim() !== '')

  function calculate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (model && data && !running) run(model)
  }

  if (bootstrap.status === 'loading') return <DataLoadState loading message="表示条件とキャラ一覧を読み込み中…" />
  if (bootstrap.status === 'error' || !selection) return <DataLoadState message="表示条件とキャラ一覧を読み込めませんでした。" onRetry={retryManifest} />

  return <section className="expected-matches-page" aria-label="MASTERまでの期待試合数">
    <StatisticsPanel title="計算条件" headerContent={<span className="monthly-statistics-panel-summary">簡易モデル · MASTER 25,000 LP</span>}>
    <form className="expected-matches-form" onSubmit={calculate} noValidate>
      <div className="win-rates-filters expected-matches-filters">
        <label><span>対象月</span><select aria-label="対象月" value={selection.month} onChange={event => changeSelection({ ...selection, month: event.target.value })}>
          {months.map(month => <option key={month} value={month}>{monthLabel(month)}</option>)}
        </select></label>
        <label><span>操作タイプ</span><select aria-label="操作タイプ" value={selection.controlType} onChange={event => {
          const controlType = controls.find(value => value === event.target.value)
          if (controlType) changeSelection({ ...selection, controlType })
        }}>
          {controls.map(control => <option key={control} value={control}>{CONTROL_LABELS[control]}</option>)}
        </select></label>
        <label><span>開始ランク</span><select aria-label="開始ランク" value={customStart ? 'custom' : startPreset?.value ?? 'custom'} onChange={event => {
          const custom = event.target.value === 'custom'
          setCustomStart(custom)
          if (custom) startLpInput.current?.focus()
          else setStartLp(event.target.value)
        }}>
          {START_PRESETS.map(preset => <option key={preset.value} value={preset.value}>{preset.label}</option>)}
          <option value="custom">LPを指定</option>
        </select></label>
        <label className="expected-matches-start"><span>開始LP</span><input ref={startLpInput} className="expected-matches-number" type="number" inputMode="numeric" min={0} max={DEFAULT_EXPECTED_MATCH_MODEL.targetLp} step={1}
          value={startLp} aria-invalid={Boolean(errors.startLp)} aria-describedby={errors.startLp ? inputErrorId : undefined} onChange={event => { setStartLp(event.target.value); setCustomStart(true) }} /></label>
        <div className="expected-matches-actions">
          <button className="win-rates-button expected-matches-run" type="submit" disabled={!model || !data || running}>計算</button>
          {running && <button className="win-rates-button" type="button" onClick={cancel}>キャンセル</button>}
        </div>
      </div>
      <details className="win-rates-details expected-matches-settings">
        <summary>LP設定（仮定）</summary>
        <div className="win-rates-filters">
          <label><span>勝利時のLP</span><input className="expected-matches-number" type="number" inputMode="numeric" min={1} max={1000} step={1} value={winLp}
            aria-invalid={Boolean(errors.winLp)} aria-describedby={errors.winLp ? inputErrorId : undefined} onChange={event => setWinLp(event.target.value)} /></label>
          <label><span>敗北時の減少LP</span><input className="expected-matches-number" type="number" inputMode="numeric" min={0} max={1000} step={1} value={lossLp}
            aria-invalid={Boolean(errors.lossLp)} aria-describedby={errors.lossLp ? inputErrorId : undefined} onChange={event => setLossLp(event.target.value)} /></label>
        </div>
        <p className="expected-matches-settings-note">初期値の +60 / −40 LPは計算例の仮定です。実際のランクマッチのLPルールを再現する設定ではありません。</p>
      </details>
      {inputError && <p id={inputErrorId} className="expected-matches-input-error" role="alert">{inputError}</p>}
    </form>
    </StatisticsPanel>

    {(dataState.status === 'idle' || dataState.status === 'loading') && <DataLoadState loading message="ランク別Totalを読み込み中…" />}
    {dataState.status === 'error' && <DataLoadState message="ランク別Totalを読み込めませんでした。" onRetry={retryData} />}
    {data && data.failedCount > 0 && <div className="expected-matches-progress" role="alert"><span>{data.failedCount}ランクのデータを読み込めませんでした。</span><button className="win-rates-button" type="button" onClick={retryData}>再読み込み</button></div>}
    {running && <div className="expected-matches-progress" role="status" aria-live="polite" aria-busy="true">
      <span>計算中… {calculation.completed} / {calculation.total} キャラ</span>
      <progress value={calculation.completed} max={Math.max(1, calculation.total)} aria-label="キャラクター別の計算進捗" />
    </div>}
    {calculation.status === 'error' && <DataLoadState message="計算を完了できませんでした。" onRetry={() => { if (model) run(model) }} />}
    {data && calculation.status === 'idle' && <p className="expected-matches-status" role="status">未計算</p>}

    {data && completed && <>
      <StatisticsPanel title="期待試合数" headerContent={<><span className="monthly-statistics-panel-summary">
        {comparisonRows.length}キャラ · {integerFormat.format(completed.model.startLp)} → 25,000 LP · +{completed.model.winLp} / −{completed.model.lossLp}
      </span><label className="expected-matches-color-toggle">
        <input type="checkbox" checked={useCharacterColors} onChange={event => setUseCharacterColors(event.target.checked)} />
        キャラ色を使う
      </label></>}>
        <div className="expected-matches-chart-content">
          {stale && <p className="expected-matches-status" role="status">条件変更あり・計算で反映</p>}
          <HistoryCharacterSelection characters={characters} selectedIds={comparisonIds} onChange={setComparedCharacterIds}
            renderKey={id => <CharacterSeriesKey characterId={id} seriesStyle={characterBarSeriesStyle(id, useCharacterColors)} />} />
          <ExpectedMatchesChart rows={comparisonRows} scaleRows={rows} useCharacterColors={useCharacterColors} />
        </div>
      </StatisticsPanel>
      <div className="expected-matches-layout">
        <StatisticsPanel title="全キャラの表">
          <div className="data-table-scroll expected-matches-table-scroll" role="region" tabIndex={0} aria-label="キャラクター別期待試合数・スクロール領域">
            <table className="data-table expected-matches-table">
              <caption className="win-rates-visually-hidden">仮定によるMASTERまでの期待試合数、昇順。キャラクターを選ぶとランク別のTotalを確認できます。</caption>
              <colgroup><col /><col className="expected-matches-value-column" /></colgroup>
              <thead><tr><th scope="col">キャラクター</th><th scope="col" aria-sort="ascending">期待試合数（試合）</th></tr></thead>
              <tbody>{rows.map(row => {
                const selected = row.character.fighter.characterId === detailCharacterId
                return <tr key={row.character.fighter.characterId} data-selected={selected || undefined} onClick={() => setSelectedCharacterId(row.character.fighter.characterId)}>
                  <th scope="row"><button type="button" className="expected-matches-row-button" aria-pressed={selected} aria-controls={selectedRow ? rankPanelId : undefined}
                    onClick={() => setSelectedCharacterId(row.character.fighter.characterId)}>{row.character.fighter.name}</button></th>
                  <td>{expectedMatchResultText(row)}</td>
                </tr>
              })}</tbody>
            </table>
          </div>
        </StatisticsPanel>
        {selectedRow && <StatisticsPanel title="ランク別Total" headerContent={<select className="expected-matches-detail-select" aria-label="詳細キャラ"
          value={detailCharacterId} onChange={event => setSelectedCharacterId(event.target.value)}>
          {rows.map(row => <option key={row.character.fighter.characterId} value={row.character.fighter.characterId}>{row.character.fighter.name}</option>)}
        </select>}>
          <div className="expected-matches-ranks" id={rankPanelId} aria-label={`${selectedRow.character.fighter.name}のランク別Total`} aria-live="polite">
          <div className="data-table-scroll" role="region" tabIndex={0} aria-label={`${selectedRow.character.fighter.name}のランク別Total・スクロール領域`}>
            <table className="data-table expected-matches-rank-table">
              <caption className="win-rates-visually-hidden">計算に入力したランクごとの公式Totalの百分率換算とデータの状態</caption>
              <colgroup><col /><col className="expected-matches-rank-value-column" /><col className="expected-matches-rank-status-column" /></colgroup>
              <thead><tr><th scope="col">ランク</th><th scope="col">Total（%換算）</th><th scope="col">状態</th></tr></thead>
              <tbody>{selectedRow.character.ranks.map(rank => <tr key={rank.league}>
                <th scope="row">{leagueLabel(rank.league)}</th><td>{rankValueText(rank)}</td><td>{rankStatusText(rank)}</td>
              </tr>)}</tbody>
            </table>
          </div>
          <p className="expected-matches-rank-caption">{selectedRow.character.fighter.name} · {expectedMatchResultText(selectedRow)}{selectedRow.result.status === 'finite' ? ' 試合' : ''}</p>
          </div>
        </StatisticsPanel>}
      </div>
    </>}

    {data && <>
      <dl className="win-rates-source">
        <div><dt>対象期間</dt><dd>{monthLabel(selection.month)}</dd></div>
        <div><dt>操作タイプ</dt><dd>{CONTROL_LABELS[selection.controlType]}</dd></div>
        <div><dt>取得日時</dt><dd><TimestampRange values={data.datasets.map(dataset => dataset.capturedAt)} /></dd></div>
        <div><dt>生成日時</dt><dd><TimestampRange values={data.datasets.map(dataset => dataset.generatedAt)} /></dd></div>
        <div><dt>出典</dt><dd><a href={source.url} target="_blank" rel="noreferrer">{source.title}<span className="win-rates-visually-hidden">（新しいタブ）</span></a></dd></div>
      </dl>
      <details className="win-rates-details expected-matches-help"><summary>計算の前提・データの範囲</summary><div className="win-rates-details-content">
        <p>この表は、保存されたランク別の公式Totalを各試合の勝率と仮定した簡易モデルの計算値です。実際の昇格所要試合数や初心者個人の勝率を予測するものではありません。</p>
        <p>公式Totalを10倍して百分率で表示し、100で割った値を勝利確率に使用します（5.058 → 50.58% → 0.5058）。元の勝数・試合数、ゲーム単位かセット単位か、Totalの集計方法、ミラー戦・引き分け・切断の扱い、パッチ番号は未確認です。</p>
        <p>勝利で指定LPを加え、敗北で指定LPを引きます。LPの下限は0、25,000 LP以上で終了とし、現在のLPが属するランクの勝利確率を使用します。連勝ボーナス、降格保護、対戦相手のLP、プレイヤーの上達は含みません。</p>
        <p>期待試合数は小数第1位までの表示です。「∞」はこのモデルで有限の期待試合数を持たない状態、「計算不能」は数値の不安定さや計算量の上限により完了できない状態です。有限の結果だけを期待試合数の昇順に並べています。</p>
        <p>「欠損」は公式の「-」「-.---」、「未掲載」は対象ランクの表にキャラがない状態、「未登録」は保存データがない状態です。読込失敗も含め、欠けた値を0%や別ランクの値で補完しません。「少数試合」は元データの注意表示で、数値が掲載されている場合はその値を使用します。</p>
        <p>開始LPが25,000未満の場合、ROOKIEからDIAMONDまで7ランクすべての数値を必要とし、揃わないキャラは「データ不足」と表示します。開始LPが25,000なら期待試合数は0です。</p>
        <p>ランクの開始LPもモデル上の仮定です。ROOKIE 0、IRON 1,000、BRONZE 3,000、SILVER 5,000、GOLD 9,000、PLATINUM 13,000、DIAMOND 19,000として計算します。</p>
        <dl>
          <div><dt>計算条件</dt><dd>{submittedModel ? `開始 ${integerFormat.format(submittedModel.startLp)} LP・目標 ${integerFormat.format(submittedModel.targetLp)} LP・勝利 +${submittedModel.winLp} LP・敗北 −${submittedModel.lossLp} LP` : '未確定'}</dd></div>
          <div><dt>データ形式</dt><dd>{[...new Set(data.datasets.map(dataset => `Version ${dataset.schemaVersion}`))].join('、') || '—'}</dd></div>
        </dl>
        <div className="data-table-scroll" role="region" tabIndex={0} aria-label="ランク別のデータ取得情報・スクロール領域">
          <table className="data-table expected-matches-rank-source-table">
            <caption className="win-rates-visually-hidden">読み込んだランク別データの出典情報</caption>
            <thead><tr><th scope="col">ランク</th><th scope="col">取得日時</th><th scope="col">生成日時</th><th scope="col">対象・指標</th></tr></thead>
            <tbody>{data.datasets.map(dataset => <tr key={dataset.id}><th scope="row">{leagueLabel(dataset.league)}</th>
              <td><time dateTime={dataset.capturedAt}>{timestampLabel(dataset.capturedAt)}</time></td>
              <td><time dateTime={dataset.generatedAt}>{timestampLabel(dataset.generatedAt)}</time></td><td>{dataset.source.population}<br />{dataset.source.metric}</td>
            </tr>)}</tbody>
          </table>
        </div>
        {(() => {
          const notes = [...new Set(data.datasets.flatMap(dataset => dataset.source.notes))]
          return notes.length > 0 && <ul>{notes.map(note => <li key={note}>{note}</li>)}</ul>
        })()}
      </div></details>
    </>}
  </section>
}
