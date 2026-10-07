import { useEffect, useState } from 'react'
import { loadWinRateDataset, loadWinRateManifest } from '../lib/winRates'
import type { WinRateDataset, WinRateDatasetDescriptor, WinRateManifest, WinRateOperationMode } from '../types/winRates'
import { WinRateTable } from './WinRateTable'
import '../win-rates.css'

type DatasetState =
  | { id: string; status: 'loading' }
  | { id: string; status: 'ready'; data: WinRateDataset }
  | { id: string; status: 'error'; message: string }

const OPERATION_LABELS: Record<WinRateOperationMode, string> = {
  combined: '合算',
  separate: '操作タイプ別',
}

function chooseDataset(
  candidates: readonly WinRateDatasetDescriptor[],
  preferred?: Pick<WinRateDatasetDescriptor, 'league' | 'operationMode'>,
): WinRateDatasetDescriptor | undefined {
  return candidates.find((item) => item.league === preferred?.league && item.operationMode === preferred?.operationMode)
    ?? candidates.find((item) => item.league === preferred?.league && item.operationMode === 'combined')
    ?? candidates.find((item) => item.league === preferred?.league)
    ?? candidates.find((item) => item.operationMode === preferred?.operationMode)
    ?? candidates.find((item) => item.league === 'MASTER' && item.operationMode === 'combined')
    ?? candidates.find((item) => item.operationMode === 'combined')
    ?? candidates[0]
}

function initialDataset(manifest: WinRateManifest): WinRateDatasetDescriptor | undefined {
  const latestMonth = manifest.datasets.map((item) => item.month).sort().at(-1)
  return chooseDataset(manifest.datasets.filter((item) => item.month === latestMonth))
}

function monthLabel(month: string): string {
  const [year, monthNumber] = month.split('-')
  return `${year}年${Number(monthNumber)}月`
}

function timestampLabel(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return `${new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo', dateStyle: 'medium', timeStyle: 'short',
  }).format(date)} JST`
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.startsWith('選択した条件')
    ? '選択した条件とデータが一致しません。ページを再読み込みしてください。'
    : '勝率データを読み込めませんでした。'
}

function LoadState({ loading = false, message, onRetry }: {
  loading?: boolean
  message: string
  onRetry?: () => void
}) {
  return <div className="win-rates-load-state" role={onRetry ? 'alert' : 'status'} aria-busy={loading || undefined}>
    <p>{message}</p>
    {onRetry && <button className="win-rates-button" type="button" onClick={onRetry}>再読み込み</button>}
  </div>
}

