import { rankBoundaryPageUrl, RANK_BOUNDARY_SOURCE_URL } from './rank-distribution-boundaries.ts'

/** The probe never accepts a caller-provided target or publishes authentication URLs. */
export const BUCKLER_AUTH_PROBE_URL = rankBoundaryPageUrl(RANK_BOUNDARY_SOURCE_URL, 1)

export interface BucklerAuthProbeObservation {
  maintenance: boolean
  loginRequired: boolean
  /** True requires signed-in UI, false requires explicit anonymous UI, and null means unconfirmed. */
  signedIn: boolean | null
  rankingRows: number | null
  visibleCounters: { from: number; to: number; total: number } | null
  controlMatches: boolean | null
  /** The transport confirms the loaded fixed URL and first page independently of this core. */
  pageConfirmed: boolean | null
}

export type BucklerAuthProbePhase = 'initial' | 'reuse'
export type BucklerAuthProbeStatus = 'maintenance' | 'login-required' | 'unsupported-dom'
  | 'condition-mismatch' | 'signed-in-readable' | 'anonymous-readable' | 'auth-unconfirmed-readable' | 'timeout' | 'read-failed'

export interface BucklerAuthProbePhaseResult {
  status: BucklerAuthProbeStatus
  signedIn: boolean | null
  rankingRows: number | null
  totalCount: number | null
  controlMatches: boolean | null
  pageConfirmed: boolean | null
}

export interface BucklerAuthProbeReport {
  schemaVersion: 1
  fixedSource: string
  startedAt: string
  endedAt: string
  status: BucklerAuthProbeStatus
  initial: BucklerAuthProbePhaseResult
  reuse: BucklerAuthProbePhaseResult | null
  sameSessionReuse: 'confirmed' | 'not-confirmed' | 'not-tested'
  /** A live counter change does not by itself imply authentication failure. */
  totalsMatch: boolean | null
  separateLaunchReuse: 'not-tested'
  automaticLogin: 'not-tested'
  cloudAuthentication: 'not-tested'
  sessionLifetime: 'not-tested'
}

export interface BucklerAuthProbeOptions {
  /** Called once initially and, only after signed-in success, once in a new tab of the same context. */
  readPage: (phase: BucklerAuthProbePhase, fixedUrl: string) => Promise<BucklerAuthProbeObservation>
  now?: () => Date
}

/** Transports map timeouts here without propagating raw browser errors or URL-bearing messages. */
export class BucklerAuthProbeReadError extends Error {
  readonly status: 'timeout' | 'read-failed'

  constructor(status: 'timeout' | 'read-failed') {
    super(status === 'timeout' ? '表示の確認が時間内に完了しませんでした。' : '表示を確認できませんでした。')
    this.name = 'BucklerAuthProbeReadError'
    this.status = status === 'timeout' ? 'timeout' : 'read-failed'
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function nullableBoolean(value: unknown): value is boolean | null {
  return value === null || typeof value === 'boolean'
}

function emptyResult(status: BucklerAuthProbeStatus): BucklerAuthProbePhaseResult {
  return { status, signedIn: null, rankingRows: null, totalCount: null, controlMatches: null, pageConfirmed: null }
}

/** Only enum values, valid counts and booleans leave this function. Extra DOM fields are never copied. */
export function classifyBucklerAuthProbeObservation(value: unknown): BucklerAuthProbePhaseResult {
  const input = record(value)
  if (!input) return emptyResult('unsupported-dom')
  // Maintenance/login gates take precedence over stale rows or a cached profile header.
  if (input.maintenance === true) return emptyResult('maintenance')
  if (input.loginRequired === true) return emptyResult('login-required')
  if (input.maintenance !== false || input.loginRequired !== false || !nullableBoolean(input.signedIn)
    || !nullableBoolean(input.controlMatches) || !nullableBoolean(input.pageConfirmed)) return emptyResult('unsupported-dom')
  const state = { signedIn: input.signedIn, controlMatches: input.controlMatches, pageConfirmed: input.pageConfirmed }
  if (input.controlMatches === false || input.pageConfirmed === false) return { ...emptyResult('condition-mismatch'), ...state }
  if (input.controlMatches === null || input.pageConfirmed === null) return { ...emptyResult('unsupported-dom'), ...state }
  const counters = record(input.visibleCounters)
  if (!positiveInteger(input.rankingRows) || input.rankingRows > 20 || !counters
    || counters.from !== 1 || counters.to !== input.rankingRows || !positiveInteger(counters.total)
    || counters.total < input.rankingRows || input.rankingRows !== Math.min(20, counters.total)) {
    return { ...emptyResult('unsupported-dom'), ...state }
  }
  return {
    status: input.signedIn === true ? 'signed-in-readable' : input.signedIn === false ? 'anonymous-readable' : 'auth-unconfirmed-readable',
    ...state, rankingRows: input.rankingRows, totalCount: counters.total,
  }
}

function safeDate(clock: () => Date): string {
  const value = clock()
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error('検証日時を確認できません。')
  // Use the Date's numeric value; no arbitrary formatter output is stored.
  return new Date(value.getTime()).toISOString()
}

/**
 * Probe visible page readability and same-run session reuse only. No credentials,
 * persisted browser state, network transport, ranking collection or public updates.
 */
export async function runBucklerAuthProbe(options: BucklerAuthProbeOptions): Promise<BucklerAuthProbeReport> {
  const clock = options.now ?? (() => new Date())
  const startedAt = safeDate(clock)
  async function read(phase: BucklerAuthProbePhase): Promise<BucklerAuthProbePhaseResult> {
    try { return classifyBucklerAuthProbeObservation(await options.readPage(phase, BUCKLER_AUTH_PROBE_URL)) } catch (error) {
      return emptyResult(error instanceof BucklerAuthProbeReadError && error.status === 'timeout' ? 'timeout' : 'read-failed')
    }
  }
  const initial = await read('initial')
  const reuse = initial.status === 'signed-in-readable' ? await read('reuse') : null
  const endedAt = safeDate(clock)
  if (Date.parse(endedAt) < Date.parse(startedAt)) throw new Error('検証日時の順序を確認できません。')
  return {
    schemaVersion: 1, fixedSource: BUCKLER_AUTH_PROBE_URL, startedAt, endedAt,
    status: reuse?.status ?? initial.status, initial, reuse,
    sameSessionReuse: reuse === null ? 'not-tested' : reuse.status === 'signed-in-readable' ? 'confirmed' : 'not-confirmed',
    totalsMatch: reuse?.totalCount === null || reuse === null ? null : reuse.totalCount === initial.totalCount,
    separateLaunchReuse: 'not-tested', automaticLogin: 'not-tested', cloudAuthentication: 'not-tested', sessionLifetime: 'not-tested',
  }
}
