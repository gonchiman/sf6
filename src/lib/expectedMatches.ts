import type {
  ExpectedMatchRank,
  ExpectedMatchesConfig,
  ExpectedMatchesFailureReason,
  ExpectedMatchesResult,
} from '../types/expectedMatches.ts'

/** Configurable assumptions of the simplified model, not verified game rules. */
export const EXPECTED_MATCH_RANK_THRESHOLDS = [
  { id: 'ROOKIE', minimumLp: 0 },
  { id: 'IRON', minimumLp: 1_000 },
  { id: 'BRONZE', minimumLp: 3_000 },
  { id: 'SILVER', minimumLp: 5_000 },
  { id: 'GOLD', minimumLp: 9_000 },
  { id: 'PLATINUM', minimumLp: 13_000 },
  { id: 'DIAMOND', minimumLp: 19_000 },
] as const

export const DEFAULT_EXPECTED_MATCH_MODEL = {
  startLp: 0,
  targetLp: 25_000,
  winLp: 60,
  lossLp: 40,
} as const

// Bounds apply to an individual solve. A worker can run/cancel comparisons in turn.
const MAX_TARGET_LP = 25_000
const MAX_LP_CHANGE = 1_000
const MAX_MATRIX_ENTRIES = 8_000_000
const MAX_ELIMINATION_OPERATIONS = 160_000_000
const MAX_RESIDUAL_BOUND = 1e-6

function failure(reason: ExpectedMatchesFailureReason, stateCount = 0): ExpectedMatchesResult {
  return { status: 'numerical-failure', reason, stateCount }
}

function validConfig(config: ExpectedMatchesConfig): boolean {
  const { startLp, targetLp, winLp, lossLp, ranks } = config
  return Number.isInteger(targetLp) && targetLp > 0 && targetLp <= MAX_TARGET_LP
    && Number.isInteger(startLp) && startLp >= 0 && startLp <= targetLp
    && Number.isInteger(winLp) && winLp >= 1 && winLp <= MAX_LP_CHANGE
    && Number.isInteger(lossLp) && lossLp >= 0 && lossLp <= MAX_LP_CHANGE
    && ranks.length > 0 && ranks[0].minimumLp === 0
    && ranks.every((rank, index) => Number.isInteger(rank.minimumLp)
      && rank.minimumLp >= 0 && rank.minimumLp < targetLp
      && (index === 0 || rank.minimumLp > ranks[index - 1].minimumLp)
      && Number.isFinite(rank.winProbability) && rank.winProbability >= 0 && rank.winProbability <= 1)
}

function gcd(a: number, b: number): number {
  while (b) [a, b] = [b, a % b]
  return a
}

function probabilities(targetLp: number, ranks: readonly ExpectedMatchRank[]): Float64Array {
  const values = new Float64Array(targetLp)
  let rankIndex = 0
  for (let lp = 0; lp < targetLp; lp += 1) {
    if (rankIndex + 1 < ranks.length && lp >= ranks[rankIndex + 1].minimumLp) rankIndex += 1
    values[lp] = ranks[rankIndex].winProbability
  }
  return values
}

interface ReachableGraph {
  states: number[]
  canAbsorb: boolean
}

/** Edges with zero probability are omitted: unreachable traps must not make a solve singular. */
function reachableGraph(config: ExpectedMatchesConfig, p: Float64Array): ReachableGraph {
  const { startLp, targetLp, winLp, lossLp } = config
  const seen = new Uint8Array(targetLp + 1)
  const states: number[] = [startLp]
  const reverseHead = new Int32Array(targetLp + 1).fill(-1)
  const reverseFrom = new Int32Array(2 * targetLp)
  const reverseNext = new Int32Array(2 * targetLp)
  let edgeCount = 0
  seen[startLp] = 1

  for (let index = 0; index < states.length; index += 1) {
    const lp = states[index]
    const successors = [
      ...(p[lp] > 0 ? [Math.min(targetLp, lp + winLp)] : []),
      ...(p[lp] < 1 ? [Math.max(0, lp - lossLp)] : []),
    ]
    for (const next of successors) {
      reverseFrom[edgeCount] = lp
      reverseNext[edgeCount] = reverseHead[next]
      reverseHead[next] = edgeCount++
      if (!seen[next]) {
        seen[next] = 1
        if (next !== targetLp) states.push(next)
      }
    }
  }

  // A finite state chain has finite mean absorption time iff every reachable
  // transient state has a path to the target (no reachable closed class).
  const reachesTarget = new Uint8Array(targetLp + 1)
  const queue = [targetLp]
  reachesTarget[targetLp] = 1
  for (let index = 0; index < queue.length; index += 1) {
    for (let edge = reverseHead[queue[index]]; edge !== -1; edge = reverseNext[edge]) {
      const previous = reverseFrom[edge]
      if (!reachesTarget[previous]) {
        reachesTarget[previous] = 1
        queue.push(previous)
      }
    }
  }
  return { states: states.sort((a, b) => a - b), canAbsorb: states.every((lp) => reachesTarget[lp]) }
}

interface BandPlan {
  states: number[]
  indices: Int32Array
  lower: number
  upper: number
}

function bandPlan(states: number[], config: ExpectedMatchesConfig, p: Float64Array): BandPlan {
  const indices = new Int32Array(config.targetLp).fill(-1)
  states.forEach((lp, index) => { indices[lp] = index })
  let lower = 0
  let upper = 0
  states.forEach((lp, index) => {
    if (p[lp] > 0 && lp + config.winLp < config.targetLp) {
      upper = Math.max(upper, indices[lp + config.winLp] - index)
    }
    const loss = Math.max(0, lp - config.lossLp)
    if (p[lp] < 1 && indices[loss] >= 0) lower = Math.max(lower, index - indices[loss])
  })
  return { states, indices, lower, upper }
}