export function WinRatesPage() {
  const [manifest, setManifest] = useState<WinRateManifest | null>(null)
  const [manifestLoading, setManifestLoading] = useState(true)
  const [manifestError, setManifestError] = useState<string | null>(null)
  const [manifestVersion, setManifestVersion] = useState(0)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [datasetState, setDatasetState] = useState<DatasetState | null>(null)
  const [datasetVersion, setDatasetVersion] = useState(0)

  useEffect(() => {
    let current = true
    setManifestLoading(true)
    setManifestError(null)
    void loadWinRateManifest().then((next) => {
      if (!current) return
      setManifest(next)
      setSelectedId((previous) => next.datasets.some((item) => item.id === previous)
        ? previous : initialDataset(next)?.id ?? null)
    }).catch((error: unknown) => {
      if (current) setManifestError(errorMessage(error))
    }).finally(() => {
      if (current) setManifestLoading(false)
    })
    return () => { current = false }
  }, [manifestVersion])

  const selected = manifest?.datasets.find((item) => item.id === selectedId)

  useEffect(() => {
    if (!selected) return
    let current = true
    const requested = selected
    setDatasetState({ id: requested.id, status: 'loading' })
    void loadWinRateDataset(requested).then((data) => {
      if (!current) return
      if (data.id !== requested.id) throw new Error('選択した条件とデータが一致しません。')
      setDatasetState({ id: requested.id, status: 'ready', data })
    }).catch((error: unknown) => {
      if (current) setDatasetState({ id: requested.id, status: 'error', message: errorMessage(error) })
    })
    return () => { current = false }
  }, [selected, datasetVersion])

  if (manifestLoading) return <LoadState loading message="期間と条件を読み込み中…" />
  if (manifestError) return <LoadState message={manifestError} onRetry={() => setManifestVersion((version) => version + 1)} />
  if (!manifest || manifest.datasets.length === 0) return <LoadState message="表示できるデータはまだ登録されていません。" />
  if (!selected) return <LoadState message="選択した条件のデータが登録されていません。" onRetry={() => setManifestVersion((version) => version + 1)} />

  const months = [...new Set(manifest.datasets.map((item) => item.month))].sort().reverse()
  const monthDatasets = manifest.datasets.filter((item) => item.month === selected.month)
  const leagues = [...new Set(monthDatasets.map((item) => item.league))]
  const leagueDatasets = monthDatasets.filter((item) => item.league === selected.league)
  const modes = [...new Set(leagueDatasets.map((item) => item.operationMode))]
  // Match the selection while rendering as well: a changed select must never label the previous table.
  const currentState = datasetState?.id === selected.id ? datasetState : null
  const dataset = currentState?.status === 'ready' && currentState.data.id === selected.id ? currentState.data : null

  return <section className="win-rates-page" aria-label="キャラクター別の勝率">
    <div className="win-rates-filters">
      <label>
        <span>対象月</span>
        <select aria-label="対象月" value={selected.month} onChange={(event) => {
          const next = chooseDataset(manifest.datasets.filter((item) => item.month === event.target.value), selected)
          setSelectedId(next?.id ?? null)
        }}>
          {months.map((month) => <option value={month} key={month}>{monthLabel(month)}</option>)}
        </select>
      </label>
      <label>
        <span>リーグ</span>
        <select aria-label="リーグ" value={selected.league} onChange={(event) => {
          const next = chooseDataset(monthDatasets.filter((item) => item.league === event.target.value), selected)
          setSelectedId(next?.id ?? null)
        }}>
          {leagues.map((league) => <option value={league} key={league}>{league}</option>)}
        </select>
      </label>
      <label>
        <span>操作タイプ</span>
        <select aria-label="操作タイプ" value={selected.operationMode} onChange={(event) => {
          setSelectedId(leagueDatasets.find((item) => item.operationMode === event.target.value)?.id ?? null)
        }}>
          {modes.map((mode) => <option value={mode} key={mode}>{OPERATION_LABELS[mode]}</option>)}
        </select>
      </label>
    </div>

    {(!currentState || currentState.status === 'loading') && <LoadState loading message="勝率表を読み込み中…" />}
    {currentState?.status === 'error' && <LoadState message={currentState.message} onRetry={() => setDatasetVersion((version) => version + 1)} />}

    {dataset && <>
      <WinRateTable key={dataset.id} dataset={dataset} />
      <dl className="win-rates-source">
        <div><dt>対象期間</dt><dd>{monthLabel(dataset.month)}</dd></div>
        <div><dt>取得日時</dt><dd><time dateTime={dataset.capturedAt}>{timestampLabel(dataset.capturedAt)}</time></dd></div>
        <div><dt>出典</dt><dd><a href={dataset.source.url} target="_blank" rel="noreferrer">{dataset.source.title}<span className="win-rates-visually-hidden">（新しいタブ）</span></a></dd></div>
      </dl>
      <details className="win-rates-details">
        <summary>データの範囲と表記</summary>
        <div className="win-rates-details-content">
          <dl>
            <div><dt>対象</dt><dd>{dataset.source.population}</dd></div>
            <div><dt>指標</dt><dd>{dataset.source.metric}</dd></div>
          </dl>
          <p>数値は公式表の表記です。百分率への換算は行っていません。</p>
          <p>「i」は公式サイトで試合数が少ないと示された組み合わせです。</p>
          {dataset.operationMode === 'separate' && <p>C：クラシック　M：モダン</p>}
          {dataset.source.notes.length > 0 && <ul>{dataset.source.notes.map((note, index) => <li key={index}>{note}</li>)}</ul>}
        </div>
      </details>
    </>}
  </section>
}
