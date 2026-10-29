import test from 'node:test'
import assert from 'node:assert/strict'
import { sampleSurveyBarAxis, sampleSurveyBarNumber, sampleSurveyBarValue } from './sampleSurveyBarChart.ts'

test('bar values preserve zero and reject missing, nonfinite, negative and impossible percentages', () => {
  assert.equal(sampleSurveyBarValue(0), 0)
  assert.equal(sampleSurveyBarValue(-0), 0)
  assert.equal(sampleSurveyBarValue(null), null)
  assert.equal(sampleSurveyBarValue(-1), null)
  assert.equal(sampleSurveyBarValue(Infinity), null)
  assert.equal(sampleSurveyBarValue(NaN), null)
  assert.equal(sampleSurveyBarValue(100, true), 100)
  assert.equal(sampleSurveyBarValue(101, true), null)
  assert.equal(sampleSurveyBarValue(101), 101)
})

test('percentage comparisons retain a common 0–100 scale, even when values are small', () => {
  assert.deepEqual(sampleSurveyBarAxis([.1, .2, null], true), { maximum: 100, ticks: [0, 50, 100] })
})

test('decimal, empty and very large bar axes remain finite and include every observation', () => {
  for (const values of [[null], [0], [.0013, .004], [2.3, 4.7], [108830.9], [Number.MAX_VALUE], [Number.MIN_VALUE]]) {
    const axis = sampleSurveyBarAxis(values)
    assert.ok(axis.maximum > 0 && Number.isFinite(axis.maximum))
    assert.equal(axis.ticks[0], 0)
    assert.equal(axis.ticks.at(-1), axis.maximum)
    for (const value of values) if (value !== null) assert.ok(value <= axis.maximum)
  }
})

test('small positive measurements are never labelled as zero', () => {
  assert.equal(sampleSurveyBarNumber(0), '0')
  assert.notEqual(sampleSurveyBarNumber(.00001), '0')
  assert.notEqual(sampleSurveyBarNumber(.001), '0')
  assert.equal(sampleSurveyBarNumber(108830.94), '108,830.9')
})
