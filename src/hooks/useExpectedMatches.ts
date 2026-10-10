import { useEffect, useMemo, useRef, useState } from 'react'
import { expectedMatchControls, expectedMatchMonths, loadExpectedMatchData } from '../lib/expectedMatchData'
import { editionOf } from '../lib/winRateConditions'
import { loadWinRateDataset, loadWinRateManifest } from '../lib/winRates'
import type { WinRateFighter, WinRateManifest } from '../types/winRates'
import type { ExpectedMatchData, ExpectedMatchRow, ExpectedMatchSelection, ExpectedMatchSettings, ExpectedMatchWorkerResponse } from '../types/expectedMatchData'

type Bootstrap = { status: 'loading' | 'error' } | { status: 'ready'; manifest: WinRateManifest; roster: WinRateFighter[] }
type DataState = { key: string; status: 'loading' | 'error' } | { key: string; status: 'ready'; data: ExpectedMatchData }
type Calculation = { status: 'idle' } | { key: string; status: 'running'; completed: number; total: number }
  | { key: string; status: 'error' } | { key: string; status: 'ready'; rows: ExpectedMatchRow[]; model: ExpectedMatchSettings }

export function useExpectedMatches() {
  const [bootstrap, setBootstrap] = useState<Bootstrap>({ status: 'loading' })
  const [manifestVersion, setManifestVersion] = useState(0)
  const [selection, setSelection] = useState<ExpectedMatchSelection | null>(null)
  const [data, setData] = useState<DataState | null>(null)
  const [dataVersion, setDataVersion] = useState(0)
  const [calculation, setCalculation] = useState<Calculation>({ status: 'idle' })
  const workerRef = useRef<Worker | null>(null)
  const currentKeyRef = useRef<string | null>(null)

  useEffect(() => {
    let current = true
    setBootstrap({ status: 'loading' })
    void loadWinRateManifest().then(async manifest => {
      const months = expectedMatchMonths(manifest)
      if (!months.length) throw new Error('No general rank data')
      // Use stats IDs, including honda/gouki/vega, rather than frame-data aliases.
      const candidates = manifest.datasets.filter(item => editionOf(item) === 'general' && item.month === months[0])
      const descriptor = candidates.find(item => item.league === 'DIAMOND' && item.operationMode === 'separate')
        ?? candidates.find(item => item.operationMode === 'separate') ?? candidates[0]
      if (!descriptor) throw new Error('No current character roster')
      const roster = (await loadWinRateDataset(descriptor)).fighters
      if (!current) return
      const controls = expectedMatchControls(manifest, months[0])
      setSelection({ month: months[0], controlType: controls.includes('classic') ? 'classic' : controls[0] })
      setBootstrap({ status: 'ready', manifest, roster })
    }).catch(() => { if (current) setBootstrap({ status: 'error' }) })
    return () => { current = false }
  }, [manifestVersion])

  const manifest = bootstrap.status === 'ready' ? bootstrap.manifest : null
  const roster = bootstrap.status === 'ready' ? bootstrap.roster : null
  const key = manifest && selection ? JSON.stringify([manifest.generatedAt, selection, dataVersion]) : null
  currentKeyRef.current = key
  const months = useMemo(() => manifest ? expectedMatchMonths(manifest) : [], [manifest])
  const controls = useMemo(() => manifest && selection ? expectedMatchControls(manifest, selection.month) : [], [manifest, selection])

  useEffect(() => {
    if (!manifest || !selection || !roster || !key) return
    let current = true
    const requestedKey = key
    workerRef.current?.terminate()
    workerRef.current = null
    setCalculation({ status: 'idle' })
    setData({ key: requestedKey, status: 'loading' })
    void loadExpectedMatchData(manifest, selection, roster).then(result => {
      if (current) setData({ key: requestedKey, status: 'ready', data: result })
    }).catch(() => { if (current) setData({ key: requestedKey, status: 'error' }) })
    return () => { current = false }
  }, [manifest, roster, key, selection])

  useEffect(() => () => { workerRef.current?.terminate() }, [])

  const dataState = data?.key === key ? data : { status: key ? 'loading' as const : 'idle' as const }
  const currentCalculation = calculation.status === 'idle' || calculation.key === key ? calculation : { status: 'idle' as const }

  const cancel = () => {
    workerRef.current?.terminate()
    workerRef.current = null
    setCalculation({ status: 'idle' })
  }

  const run = (model: ExpectedMatchSettings) => {
    if (dataState.status !== 'ready' || !key) return
    const requestedKey = key
    const snapshot = { ...model }
    workerRef.current?.terminate()
    workerRef.current = null
    try {
      const worker = new Worker(new URL('../workers/expectedMatches.worker.ts', import.meta.url), { type: 'module' })
      workerRef.current = worker
      setCalculation({ key: requestedKey, status: 'running', completed: 0, total: dataState.data.characters.length })
      worker.onmessage = (event: MessageEvent<ExpectedMatchWorkerResponse>) => {
        if (workerRef.current !== worker || currentKeyRef.current !== requestedKey) return
        const response = event.data
        if (response.status === 'progress') setCalculation({ key: requestedKey, status: 'running', completed: response.completed, total: response.total })
        else {
          if (response.status === 'ready') setCalculation({ key: requestedKey, ...response, model: snapshot })
          else setCalculation({ key: requestedKey, status: 'error' })
          worker.terminate()
          workerRef.current = null
        }
      }
      worker.onerror = () => {
        if (workerRef.current !== worker || currentKeyRef.current !== requestedKey) return
        worker.terminate()
        workerRef.current = null
        setCalculation({ key: requestedKey, status: 'error' })
      }
      worker.postMessage({ characters: dataState.data.characters, model: snapshot })
    } catch {
      workerRef.current?.terminate()
      workerRef.current = null
      setCalculation({ key: requestedKey, status: 'error' })
    }
  }

  const changeSelection = (next: ExpectedMatchSelection) => {
    if (!manifest) return
    const nextControls = expectedMatchControls(manifest, next.month)
    const controlType = nextControls.includes(next.controlType) ? next.controlType
      : nextControls.includes('classic') ? 'classic' : nextControls[0]
    cancel()
    setSelection({ month: next.month, controlType })
  }

  return { bootstrap, selection, months, controls, changeSelection, dataState, calculation: currentCalculation,
    retryManifest: () => { cancel(); setManifestVersion(value => value + 1) },
    retryData: () => { cancel(); setDataVersion(value => value + 1) }, run, cancel }
}
