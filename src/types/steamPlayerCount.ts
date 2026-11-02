export type SteamPlayerCountAppId = 1364780 | 1778820 | 1384160 | 2157560 | 1498570

export interface SteamPlayerCountGame {
  readonly key: 'sf6' | 'tekken-8' | 'ggst' | 'gbvsr' | 'kof-xv'
  readonly appId: SteamPlayerCountAppId
  readonly label: string
  readonly sourceUrl: string
  readonly historyPath: string
  readonly bundledPath: string
}

export interface SteamPlayerCountObservation {
  id: string
  requestStartedAt: string
  observedAt: string
  playerCount: number
  runId: string | null
  runAttempt: number | null
}

export interface SteamPlayerCountDay {
  schemaVersion: 1
  appId: SteamPlayerCountAppId
  date: string
  observations: SteamPlayerCountObservation[]
}

export interface SteamPlayerCountDayDescriptor {
  date: string
  path: string
  sha256: string
  observationCount: number
  firstObservedAt: string
  lastObservedAt: string
}

export interface SteamPlayerCountManifest {
  schemaVersion: 1
  appId: SteamPlayerCountAppId
  sourceUrl: string
  generatedAt: string
  days: SteamPlayerCountDayDescriptor[]
}

export interface SteamPlayerCountDateRange { from: string; to: string }
export type SteamPlayerCountDayType = 'all' | 'weekday' | 'weekend'

export interface SteamPlayerCountHourlyRow {
  hour: number
  mean: number | null
  validDays: number
  totalDays: number
  observedSlots: number
  expectedSlots: number
}
