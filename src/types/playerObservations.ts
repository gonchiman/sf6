export interface PlayerObservationConditions {
  league: 'all'
  character: 'max-lp'
  region: 'all'
  platform: 'all'
  users: 'all'
}

export type PlayerObservationRunStatus = 'running' | 'complete' | 'partial' | 'failed' | 'missing'
export type PlayerObservationCoverage = 'sample' | 'all-pages' | 'incomplete' | 'none'

export interface PlayerObservationRun {
  id: string
  phase: 'baseline' | 'observation'
  status: PlayerObservationRunStatus
  scope: 'probe' | 'population'
  scheduledAt: string
  startedAt: string | null
  endedAt: string | null
  observedIdCount: number | null
  newObservedCount: number | null
  newObservedLowerBound: number | null
  pages: {
    expectedAtStart: number | null
    expectedAtEnd: number | null
    succeeded: number
    failed: number
    sampledPages: number[]
  }
  coverage: PlayerObservationCoverage
  reportedTotalAtStart: number | null
  reportedTotalAtEnd: number | null
  warnings: string[]
  failureReason: string | null
}

export interface PlayerObservationDataset {
  schemaVersion: 1
  definitionVersion: 1
  seriesId: 'buckler-max-lp-v1'
  generatedAt: string
  source: {
    title: string
    url: string
    population: string
    metric: string
    unit: 'cfn-account'
    notes: string[]
  }
  conditions: PlayerObservationConditions
  baseline: {
    status: 'preparing' | 'ready'
    completedAt: string | null
  }
  runs: PlayerObservationRun[]
}

export interface PlayerObservationSelection {
  fromDate: string
  toDate: string
  status: 'all' | 'baseline' | PlayerObservationRunStatus
}
