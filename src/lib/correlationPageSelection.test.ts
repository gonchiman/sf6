import assert from 'node:assert/strict'
import test from 'node:test'
import {
  correlationPageCalendars, initialCorrelationPageState, updateCorrelationPageState,
} from './correlationPageSelection.ts'
import { WIN_RATE_EDITION_LEAGUES, WIN_RATE_EDITION_SOURCES } from './winRateConditions.ts'
import { USAGE_RATE_EDITION_SOURCES } from './usageRates.ts'
import type { CorrelationPageCalendar, CorrelationPageState } from './correlationPageSelection.ts'
import type { UsageRateManifest } from '../types/usageRates.ts'
import type { WinRateDatasetDescriptor, WinRateManifest } from '../types/winRates.ts'

const capturedAt = '2026-10-15T00:00:00.000Z'
const generatedAt = '2026-10-15T00:01:00.000Z'

function descriptors(month: string, league = 'MASTER', edition: 'general' | 'master' = 'general',
  operationMode: 'combined' | 'separate' = 'combined') {
  const id = `${edition}-${month}-${league.toLowerCase()}`
  const win: WinRateDatasetDescriptor = { edition, id: `${id}-${operationMode}`, month, league, operationMode,
    path: `${id}-${operationMode}.json`, capturedAt }
  const usage = { edition, id, month, league, path: `${id}.json`, capturedAt }
  return { win, usage }
}

function manifests(items: ReturnType<typeof descriptors>[]): { win: WinRateManifest; usage: UsageRateManifest } {
  return {
    win: { schemaVersion: 1, generatedAt, source: WIN_RATE_EDITION_SOURCES.general, datasets: items.map(item => item.win) },
    usage: { schemaVersion: 1, generatedAt, source: USAGE_RATE_EDITION_SOURCES.general, datasets: items.map(item => item.usage) },
  }
}

function calendars(): CorrelationPageCalendar[] {
  const input = manifests([
    descriptors('2026-01'), descriptors('2026-06', 'IRON'),
    descriptors('2026-03', 'IRON', 'general', 'separate'), descriptors('2026-05', 'MASTER', 'general', 'separate'),
    descriptors('2026-04', 'HIGH_MASTER', 'master'), descriptors('2026-06', 'MASTER', 'master'),
  ])
  return correlationPageCalendars(input.win, input.usage)
}

function state(overrides: Partial<CorrelationPageState['selection']> = {}, selectedMonth = '2026-06',
  mode: CorrelationPageState['mode'] = 'monthly'): CorrelationPageState {
  return { selection: { edition: 'general', league: 'MASTER', controlType: 'combined',
    fromMonth: '2026-02', toMonth: '2026-04', ...overrides }, selectedMonth, mode }
}

test('公開月は同じランク内で両指標を照合し、ランク間の和集合を暦月化して欠損を残す', () => {
  const input = manifests([descriptors('2026-01'), descriptors('2026-04', 'IRON')])
  input.win.datasets.push(descriptors('2025-11', 'GOLD').win)
  input.usage.datasets.push(descriptors('2025-11', 'SILVER').usage)
  input.usage.datasets.push(descriptors('2026-08', 'ALL').usage)
  const output = correlationPageCalendars(input.win, input.usage)
  assert.equal(output.length, 1)
  assert.deepEqual(output[0].months, ['2026-01', '2026-02', '2026-03', '2026-04'])
  assert.deepEqual(output[0].leagues, WIN_RATE_EDITION_LEAGUES.general)
})

test('初期値は総合・合算・MASTERと全公開期間・最新月を選ぶ', () => {
  const output = initialCorrelationPageState(calendars())
  assert.deepEqual(output, { selection: { edition: 'general', league: 'MASTER', controlType: 'combined',
    fromMonth: '2026-01', toMonth: '2026-06' }, selectedMonth: '2026-06', mode: 'monthly' })
  const onlySeparate = calendars().filter(item => item.edition === 'general' && item.controlType === 'classic')
  assert.equal(initialCorrelationPageState(onlySeparate).selection.controlType, 'classic')
  assert.equal(initialCorrelationPageState(calendars().filter(item => item.edition === 'master')).selection.edition, 'master')
  assert.throws(() => initialCorrelationPageState([]), /両方が揃う条件/)
})

