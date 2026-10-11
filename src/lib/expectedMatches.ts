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
  winLp: 50,
  lossLp: 40,
} as const

// Bounds apply to an individual solve. A worker can run/cancel comparisons in turn.
const MAX_TARGET_LP = 25_000
const MAX_LP_CHANGE = 1_000
const MAX_MATRIX_ENTRIES = 8_000_000
const MAX_ELIMINATION_OPERATIONS = 160_000_000
const MAX_RESIDUAL_BOUND = 1e-6
export const EXPECTED_MATCH_MAX_WIN_STREAK = 10

function failure(reason: ExpectedMatchesFailureReason, stateCount = 0): ExpectedMatchesResult {
  return { status: 'numerical-failure', reason, stateCount }
}

function validConfig(config: ExpectedMatchesConfig): boolean {
  const { startLp, targetLp, winLp, lossLp, ranks } = config
  return Number.isInteger(targetLp) && targetLp > 0 && targetLp <= MAX_TARGET_LP
    && Number.isInteger(startLp) && startLp >= 0 && startLp <= targetLp
    && Number.isInteger(winLp) && winLp >= 1 && winLp <= MAX_LP_CHANGE
    && Number.isInteger(lossLp) && lossLp >= 0 && lossLp <= MAX_LP_CHANGE
    && (config.startWinStreak === undefined || Number.isInteger(config.startWinStreak)
      && config.startWinStreak >= 0 && config.startWinStreak <= EXPECTED_MATCH_MAX_WIN_STREAK)
    && ranks.length > 0 && ranks[0].minimumLp === 0
    && ranks.every((rank, index) => Number.isInteger(rank.minimumLp)
      && rank.minimumLp >= 0 && rank.minimumLp < targetLp
      && (index === 0 || rank.minimumLp > ranks[index - 1].minimumLp)
      && Number.isFinite(rank.winProbability) && rank.winProbability >= 0 && rank.winProbability <= 1
      && (rank.lossLp === undefined || Number.isInteger(rank.lossLp) && rank.lossLp >= 0 && rank.lossLp <= MAX_LP_CHANGE)
      && (rank.lossFloorLp === undefined || Number.isInteger(rank.lossFloorLp)
        && rank.lossFloorLp >= 0 && rank.lossFloorLp <= rank.minimumLp)
      && (rank.winStreakBonuses === undefined || rank.winStreakBonuses.length === EXPECTED_MATCH_MAX_WIN_STREAK + 1
        && rank.winStreakBonuses.every(bonus => Number.isInteger(bonus) && bonus >= 0 && bonus <= MAX_LP_CHANGE)))
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

function withinBudget(plans: readonly { states: readonly number[]; lower: number; upper: number }[]): boolean {
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
function calculateLpOnlyExpectedMatches(config: ExpectedMatchesConfig): ExpectedMatchesResult {
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

interface StreakModel {
  stride: number
  cap: number
  target: number
  start: number
  p: Float64Array
  losses: Int32Array
  wins: Int32Array
}

function streakModel(config: ExpectedMatchesConfig): StreakModel {
  const cap = config.ranks.some(rank => rank.winStreakBonuses?.slice(1).some(bonus => bonus > 0))
    ? EXPECTED_MATCH_MAX_WIN_STREAK : 0
  const stride = cap + 1
  const p = probabilities(config.targetLp, config.ranks)
  const losses = new Int32Array(config.targetLp)
  const wins = new Int32Array(config.targetLp * stride)
  let rankIndex = 0
  for (let lp = 0; lp < config.targetLp; lp += 1) {
    if (rankIndex + 1 < config.ranks.length && lp >= config.ranks[rankIndex + 1].minimumLp) rankIndex += 1
    const rank = config.ranks[rankIndex]
    losses[lp] = Math.max(rank.lossFloorLp ?? 0, lp - (rank.lossLp ?? config.lossLp)) * stride
    for (let streak = 0; streak < stride; streak += 1) {
      const nextStreak = Math.min(cap, streak + 1)
      const nextLp = lp + config.winLp + (cap > 0 ? rank.winStreakBonuses?.[nextStreak] ?? 0 : 0)
      wins[lp * stride + streak] = nextLp >= config.targetLp
        ? config.targetLp * stride : nextLp * stride + nextStreak
    }
  }
  return {
    stride, cap, target: config.targetLp * stride,
    start: config.startLp * stride + Math.min(cap, config.startWinStreak ?? 0), p, losses, wins,
  }
}

interface StateGraph {
  states: number[]
  canAbsorb: boolean
  reverseHead: Int32Array
  reverseFrom: Int32Array
  reverseNext: Int32Array
}

/** The full chain is retained for reachability and the final residual check. */
function streakGraph(model: StreakModel): StateGraph {
  const { start, target, stride, p, wins, losses } = model
  const seen = new Uint8Array(target + 1)
  const states = [start]
  const reverseHead = new Int32Array(target + 1).fill(-1)
  const reverseFrom = new Int32Array(2 * target)
  const reverseNext = new Int32Array(2 * target)
  let edgeCount = 0
  seen[start] = 1
  for (let index = 0; index < states.length; index += 1) {
    const state = states[index]
    const lp = Math.floor(state / stride)
    const successors = [
      ...(p[lp] > 0 ? [wins[state]] : []),
      ...(p[lp] < 1 ? [losses[lp]] : []),
    ]
    for (const next of successors) {
      reverseFrom[edgeCount] = state
      reverseNext[edgeCount] = reverseHead[next]
      reverseHead[next] = edgeCount++
      if (!seen[next]) {
        seen[next] = 1
        if (next !== target) states.push(next)
      }
    }
  }
  const reachesTarget = new Uint8Array(target + 1)
  const queue = [target]
  reachesTarget[target] = 1
  for (let index = 0; index < queue.length; index += 1) {
    for (let edge = reverseHead[queue[index]]; edge !== -1; edge = reverseNext[edge]) {
      const previous = reverseFrom[edge]
      if (!reachesTarget[previous]) {
        reachesTarget[previous] = 1
        queue.push(previous)
      }
    }
  }
  return { states, canAbsorb: states.every(state => reachesTarget[state]), reverseHead, reverseFrom, reverseNext }
}

/**
 * Iterative Kosaraju traversal avoids stack overflow. Components are ordered
 * from sources to sinks, so solving in reverse order resolves every boundary.
 * This also separates arbitrary starting residues from floor-entry residues.
 */
function stateComponents(model: StreakModel, graph: StateGraph): { componentOf: Int32Array; count: number } {
  const visited = new Uint8Array(model.target)
  const order: number[] = []
  const stack: number[] = []
  const steps: number[] = []
  for (const initial of graph.states) {
    if (visited[initial]) continue
    visited[initial] = 1
    stack.push(initial)
    steps.push(0)
    while (stack.length) {
      const top = stack.length - 1
      const state = stack[top]
      const lp = Math.floor(state / model.stride)
      const step = steps[top]++
      const next = step === 0 && model.p[lp] > 0 ? model.wins[state]
        : step === 1 && model.p[lp] < 1 ? model.losses[lp] : -1
      if (step >= 2) {
        order.push(state)
        stack.pop()
        steps.pop()
      } else if (next >= 0 && next !== model.target && !visited[next]) {
        visited[next] = 1
        stack.push(next)
        steps.push(0)
      }
    }
  }
  const componentOf = new Int32Array(model.target).fill(-1)
  let count = 0
  for (let index = order.length - 1; index >= 0; index -= 1) {
    const initial = order[index]
    if (componentOf[initial] >= 0) continue
    componentOf[initial] = count
    stack.push(initial)
    while (stack.length) {
      const state = stack.pop()!
      for (let edge = graph.reverseHead[state]; edge !== -1; edge = graph.reverseNext[edge]) {
        const previous = graph.reverseFrom[edge]
        if (componentOf[previous] < 0) {
          componentOf[previous] = count
          stack.push(previous)
        }
      }
    }
    count += 1
  }
  return { componentOf, count }
}

interface ExpandedEquation {
  constant: number
  edges: { state: number; weight: number }[]
}

/**
 * E(LP,0) is expanded only until streak 10; E(LP,10) keeps its one-step
 * equation. Thus intermediate streaks disappear without an approximation or
 * an unbounded all-win expansion. Every expansion step reevaluates the rank.
 */
function expandedEquation(initial: number, model: StreakModel): ExpandedEquation {
  const edges: ExpandedEquation['edges'] = []
  let constant = 0
  let state = initial
  let survival = 1
  const singleStep = model.cap === 0 || initial % model.stride === model.cap
  while (true) {
    const lp = Math.floor(state / model.stride)
    const probability = model.p[lp]
    constant += survival
    if (probability < 1) edges.push({ state: model.losses[lp], weight: survival * (1 - probability) })
    if (probability === 0) break
    survival *= probability
    state = model.wins[state]
    if (state === model.target) break
    if (singleStep || state % model.stride === model.cap) {
      edges.push({ state, weight: survival })
      break
    }
  }
  return { constant, edges }
}

interface CompressedPlan {
  states: number[]
  equations: ExpandedEquation[]
  component: number
  lower: number
  upper: number
}

function compressedPlans(model: StreakModel, graph: StateGraph, componentOf: Int32Array): CompressedPlan[] {
  const groups = new Map<number, number[]>()
  for (const state of graph.states) {
    const streak = state % model.stride
    if (streak !== 0 && streak !== model.cap) continue
    const component = componentOf[state]
    const states = groups.get(component) ?? []
    states.push(state)
    groups.set(component, states)
  }
  const indices = new Int32Array(model.target).fill(-1)
  return [...groups.entries()].sort((a, b) => b[0] - a[0]).map(([component, states]) => {
    states.sort((a, b) => a - b)
    states.forEach((state, index) => { indices[state] = index })
    const equations = states.map(state => expandedEquation(state, model))
    let lower = 0
    let upper = 0
    equations.forEach((equation, row) => {
      for (const edge of equation.edges) {
        if (componentOf[edge.state] !== component) continue
        lower = Math.max(lower, row - indices[edge.state])
        upper = Math.max(upper, indices[edge.state] - row)
      }
    })
    return { states, equations, component, lower, upper }
  })
}

function solveCompressedBand(
  plan: CompressedPlan, indices: Int32Array, componentOf: Int32Array, expected: Float64Array,
): boolean {
  const { states, equations, component, lower, upper } = plan
  const count = states.length
  const width = lower + upper + 1
  const matrix = new Float64Array(count * width)
  const rhs = new Float64Array(count)
  states.forEach((state, index) => { indices[state] = index })
  equations.forEach((equation, row) => {
    const diagonal = row * width + lower
    matrix[diagonal] = 1
    rhs[row] = equation.constant
    for (const edge of equation.edges) {
      if (componentOf[edge.state] === component) matrix[diagonal + indices[edge.state] - row] -= edge.weight
      else rhs[row] += edge.weight * expected[edge.state]
    }
  })
  for (let column = 0; column < count; column += 1) {
    const diagonal = column * width + lower
    const pivot = matrix[diagonal]
    if (!Number.isFinite(pivot) || pivot <= Number.EPSILON * 32) return false
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
  for (let row = count - 1; row >= 0; row -= 1) {
    const diagonal = row * width + lower
    let value = rhs[row]
    for (let column = row + 1; column <= Math.min(count - 1, row + upper); column += 1) {
      value -= matrix[diagonal + column - row] * expected[states[column]]
    }
    const answer = value / matrix[diagonal]
    if (!Number.isFinite(answer) || answer < 1) return false
    expected[states[row]] = answer
  }
  return true
}

export function calculateExpectedMatches(config: ExpectedMatchesConfig): ExpectedMatchesResult {
  if (!validConfig(config)) return failure('invalid-input')
  if (config.startLp === config.targetLp) {
    return { status: 'finite', expectedMatches: 0, stateCount: 0, residualBound: 0 }
  }
  // Preserve the compact two-residue solver for its original constant LP model.
  if (config.ranks.every(rank => rank.lossLp === undefined && rank.lossFloorLp === undefined
    && !rank.winStreakBonuses?.slice(1).some(bonus => bonus > 0))) {
    return calculateLpOnlyExpectedMatches(config)
  }
  const model = streakModel(config)
  const graph = streakGraph(model)
  const stateCount = graph.states.length
  if (!graph.canAbsorb) return { status: 'infinite', reason: 'unreachable-target', stateCount }
  const { componentOf } = stateComponents(model, graph)
  const plans = compressedPlans(model, graph, componentOf)
  if (!withinBudget(plans)) return failure('resource-limit', stateCount)
  const expected = new Float64Array(model.target + 1)
  const indices = new Int32Array(model.target).fill(-1)
  for (const plan of plans) {
    if (!solveCompressedBand(plan, indices, componentOf, expected)) return failure('unstable-solution', stateCount)
  }
  for (const state of graph.states) {
    const streak = state % model.stride
    if (streak === 0 || streak === model.cap) continue
    const equation = expandedEquation(state, model)
    expected[state] = equation.constant + equation.edges.reduce((sum, edge) => sum + edge.weight * expected[edge.state], 0)
  }
  let residualBound = 0
  for (const state of graph.states) {
    const lp = Math.floor(state / model.stride)
    const winTerm = model.p[lp] > 0 ? model.p[lp] * expected[model.wins[state]] : 0
    const lossTerm = model.p[lp] < 1 ? (1 - model.p[lp]) * expected[model.losses[lp]] : 0
    const residual = Math.abs(expected[state] - winTerm - lossTerm - 1)
    const roundoff = 16 * Number.EPSILON * (expected[state] + winTerm + lossTerm + 1)
    residualBound = Math.max(residualBound, residual + roundoff)
  }
  if (!Number.isFinite(residualBound) || residualBound > MAX_RESIDUAL_BOUND) return failure('unstable-solution', stateCount)
  return { status: 'finite', expectedMatches: expected[model.start], stateCount, residualBound }
}
