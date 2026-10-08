import { parseWinRateDataset } from '../../src/lib/winRates.ts'
import { WIN_RATE_EDITION_LEAGUES, WIN_RATE_EDITION_OPERATION_MODES, WIN_RATE_EDITION_SOURCES } from '../../src/lib/winRateConditions.ts'
import type { WinRateControlType, WinRateDataset, WinRateOperationMode } from '../../src/types/winRates.ts'

type UnknownRecord = Record<string, unknown>
type Identity = { characterId: string; controlType: WinRateControlType }

function invalid(field: string): never {
  throw new Error(`Bucklerスナップショットの形式が正しくありません（${field}）。`)
}

function record(value: unknown, field: string): UnknownRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid(field)
  return value as UnknownRecord
}

function array(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) invalid(field)
  return value
}

function month(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^\d{4}-(?:0[1-9]|1[0-2])$/.test(value)) invalid(field)
  return value
}

function identity(value: UnknownRecord, mode: WinRateOperationMode, field: string): Identity {
  if (typeof value.characterId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value.characterId)) {
    invalid(`${field}.characterId`)
  }
  const controlType = value.controlType
  if (mode === 'combined' ? controlType !== null : controlType !== 'classic' && controlType !== 'modern') {
    invalid(`${field}.controlType`)
  }
  return { characterId: value.characterId, controlType: controlType as WinRateControlType }
}

function identityKey(value: Identity): string {
  return JSON.stringify([value.characterId, value.controlType])
}

function fighterId(value: Identity): string {
  return value.controlType === null ? value.characterId : `${value.characterId}-${value.controlType}`
}

/** Normalize one fully loaded official table without recalculating its published values. */
export function normalizeBucklerSnapshot(
  value: unknown,
  expectedMonth?: string,
  generatedAt = new Date().toISOString(),
): WinRateDataset {
  const input = record(value, 'snapshot')
  if (input.snapshotVersion !== 1) invalid('snapshotVersion')
  const edition = input.sourceUrl === WIN_RATE_EDITION_SOURCES.general.url ? 'general'
    : input.sourceUrl === WIN_RATE_EDITION_SOURCES.master.url ? 'master' : invalid('sourceUrl')
  if (input.edition !== undefined && input.edition !== edition) invalid('edition: sourceUrl does not match edition')
  const selectedMonth = month(input.month, 'month')
  if (expectedMonth !== undefined && selectedMonth !== month(expectedMonth, 'expectedMonth')) {
    invalid('month: requested month does not match selected month')
  }
  if (selectedMonth < (edition === 'master' ? '2025-02' : '2023-06')) invalid('month: before first published month')
  if (typeof input.league !== 'string' || !WIN_RATE_EDITION_LEAGUES[edition].includes(input.league)) invalid('league')
  const league = input.league
  if (input.operationMode !== 'combined' && input.operationMode !== 'separate') invalid('operationMode')
  const mode = input.operationMode
  if (!WIN_RATE_EDITION_OPERATION_MODES[edition].includes(mode)) invalid('operationMode: unsupported for edition')
  if (input.order !== 'character') invalid('order')
  const columns = array(input.columns, 'columns').map((column, index) =>
    identity(record(column, `columns[${index}]`), mode, `columns[${index}]`))
  if (!Number.isInteger(input.readyCharacterCount) || input.readyCharacterCount !== columns.length || columns.length === 0) {
    invalid('readyCharacterCount')
  }
  const columnKeys = new Set(columns.map(identityKey))
  if (columnKeys.size !== columns.length) invalid('columns: duplicate identity')
  if (mode === 'separate') {
    const characters = new Set(columns.map((column) => column.characterId))
    for (const characterId of characters) {
      if (!columnKeys.has(identityKey({ characterId, controlType: 'classic' }))
        || !columnKeys.has(identityKey({ characterId, controlType: 'modern' }))) {
        invalid('columns: both control types are required for each character')
      }
    }
  }
  const rawRows = array(input.rows, 'rows')
  if (rawRows.length !== columns.length) invalid('rows: length')
  const rowsByIdentity = new Map<string, UnknownRecord>()
  rawRows.forEach((value, index) => {
    const row = record(value, `rows[${index}]`)
    const key = identityKey(identity(row, mode, `rows[${index}]`))
    if (!columnKeys.has(key)) invalid(`rows[${index}]: unknown identity`)
    if (rowsByIdentity.has(key)) invalid(`rows[${index}]: duplicate identity`)
    rowsByIdentity.set(key, row)
  })
  const dataset = parseWinRateDataset({
    schemaVersion: 1,
    id: `${selectedMonth}-${edition === 'master' ? 'master-edition-' : ''}${league.toLowerCase()}-${mode}`,
    ...(edition === 'master' ? { edition } : {}),
    month: selectedMonth,
    league,
    operationMode: mode,
    capturedAt: input.capturedAt,
    generatedAt,
    source: {
      ...WIN_RATE_EDITION_SOURCES[edition],
      population: 'ランクマッチ',
      metric: '公式対戦ダイアグラムの掲載値',
      notes: [
        '公式表記の小数3桁を保持。百分率への換算は行っていない。',
        '少数試合の印は公式表の表示に従う。試合数は公開表から取得できていない。',
        '勝ち・対戦の集計単位、Totalの算出方法、引き分け・切断等の扱いは未確認。',
        ...(edition === 'master' ? ['マスター版の操作タイプ合算を取得。総合版MASTERとは異なる掲載区分として保持。各区分のMR境界と対象プレイヤーの判定時点は未確認。'] : []),
      ],
    },
    fighters: columns.map((column) => ({
      ...column,
      id: fighterId(column),
      name: rowsByIdentity.get(identityKey(column))!.name,
    })),
    rows: columns.map((column) => {
      const row = rowsByIdentity.get(identityKey(column))!
      return { fighterId: fighterId(column), total: row.total, cells: row.cells }
    }),
  })
  if (!dataset.rows.some((row) => [row.total, ...row.cells].some((cell) => /^\d/.test(cell.text)))) {
    invalid('rows: no numeric values; table may still be loading')
  }
  return dataset
}