test('公開月が異なるランクや未登録ランクを選んでも期間・対象月・モードを変更しない', () => {
  const current = state({}, '2026-03', 'common')
  for (const league of ['IRON', 'GOLD']) {
    const output = updateCorrelationPageState(calendars(), current, { league })
    assert.deepEqual(output, { ...current, selection: { ...current.selection, league } })
  }
  assert.equal(current.selection.league, 'MASTER')
})

test('monthlyの対象月は推移期間と独立し、期間内外の切替でも保持する', () => {
  const current = state()
  const shorter = updateCorrelationPageState(calendars(), current, { fromMonth: '2026-03', toMonth: '2026-03' })
  assert.equal(shorter.selectedMonth, '2026-06')
  const selectedGap = updateCorrelationPageState(calendars(), shorter, { selectedMonth: '2026-02' })
  assert.equal(selectedGap.selectedMonth, '2026-02')
  assert.deepEqual(selectedGap.selection, shorter.selection)
})

test('commonへの切替と期間変更は実際の対象月を補正し、期間を戻しても古い月が復帰しない', () => {
  const common = updateCorrelationPageState(calendars(), state(), { mode: 'common' })
  assert.equal(common.selectedMonth, '2026-04')
  const narrowed = updateCorrelationPageState(calendars(), common, { toMonth: '2026-03' })
  assert.equal(narrowed.selectedMonth, '2026-03')
  const widened = updateCorrelationPageState(calendars(), narrowed, { toMonth: '2026-06' })
  assert.equal(widened.selectedMonth, '2026-03')
  const outOfRange = updateCorrelationPageState(calendars(), widened, { selectedMonth: '2026-01' })
  assert.equal(outOfRange.selectedMonth, '2026-02')
  assert.equal(updateCorrelationPageState(calendars(), outOfRange, { mode: 'monthly' }).selectedMonth, '2026-02')
})

test('単一境界の変更で逆転したら反対端を同月にし、両端指定の逆転は昇順へ整える', () => {
  const current = state()
  const laterStart = updateCorrelationPageState(calendars(), current, { fromMonth: '2026-05' })
  assert.deepEqual([laterStart.selection.fromMonth, laterStart.selection.toMonth], ['2026-05', '2026-05'])
  const earlierEnd = updateCorrelationPageState(calendars(), current, { toMonth: '2026-01' })
  assert.deepEqual([earlierEnd.selection.fromMonth, earlierEnd.selection.toMonth], ['2026-01', '2026-01'])
  const reversed = updateCorrelationPageState(calendars(), current, { fromMonth: '2026-05', toMonth: '2026-03' })
  assert.deepEqual([reversed.selection.fromMonth, reversed.selection.toMonth], ['2026-03', '2026-05'])
  assert.equal(reversed.selectedMonth, '2026-06')
})

test('操作変更はランクから独立した公開暦月へ補正し、未登録の中間月を選択可能にする', () => {
  const changed = updateCorrelationPageState(calendars(), state({ league: 'GOLD' }), { controlType: 'modern' })
  assert.deepEqual(changed, { selection: { edition: 'general', league: 'GOLD', controlType: 'modern',
    fromMonth: '2026-03', toMonth: '2026-04' }, selectedMonth: '2026-05', mode: 'monthly' })
  const gap = updateCorrelationPageState(calendars(), changed, { selectedMonth: '2026-04' })
  assert.equal(gap.selectedMonth, '2026-04')
})

test('マスター版への変更は合算へ戻し、非対応ランクをMASTERにして期間と対象月を補正する', () => {
  const current = state({ controlType: 'classic', league: 'IRON', fromMonth: '2026-01', toMonth: '2026-03' }, '2026-02')
  const changed = updateCorrelationPageState(calendars(), current, { edition: 'master' })
  assert.deepEqual(changed, { selection: { edition: 'master', controlType: 'combined', league: 'MASTER',
    fromMonth: '2026-04', toMonth: '2026-04' }, selectedMonth: '2026-04', mode: 'monthly' })
  assert.equal(updateCorrelationPageState(calendars(), changed, { controlType: 'modern' }).selection.controlType, 'combined')
  assert.equal(updateCorrelationPageState(calendars(), state(), { edition: 'master' }).selection.league, 'MASTER')
})

test('対象月と期間の不正な月形式を受け付けない', () => {
  for (const patch of [{ selectedMonth: '2026-13' }, { fromMonth: '2026-00' }, { toMonth: '2026-2' }]) {
    assert.throws(() => updateCorrelationPageState(calendars(), state(), patch), /YYYY-MM/)
  }
})