function withinBudget(plans: BandPlan[]): boolean {
  let operations = 0
  for (const { states, lower, upper } of plans) {
    if (states.length * (lower + upper + 1) > MAX_MATRIX_ENTRIES) return false
    operations += states.length * Math.max(1, lower) * Math.max(1, upper)
  }
  return operations <= MAX_ELIMINATION_OPERATIONS
}

/** No-pivot elimination of a nonsingular M-matrix preserves its band. */
function solveBand(
  plan: BandPlan,
  config: ExpectedMatchesConfig,
  p: Float64Array,
  expectedAtFloor: number,
): Float64Array | null {
  const { states, indices, lower, upper } = plan
  const count = states.length
  const width = lower + upper + 1
  const matrix = new Float64Array(count * width)
  const rhs = new Float64Array(count).fill(1)
  for (let index = 0; index < count; index += 1) {
    const lp = states[index]
    const diagonal = index * width + lower
    matrix[diagonal] = 1
    const win = Math.min(config.targetLp, lp + config.winLp)
    if (p[lp] > 0 && win < config.targetLp) matrix[diagonal + indices[win] - index] -= p[lp]
    const loss = Math.max(0, lp - config.lossLp)
    if (p[lp] < 1) {
      if (indices[loss] >= 0) matrix[diagonal + indices[loss] - index] -= 1 - p[lp]
      else rhs[index] += (1 - p[lp]) * expectedAtFloor
    }
  }

  for (let column = 0; column < count; column += 1) {
    const diagonal = column * width + lower
    const pivot = matrix[diagonal]
    if (!Number.isFinite(pivot) || pivot <= Number.EPSILON * 32) return null
    const lastRow = Math.min(count - 1, column + lower)
    const lastColumn = Math.min(count - 1, column + upper)
    for (let row = column + 1; row <= lastRow; row += 1) {
      const rowOffset = row * width + lower - row
      const entry = matrix[rowOffset + column]
      if (entry === 0) continue
      const factor = entry / pivot
      matrix[rowOffset + column] = 0
      for (let nextColumn = column + 1; nextColumn <= lastColumn; nextColumn += 1) {
        matrix[rowOffset + nextColumn] -= factor * matrix[diagonal + nextColumn - column]
      }
      rhs[row] -= factor * rhs[column]
    }
  }

  const solution = new Float64Array(count)
  for (let row = count - 1; row >= 0; row -= 1) {
    const diagonal = row * width + lower
    let value = rhs[row]
    for (let column = row + 1; column <= Math.min(count - 1, row + upper); column += 1) {
      value -= matrix[diagonal + column - row] * solution[column]
    }
    solution[row] = value / matrix[diagonal]
    if (!Number.isFinite(solution[row]) || solution[row] < 1) return null
  }
  return solution
}

/**
 * Exact state transitions for first arrival at targetLp, with a reflecting floor
 * at zero and fixed independent win probability within each model rank.
 * This is a deterministic linear solve, not a simulation or an LP/drift quotient.
 */
export function calculateExpectedMatches(config: ExpectedMatchesConfig): ExpectedMatchesResult {
  if (!validConfig(config)) return failure('invalid-input')
  if (config.startLp === config.targetLp) {
    return { status: 'finite', expectedMatches: 0, stateCount: 0, residualBound: 0 }
  }
  const p = probabilities(config.targetLp, config.ranks)
  const graph = reachableGraph(config, p)
  const stateCount = graph.states.length
  if (!graph.canAbsorb) return { status: 'infinite', reason: 'unreachable-target', stateCount }

  // From an arbitrary start there are at most two residues modulo gcd(W,L):
  // the starting residue and residue zero, entered only by a loss at the floor.
  // Solve residue zero first; its E(0) is the boundary value for the other track.
  const step = gcd(config.winLp, config.lossLp)
  const canonical = graph.states.filter((lp) => lp % step === 0)
  const offset = graph.states.filter((lp) => lp % step !== 0)
  const plans = [canonical, offset].filter((states) => states.length > 0)
    .map((states) => bandPlan(states, config, p))
  if (!withinBudget(plans)) return failure('resource-limit', stateCount)

  const expected = new Float64Array(config.targetLp + 1)
  for (const plan of plans) {
    const values = solveBand(plan, config, p, expected[0])
    if (!values) return failure('unstable-solution', stateCount)
    plan.states.forEach((lp, index) => { expected[lp] = values[index] })
  }

  let residualBound = 0
  for (const lp of graph.states) {
    const winTerm = p[lp] * expected[Math.min(config.targetLp, lp + config.winLp)]
    const lossTerm = (1 - p[lp]) * expected[Math.max(0, lp - config.lossLp)]
    const residual = Math.abs(expected[lp] - winTerm - lossTerm - 1)
    const roundoff = 16 * Number.EPSILON * (expected[lp] + winTerm + lossTerm + 1)
    residualBound = Math.max(residualBound, residual + roundoff)
  }
  // For A=I-Q, A^-1 is nonnegative and E=A^-1*1. An absolute residual r
  // therefore bounds each state's relative forward error by r/(1-r), unlike
  // a scale-normalized residual that can accept arbitrarily ill-conditioned E.
  if (!Number.isFinite(residualBound) || residualBound > MAX_RESIDUAL_BOUND) {
    return failure('unstable-solution', stateCount)
  }
  return { status: 'finite', expectedMatches: expected[config.startLp], stateCount, residualBound }
}
