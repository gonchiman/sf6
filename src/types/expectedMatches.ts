/** A probability fixed within this model rank; fractions are in [0, 1]. */
export interface ExpectedMatchRank {
  id: string
  minimumLp: number
  winProbability: number
}

export interface ExpectedMatchesConfig {
  startLp: number
  targetLp: number
  winLp: number
  /** Nonnegative magnitude of the LP removed by a loss. */
  lossLp: number
  ranks: readonly ExpectedMatchRank[]
}

export type ExpectedMatchesFailureReason = 'invalid-input' | 'resource-limit' | 'unstable-solution'

export type ExpectedMatchesResult =
  | {
    status: 'finite'
    expectedMatches: number
    /** Number of reachable, nonabsorbing LP states used in the calculation. */
    stateCount: number
    /** Absolute Bellman residual, including a bound for evaluation roundoff. */
    residualBound: number
  }
  | {
    status: 'infinite'
    reason: 'unreachable-target'
    stateCount: number
  }
  | {
    status: 'numerical-failure'
    reason: ExpectedMatchesFailureReason
    stateCount: number
  }
