/** A probability fixed within this model rank; fractions are in [0, 1]. */
export interface ExpectedMatchRank {
  id: string
  minimumLp: number
  winProbability: number
  /** Overrides the configured loss magnitude for this rank. */
  lossLp?: number
  /** LP floor applied on a loss; cannot exceed this rank's minimum LP. */
  lossFloorLp?: number
  /** Additional LP, indexed by the streak after winning (0..10, capped at 10). */
  winStreakBonuses?: readonly number[]
}

export interface ExpectedMatchesConfig {
  startLp: number
  targetLp: number
  winLp: number
  /** Nonnegative magnitude of the LP removed by a loss. */
  lossLp: number
  /** Streak carried into the first match; omitted means zero. */
  startWinStreak?: number
  ranks: readonly ExpectedMatchRank[]
}

export type ExpectedMatchesFailureReason = 'invalid-input' | 'resource-limit' | 'unstable-solution'

export type ExpectedMatchesResult =
  | {
    status: 'finite'
    expectedMatches: number
    /** Number of reachable, nonabsorbing LP/streak states in the original chain. */
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
