import assert from 'node:assert/strict'
import { test } from 'node:test'
import { calculateExpectedMatches, DEFAULT_EXPECTED_MATCH_MODEL, EXPECTED_MATCH_RANK_THRESHOLDS } from './expectedMatches.ts'
import type { ExpectedMatchesConfig, ExpectedMatchesResult } from '../types/expectedMatches.ts'

function constantConfig(targetLp: number, winProbability: number, startLp = 0): ExpectedMatchesConfig {
  return { targetLp, startLp, winLp: 1, lossLp: 1, ranks: [{ id: 'all', minimumLp: 0, winProbability }] }
}

function finite(result: ExpectedMatchesResult): number {
  assert.equal(result.status, 'finite', JSON.stringify(result))
  if (result.status !== 'finite') throw new Error('Expected a finite mean')
  assert.ok(result.residualBound <= 1e-6)
  return result.expectedMatches
}

function close(actual: number, expected: number, tolerance = 1e-9): void {
  assert.ok(Math.abs(actual - expected) <= tolerance * Math.max(1, Math.abs(expected)), `${actual} ≠ ${expected}`)
}

// A small, generic dense partial-pivot solver is an independent oracle. It uses
// every integer LP, so it catches reachability/residue compression mistakes.
function denseMean(config: ExpectedMatchesConfig): number {
  const n = config.targetLp
  const rows = Array.from({ length: n }, (_, lp) => {
    const row = new Float64Array(n + 1)
    const rank = config.ranks.findLast((candidate) => candidate.minimumLp <= lp)!
    const p = rank.winProbability
    row[lp] = 1
    if (lp + config.winLp < n) row[lp + config.winLp] -= p
    row[Math.max(0, lp - config.lossLp)] -= 1 - p
    row[n] = 1
    return row
  })
  for (let column = 0; column < n; column += 1) {
    let pivot = column
    for (let row = column + 1; row < n; row += 1) {
      if (Math.abs(rows[row][column]) > Math.abs(rows[pivot][column])) pivot = row
    }
    ;[rows[pivot], rows[column]] = [rows[column], rows[pivot]]
    for (let row = column + 1; row < n; row += 1) {
      const factor = rows[row][column] / rows[column][column]
      for (let index = column; index <= n; index += 1) rows[row][index] -= factor * rows[column][index]
    }
  }
  const answer = new Float64Array(n)
  for (let row = n - 1; row >= 0; row -= 1) {
    let value = rows[row][n]
    for (let column = row + 1; column < n; column += 1) value -= rows[row][column] * answer[column]
    answer[row] = value / rows[row][row]
  }
  return answer[config.startLp]
}

test('model defaults are explicit assumptions and probability is not invented', () => {
  assert.deepEqual(DEFAULT_EXPECTED_MATCH_MODEL, { startLp: 0, targetLp: 25_000, winLp: 60, lossLp: 40 })
  assert.deepEqual(EXPECTED_MATCH_RANK_THRESHOLDS.map((rank) => rank.minimumLp), [0, 1_000, 3_000, 5_000, 9_000, 13_000, 19_000])
  assert.equal('ranks' in DEFAULT_EXPECTED_MATCH_MODEL, false)
})

test('first arrival is zero at the target and wins clamp overshoot to the target', () => {
  assert.equal(finite(calculateExpectedMatches(constantConfig(13, 0, 13))), 0)
  assert.equal(finite(calculateExpectedMatches({ ...constantConfig(13, 1, 2), winLp: 4, lossLp: 3 })), 3)
})

test('symmetric unit random walk with a reflecting floor has its analytic quadratic mean', () => {
  for (const startLp of [0, 1, 3, 9]) {
    const targetLp = 10
    close(finite(calculateExpectedMatches(constantConfig(targetLp, 0.5, startLp))),
      targetLp * (targetLp + 1) - startLp * (startLp + 1))
  }
})

test('negative drift can still have a finite mean under a reflecting floor', () => {
  // At p=1/4, E(i)-E(i+1)=2*(3^(i+1)-1); sum i=0..7 gives 19664.
  close(finite(calculateExpectedMatches(constantConfig(8, 0.25))), 19_664)
})

test('rank thresholds apply at equality and losses can cross back to a previous rank', () => {
  const config: ExpectedMatchesConfig = {
    ...constantConfig(3, 1),
    ranks: [
      { id: 'low', minimumLp: 0, winProbability: 1 },
      { id: 'middle', minimumLp: 1, winProbability: 0.5 },
      { id: 'high', minimumLp: 2, winProbability: 1 },
    ],
  }
  // E2=1, E0=1+E1, E1=1+(E2+E0)/2, giving E0=5.
  close(finite(calculateExpectedMatches(config)), 5)
})

