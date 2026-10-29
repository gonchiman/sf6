import assert from 'node:assert/strict'
import test from 'node:test'
import type { SampleSurveyInsightDataset } from '../types/sampleSurveyInsights.ts'
import { surveyCellState, surveyCellDetail, surveyConditionKey, surveyConditionLabel, surveyCoverageState, surveyMetricKeys } from './sampleSurveyPresentation.ts'

test('missing, observed zero, and zero denominator remain distinct in presentation', () => {
  assert.equal(surveyCellState(undefined), '未取得')
  assert.equal(surveyCellState({ kind: 'ratio', n: 3, numerator: 0, denominator: 3 }), '取得済み')
  assert.equal(surveyCellState({ kind: 'ratio', n: 3, numerator: 0, denominator: 0 }), '算出不可')
  assert.equal(surveyCellDetail({ kind: 'ratio', n: 3, numerator: 5, denominator: 23 }), '5 / 23 · n=3')
  assert.equal(surveyCellDetail({ kind: 'median', n: 0, value: null }), 'n=0')
  assert.equal(surveyCellDetail(undefined), null)
})
test('period and mode choices identify concrete independent datasets', () => {
  const dataset: SampleSurveyInsightDataset = { theme: 'activity', target: 'lp', period: { kind: 'act', act: 9 }, mode: 'rank', capturedAt: { start: '', end: '' }, coverage: [], rows: [] }
  assert.equal(surveyConditionLabel(dataset), 'Act 9 · ランクマッチ')
  const first = surveyConditionKey(dataset)
  dataset.mode = 'casual'
  assert.notEqual(surveyConditionKey(dataset), first)
  dataset.mode = 'rank'; dataset.period = { kind: 'lifetime' }
  assert.notEqual(surveyConditionKey(dataset), first)
  dataset.period = { kind: 'act', act: 10 }
  assert.notEqual(surveyConditionKey(dataset), first)
})
test('available metrics preserve order without inventing uncollected fields', () => {
  const dataset: SampleSurveyInsightDataset = { theme: 'activity', target: 'lp', period: { kind: 'lifetime' }, mode: 'all', capturedAt: { start: '', end: '' }, coverage: [], rows: [
    { stratumId: 'lp-MASTER', validAccounts: 3, metrics: { meanBattles: { kind: 'mean', n: 3, total: 4 } } },
    { stratumId: 'lp-DIAMOND', validAccounts: 2, metrics: { activeShare: { kind: 'ratio', n: 2, numerator: 0, denominator: 2 } } },
  ] }
  assert.deepEqual(surveyMetricKeys(dataset), ['activeShare', 'meanBattles'])
})
test('coverage labels distinguish no attempt, all failed and partial results', () => {
  assert.equal(surveyCoverageState(0, 0, 0), '未取得')
  assert.equal(surveyCoverageState(2, 0, 2), '取得失敗')
  assert.equal(surveyCoverageState(3, 2, 1), '一部欠測')
  assert.equal(surveyCoverageState(3, 3, 0), '取得済み')
})