test('zero LP loss gives a sum of geometric waiting times and still detects zero-probability traps', () => {
  const config: ExpectedMatchesConfig = {
    ...constantConfig(13, 0.25, 2), winLp: 4, lossLp: 0,
    ranks: [
      { id: 'low', minimumLp: 0, winProbability: 0.25 },
      { id: 'high', minimumLp: 6, winProbability: 0.5 },
    ],
  }
  close(finite(calculateExpectedMatches(config)), 4 + 2 + 2)
  assert.equal(calculateExpectedMatches({ ...config, ranks: [{ id: 'all', minimumLp: 0, winProbability: 0 }] }).status, 'infinite')
})

test('arbitrary starting residue, floor losses, rank crossings and overshoot match dense integer states', () => {
  for (const [winLp, lossLp] of [[6, 4], [4, 6], [5, 3], [6, 6], [13, 2]]) {
    for (const startLp of [0, 1, 3, 7, 18]) {
      const config: ExpectedMatchesConfig = {
        startLp, targetLp: 19, winLp, lossLp,
        ranks: [
          { id: 'a', minimumLp: 0, winProbability: 0.45 },
          { id: 'b', minimumLp: 5, winProbability: 0.55 },
          { id: 'c', minimumLp: 11, winProbability: 0.7 },
        ],
      }
      close(finite(calculateExpectedMatches(config)), denseMean(config))
    }
  }
})

test('a reachable closed loss class makes the mean infinite even when some paths reach the target', () => {
  const config: ExpectedMatchesConfig = {
    ...constantConfig(10, 0, 6), winLp: 3, lossLp: 4,
    ranks: [
      { id: 'trap', minimumLp: 0, winProbability: 0 },
      { id: 'upper', minimumLp: 5, winProbability: 0.5 },
    ],
  }
  assert.equal(calculateExpectedMatches(config).status, 'infinite')
  assert.equal(calculateExpectedMatches(constantConfig(10, 0)).status, 'infinite')
})

test('unreachable traps and zero-probability edges do not invalidate a finite calculation', () => {
  close(finite(calculateExpectedMatches({
    ...constantConfig(10, 0, 6), winLp: 3, lossLp: 4,
    ranks: [
      { id: 'trap', minimumLp: 0, winProbability: 0 },
      { id: 'upper', minimumLp: 5, winProbability: 1 },
    ],
  })), 2)
  close(finite(calculateExpectedMatches({
    ...constantConfig(10, 1), winLp: 5,
    ranks: [
      { id: 'low', minimumLp: 0, winProbability: 1 },
      { id: 'skipped-trap', minimumLp: 4, winProbability: 0 },
      { id: 'high', minimumLp: 5, winProbability: 1 },
    ],
  })), 2)
})

test('mathematically finite but ill-conditioned means are not labeled infinite or displayed as reliable', () => {
  assert.deepEqual(calculateExpectedMatches(constantConfig(50, 0.1)), {
    status: 'numerical-failure', reason: 'unstable-solution', stateCount: 50,
  })
})

test('large coprime steps fail the resource budget without approximate LP snapping', () => {
  const result = calculateExpectedMatches({ ...constantConfig(25_000, 0.5), winLp: 999, lossLp: 1_000 })
  assert.equal(result.status, 'numerical-failure')
  if (result.status === 'numerical-failure') assert.equal(result.reason, 'resource-limit')
})

test('ordinary default-size comparisons solve a compact reachable graph accurately', () => {
  const config: ExpectedMatchesConfig = {
    ...DEFAULT_EXPECTED_MATCH_MODEL,
    startLp: 13_017,
    ranks: EXPECTED_MATCH_RANK_THRESHOLDS.map((rank) => ({ ...rank, winProbability: 0.5 })),
  }
  const result = calculateExpectedMatches(config)
  const mean = finite(result)
  assert.ok(mean > (25_000 - config.startLp) / 60)
  assert.ok(mean < 2_000)
  if (result.status === 'finite') assert.ok(result.stateCount <= 2_500)
})

test('invalid model parameters remain distinct from mathematical infinity', () => {
  for (const change of [
    { startLp: -1 }, { startLp: 11 }, { startLp: 0.5 }, { targetLp: 25_001 },
    { winLp: 0 }, { winLp: 1_001 }, { lossLp: -1 }, { lossLp: 1.5 },
    { ranks: [] }, { ranks: [{ id: 'bad', minimumLp: 1, winProbability: 0.5 }] },
    { ranks: [{ id: 'bad', minimumLp: 0, winProbability: -0.1 }] },
    { ranks: [{ id: 'bad', minimumLp: 0, winProbability: Number.NaN }] },
    { ranks: [{ id: 'a', minimumLp: 0, winProbability: 0.5 }, { id: 'b', minimumLp: 0, winProbability: 0.5 }] },
  ]) {
    assert.deepEqual(calculateExpectedMatches({ ...constantConfig(10, 0.5), ...change }), {
      status: 'numerical-failure', reason: 'invalid-input', stateCount: 0,
    })
  }
})
