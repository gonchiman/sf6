import { createHash, randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { parseSampleSurveyPlan, parseSampleSurveyRun, SAMPLE_SURVEY_INTERVAL_MS, SAMPLE_SURVEY_MAX_CHANGES, SAMPLE_SURVEY_MR_BANDS, SAMPLE_SURVEY_RANKS } from '../../src/lib/sampleSurvey.ts'
import type { SampleSurveyChange, SampleSurveyConfig, SampleSurveyError, SampleSurveyPlan, SampleSurveyRun, SampleSurveyStratumObservation, SampleSurveyTarget } from '../../src/types/sampleSurvey.ts'
import { SampleSurveyReadError } from './sample-survey-reader.ts'
import type { SampleSurveyPage, SampleSurveyReader } from './sample-survey-reader.ts'

export { SAMPLE_SURVEY_INTERVAL_MS }
const INITIAL_BOUNDARY_REFINEMENTS = 2
export interface SampleSurveyStratumDefinition {
  id: string; label: string; target: SampleSurveyTarget; requested: number; minimum: number; maximum: number | null
}
export function sampleSurveyStratumDefinitions(config: SampleSurveyConfig): SampleSurveyStratumDefinition[] {
  return [
    ...SAMPLE_SURVEY_RANKS.flatMap((rank, index) => config.ranks.includes(rank) ? [{ id: `lp-${rank}`, label: rank, target: 'lp' as const,
      requested: config.rankSampleSize, minimum: index === 7 ? 36 : index * 5 + 1, maximum: index === 7 ? 37 : index * 5 + 6 }] : []),
    ...(config.includeMr ? SAMPLE_SURVEY_MR_BANDS.map(({ id, label, min: minimum, max: maximum }) => ({ id, label, target: 'mr' as const, requested: config.mrSampleSize, minimum, maximum })) : []),
  ]
}
export interface SampleSurveyFrame {
  target: SampleSurveyTarget; totalCount: number; pageSize: number; totalPages: number; checkedAt: string
  ranges: { stratumId: string; start: number; end: number }[]
}
export interface SampleSurveySlot {
  id: string; target: SampleSurveyTarget; stratumId: string; position: number; page: number; rowIndex: number
  status: 'pending' | 'collected' | 'missing' | 'duplicate'
  accountId: string | null; value: number | null; rankId: number | null; observedAt: string | null
  reason: 'stratum-changed' | 'duplicate' | 'page-unavailable' | null
}
/** Private checkpoint. Only its `report` may cross the local service boundary. */
export interface SampleSurveyCheckpoint {
  schemaVersion: 1 | 2; plan: SampleSurveyPlan; report: SampleSurveyRun; frames: SampleSurveyFrame[]; slots: SampleSurveySlot[]
}

/** A concrete Act identity is not yet available, so observed MR rows cannot cross a restart. */
export function canResumeSampleSurvey(checkpoint: SampleSurveyCheckpoint): boolean {
  return checkpoint.schemaVersion === 2 && checkpoint.report.schemaVersion === 2 && ['stopped', 'error'].includes(checkpoint.report.state)
    && ['cancelled', 'limit-reached', 'interrupted'].includes(checkpoint.report.stopReason ?? '')
    && !checkpoint.slots.some(slot => slot.target === 'mr' && slot.status !== 'pending')
}

function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): value is number {
  return Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max
}
function utc(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
}
function fail(): never { throw new SampleSurveyReadError('invalid-request') }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail()
  return value as Record<string, unknown>
}

/** Validates and reconstructs stored state instead of trusting JSON from disk. */
export function parseSampleSurveyCheckpoint(value: unknown): SampleSurveyCheckpoint {
  const data = object(value), plan = parseSampleSurveyPlan(data.plan), report = parseSampleSurveyRun(data.report)
  if ((data.schemaVersion !== 1 && data.schemaVersion !== 2) || report.schemaVersion !== data.schemaVersion
    || report.planId !== plan.id || JSON.stringify(report.config) !== JSON.stringify(plan.config)
    || !Array.isArray(data.frames) || data.frames.length > (data.schemaVersion === 1 ? 2 : 14) || !Array.isArray(data.slots) || data.slots.length > 14_000) fail()
  const definitions = sampleSurveyStratumDefinitions(plan.config)
  const frameTargets = new Set<string>(), knownRanges = new Set<string>()
  const frames: SampleSurveyFrame[] = data.frames.map(raw => {
    const frame = object(raw)
    if ((frame.target !== 'lp' && frame.target !== 'mr') || data.schemaVersion === 1 && frameTargets.has(frame.target) || !integer(frame.totalCount)
      || !integer(frame.pageSize, 1, 20) || !integer(frame.totalPages) || frame.totalPages !== Math.ceil(frame.totalCount / frame.pageSize)
      || !utc(frame.checkedAt) || !Array.isArray(frame.ranges)) fail()
    frameTargets.add(frame.target)
    const expected = definitions.filter(definition => definition.target === frame.target)
    if (frame.ranges.length !== (data.schemaVersion === 1 ? expected.length : 1)) fail()
    const ranges = frame.ranges.map((rawRange, index) => {
      const range = object(rawRange)
      if (!(data.schemaVersion === 1 ? range.stratumId === expected[index].id : expected.some(item => item.id === range.stratumId)) || knownRanges.has(String(range.stratumId))
        || !integer(range.start, 0, frame.totalCount as number) || !integer(range.end, range.start, frame.totalCount as number)) fail()
      knownRanges.add(String(range.stratumId))
      return { stratumId: range.stratumId as string, start: range.start as number, end: range.end as number }
    })
    if (ranges.some((range, index) => index > 0 && range.end > ranges[index - 1].start)) fail()
    return { target: frame.target as SampleSurveyTarget, totalCount: frame.totalCount as number, pageSize: frame.pageSize as number,
      totalPages: frame.totalPages as number, checkedAt: frame.checkedAt as string, ranges }
  })
  const seenPositions = new Set<string>(), seenSlotIds = new Set<string>(), seenCollected = new Set<string>()
  const slots: SampleSurveySlot[] = data.slots.map(raw => {
    const slot = object(raw), definition = definitions.find(item => item.id === slot.stratumId)
    const frame = frames.find(item => item.target === slot.target && item.ranges.some(range => range.stratumId === slot.stratumId)), range = frame?.ranges.find(item => item.stratumId === slot.stratumId)
    if (!definition || !frame || !range || slot.target !== definition.target || !integer(slot.position, range.start, range.end - 1)
      || slot.id !== `${slot.stratumId}:${slot.position}` || seenSlotIds.has(String(slot.id))
      || seenPositions.has(`${data.schemaVersion === 1 ? slot.target : slot.stratumId}:${slot.position}`) || slot.page !== Math.floor(slot.position / frame.pageSize) + 1
      || slot.rowIndex !== slot.position % frame.pageSize || !['pending', 'collected', 'missing', 'duplicate'].includes(String(slot.status))) fail()
    seenPositions.add(`${data.schemaVersion === 1 ? slot.target : slot.stratumId}:${slot.position}`); seenSlotIds.add(String(slot.id))
    if (slot.status === 'pending') {
      if ([slot.accountId, slot.value, slot.rankId, slot.observedAt, slot.reason].some(item => item !== null)) fail()
    } else if (slot.status === 'missing' && slot.reason === 'page-unavailable' && data.schemaVersion === 2) {
      if (slot.accountId !== null || slot.value !== null || slot.rankId !== null || !utc(slot.observedAt)) fail()
    } else if (typeof slot.accountId !== 'string' || !/^\d{1,32}$/.test(slot.accountId) || !integer(slot.value)
      || !utc(slot.observedAt) || (slot.target === 'lp' ? !integer(slot.rankId, 1, 36) : slot.rankId !== null)
      || slot.reason !== (slot.status === 'missing' ? 'stratum-changed' : slot.status === 'duplicate' ? 'duplicate' : null)) fail()
    if (slot.status === 'collected') {
      const identity = `${slot.target}:${slot.accountId}`
      if (seenCollected.has(identity)) fail()
      seenCollected.add(identity)
    }
    return { id: slot.id as string, target: slot.target as SampleSurveyTarget, stratumId: slot.stratumId as string,
      position: slot.position as number, page: slot.page as number, rowIndex: slot.rowIndex as number, status: slot.status as SampleSurveySlot['status'],
      accountId: slot.accountId as string | null, value: slot.value as number | null, rankId: slot.rankId as number | null,
      observedAt: slot.observedAt as string | null, reason: slot.reason as SampleSurveySlot['reason'] }
  })
  const checkpoint: SampleSurveyCheckpoint = { schemaVersion: data.schemaVersion, plan, report, frames, slots }
  const recomputed = aggregate(checkpoint)
  if (data.schemaVersion === 1 && (slots.length || report.phase !== 'boundaries')) {
    if (definitions.some(definition => !knownRanges.has(definition.id))
      || recomputed.strata.some(stratum => stratum.selected !== Math.min(stratum.requested, stratum.population ?? 0))) fail()
  }
  if (data.schemaVersion === 2) {
    for (const row of recomputed.strata) {
      const observed = report.observation!.strata.find(item => item.id === row.id)!
      const frame = frames.find(item => item.ranges[0].stratumId === row.id), range = frame?.ranges[0]
      if (range && (row.selected !== Math.min(row.requested, row.population!) || observed.startBefore !== range.start || observed.endBefore !== range.end
        || observed.totalCountBefore !== frame!.totalCount) || !range && row.selected !== 0) fail()
    }
  }
  if (JSON.stringify(report.strata) !== JSON.stringify(recomputed.strata) || report.uniqueAccountCount !== recomputed.uniqueAccountCount) fail()
  return checkpoint
}

function aggregate(checkpoint: SampleSurveyCheckpoint): Pick<SampleSurveyRun, 'strata' | 'uniqueAccountCount'> {
  const allIds = new Set<string>()
  const strata = sampleSurveyStratumDefinitions(checkpoint.plan.config).map(definition => {
    const range = checkpoint.frames.find(frame => frame.target === definition.target && frame.ranges.some(item => item.stratumId === definition.id))?.ranges.find(item => item.stratumId === definition.id)
    const slots = checkpoint.slots.filter(slot => slot.stratumId === definition.id)
    const good = slots.filter(slot => slot.status === 'collected')
    for (const slot of good) allIds.add(slot.accountId!)
    const values = good.map(slot => slot.value!)
    return { id: definition.id, label: definition.label, target: definition.target, requested: definition.requested,
      population: range ? range.end - range.start : null, selected: slots.length, processed: slots.filter(slot => slot.status !== 'pending').length,
      succeeded: good.length, missing: slots.filter(slot => slot.status === 'missing').length, duplicates: slots.filter(slot => slot.status === 'duplicate').length,
      mean: values.length ? values.reduce((sum, entry) => sum + entry, 0) / values.length : null,
      min: values.length ? Math.min(...values) : null, max: values.length ? Math.max(...values) : null }
  })
  return { strata, uniqueAccountCount: allIds.size }
}

/** Hash stream + rejection sampling avoids modulo bias and does not allocate the population. */
function randomIntegers(seed: string) {
  let counter = 0, bytes = Buffer.alloc(0), offset = 0
  const uint32 = () => {
    if (offset >= bytes.length) { bytes = createHash('sha256').update(`${seed}:${counter++}`).digest(); offset = 0 }
    const value = bytes.readUInt32LE(offset); offset += 4; return value
  }
  return (exclusive: number) => {
    if (!integer(exclusive, 1, 0x100000000)) fail()
    const limit = Math.floor(0x100000000 / exclusive) * exclusive
    let value: number
    do { value = uint32() } while (value >= limit)
    return value % exclusive
  }
}
export function sampleSurveyPositions(start: number, end: number, count: number, seed: string): number[] {
  if (!integer(start) || !integer(end, start, 0xffffffff) || !integer(count, 0, end - start)) fail()
  const random = randomIntegers(seed), selected = new Set<number>()
  for (let j = end - start - count; j < end - start; j++) {
    const value = random(j + 1)
    selected.add(selected.has(value) ? j : value)
  }
  return [...selected].map(value => value + start).sort((a, b) => a - b)
}
function shuffled<T>(values: T[], seed: string): T[] {
  const output = values.slice(), random = randomIntegers(seed)
  for (let i = output.length - 1; i > 0; i--) { const j = random(i + 1); [output[i], output[j]] = [output[j], output[i]] }
  return output
}

function validatePage(page: SampleSurveyPage, target: SampleSurveyTarget, requested: number, onRowOrder: (before: number, after: number) => void): SampleSurveyPage {
  if (!page || page.target !== target || page.page !== requested || !integer(page.totalCount, 0, 0xffffffff)
    || !integer(page.pageSize, 1, 20) || !integer(page.totalPages) || page.totalPages !== Math.ceil(page.totalCount / page.pageSize)
    || requested < 1 || requested > Math.max(1, page.totalPages) || !utc(page.observedAt) || !Array.isArray(page.entries)
    || page.entries.length !== Math.min(page.pageSize, Math.max(0, page.totalCount - (requested - 1) * page.pageSize))) throw new SampleSurveyReadError('read-failed')
  let previous = Infinity
  const ids = new Set<string>()
  for (const entry of page.entries) {
    if (!entry || typeof entry.accountId !== 'string' || !/^\d{1,32}$/.test(entry.accountId) || ids.has(entry.accountId)
      || !integer(entry.value) || (target === 'lp' ? !integer(entry.rankId, 1, 36) : entry.rankId !== null)) throw new SampleSurveyReadError('read-failed')
    const metric = target === 'lp' ? entry.rankId! : entry.value
    if (metric > previous) { onRowOrder(previous, metric); throw new SampleSurveyReadError('frame-changed') }
    previous = metric; ids.add(entry.accountId)
  }
  return page
}

/** Recoverable evidence about one stratum, never an authentication/format/network failure. */
class BoundaryDrift extends Error {}
export interface SampleSurveyRunnerOptions {
  reader: SampleSurveyReader
  signal: AbortSignal
  checkpoint?: SampleSurveyCheckpoint
  onUpdate?(checkpoint: SampleSurveyCheckpoint): Promise<void> | void
  now?(): number
  wait?(milliseconds: number): Promise<void>
}

export function createSampleSurveyCheckpoint(value: SampleSurveyPlan, time = Date.now()): SampleSurveyCheckpoint {
  const plan = parseSampleSurveyPlan(value), timestamp = new Date(time).toISOString()
  const checkpoint: SampleSurveyCheckpoint = { schemaVersion: 2, plan, frames: [], slots: [], report: {
    schemaVersion: 2, id: randomUUID(), planId: plan.id, config: plan.config, state: 'preparing', phase: 'boundaries',
    startedAt: timestamp, updatedAt: timestamp, finishedAt: null, elapsedMs: 0, attempts: 0, successfulPages: 0,
    uniqueAccountCount: 0, strata: [], frameChanged: false, stopReason: null, resumeAllowed: false,
    observation: { method: 'rank-position-interval-v1', strata: sampleSurveyStratumDefinitions(plan.config).map(definition => ({
      id: definition.id, status: 'pending', startedAt: null, finishedAt: null, totalCountBefore: null, totalCountAfter: null,
      startBefore: null, endBefore: null, startAfter: null, endAfter: null, boundaryChanged: false,
    })), changes: [], omittedChanges: 0 },
  } }
  Object.assign(checkpoint.report, aggregate(checkpoint))
  return parseSampleSurveyCheckpoint(checkpoint)
}

export function markSampleSurveyInterrupted(value: SampleSurveyCheckpoint, time = Date.now()): SampleSurveyCheckpoint {
  const checkpoint = parseSampleSurveyCheckpoint(value)
  if (checkpoint.report.state !== 'preparing' && checkpoint.report.state !== 'running') return checkpoint
  const timestamp = new Date(Math.max(time, Date.parse(checkpoint.report.updatedAt))).toISOString()
  Object.assign(checkpoint.report, { state: 'stopped', updatedAt: timestamp, finishedAt: timestamp, stopReason: 'interrupted' })
  checkpoint.report.resumeAllowed = canResumeSampleSurvey(checkpoint)
  return parseSampleSurveyCheckpoint(checkpoint)
}

export async function runSampleSurvey(value: SampleSurveyPlan, options: SampleSurveyRunnerOptions): Promise<SampleSurveyCheckpoint> {
  const plan = parseSampleSurveyPlan(value), now = options.now ?? Date.now
  const start = now(), base = options.checkpoint ? parseSampleSurveyCheckpoint(options.checkpoint) : null
  if (base && (base.schemaVersion !== 2 || JSON.stringify(base.plan) !== JSON.stringify(plan) || !(base.report.resumeAllowed && canResumeSampleSurvey(base))
    && !(base.report.state === 'preparing' && base.report.attempts === 0 && !base.frames.length && !base.slots.length))) fail()
  const checkpoint: SampleSurveyCheckpoint = base ?? createSampleSurveyCheckpoint(plan, start)
  const previousElapsed = checkpoint.report.elapsedMs, initialAttempts = checkpoint.report.attempts
  const timeoutMs = plan.config.maxDurationMinutes * 60_000, maxReads = Math.floor(timeoutMs / SAMPLE_SURVEY_INTERVAL_MS) + 1
  let lastStart: number | null = null, current: SampleSurveyStratumDefinition | null = null
  const wait = options.wait ?? (async (milliseconds: number) => { await delay(milliseconds, undefined, { signal: options.signal }) })
  const definitions = sampleSurveyStratumDefinitions(plan.config), report = checkpoint.report, observation = report.observation!
  const latest = new Map<SampleSurveyTarget, { total: number; pageSize: number }>()
  report.state = 'preparing'; report.phase = 'boundaries'; report.stopReason = null; report.finishedAt = null; report.resumeAllowed = false
  const check = () => {
    if (options.signal.aborted) throw new SampleSurveyReadError(options.signal.reason instanceof SampleSurveyReadError ? options.signal.reason.code : 'cancelled')
    if (now() - start >= timeoutMs) throw new SampleSurveyReadError('limit-reached')
  }
  function change(kind: SampleSurveyChange['kind'], before: number | null, after: number | null): void {
    observation.changes.push({ kind, target: current!.target, stratumId: current!.id, at: new Date(now()).toISOString(), before, after })
    if (observation.changes.length > SAMPLE_SURVEY_MAX_CHANGES) { observation.changes.shift(); observation.omittedChanges++ }
  }
  async function publish() {
    report.elapsedMs = previousElapsed + Math.max(0, now() - start)
    report.updatedAt = new Date(now()).toISOString()
    Object.assign(report, aggregate(checkpoint))
    try { await options.onUpdate?.(parseSampleSurveyCheckpoint(checkpoint)) }
    catch { throw new SampleSurveyReadError('storage-error') }
  }
  async function read(target: SampleSurveyTarget, page: number): Promise<SampleSurveyPage> {
    check()
    if (report.attempts - initialAttempts >= maxReads) throw new SampleSurveyReadError('limit-reached')
    if (lastStart !== null) {
      const remaining = Math.max(0, SAMPLE_SURVEY_INTERVAL_MS - (now() - lastStart))
      if (now() - start + remaining >= timeoutMs) throw new SampleSurveyReadError('limit-reached')
      await wait(remaining); check()
    }
    report.attempts++; lastStart = now()
    await publish()
    const raw = await options.reader.readPage(target, page)
    const known = latest.get(target)
    if (known && integer(raw?.pageSize, 1, 20) && known.pageSize !== raw.pageSize) {
      change('page-size', known.pageSize, raw.pageSize)
      throw new SampleSurveyReadError('frame-changed')
    }
    const pageValue = validatePage(raw, target, page, (before, after) => change('row-order', before, after))
    check()
    if (known && known.total !== pageValue.totalCount) change('total-count', known.total, pageValue.totalCount)
    latest.set(target, { total: pageValue.totalCount, pageSize: pageValue.pageSize })
    report.successfulPages++
    await publish()
    return pageValue
  }
  function drift(kind: SampleSurveyChange['kind'], before: number | null, after: number | null): never {
    change(kind, before, after)
    throw new BoundaryDrift()
  }
  async function discover(definition: SampleSurveyStratumDefinition, hint?: SampleSurveyFrame): Promise<SampleSurveyFrame> {
    const first = await read(definition.target, 1), cache = new Map<number, SampleSurveyPage>([[1, first]])
    // Reuse only a candidate position. Every page in this discovery and the following
    // confirmation is read anew; saved rows never establish a current boundary.
    const hintRange = hint?.target === definition.target && hint.pageSize === first.pageSize
      ? hint.ranges.find(range => range.stratumId === definition.id) : undefined
    async function cached(page: number): Promise<SampleSurveyPage> {
      if (cache.has(page)) return cache.get(page)!
      // The upper search bound was observed earlier. A shrinking tail is a stratum change, not a new request for an invalid page.
      if (page > Math.max(1, Math.ceil(latest.get(definition.target)!.total / first.pageSize))) drift('page-unavailable', page, null)
      const value = await read(definition.target, page); cache.set(page, value); return value
    }
    async function nearby(threshold: number, candidate: number): Promise<number | null> {
      let lower: number | null = null, upper: number | null = null, step = 1
      let pageNumber = Math.floor(candidate / first.pageSize) + 1
      // Adapt the rank-distribution collector's exponential page bracketing.
      // A distant hint has bounded overhead before the ordinary binary search.
      for (let probe = 0; probe < 6; probe++) {
        const lastPage = Math.max(1, Math.ceil(latest.get(definition.target)!.total / first.pageSize))
        const page = await cached(Math.max(1, Math.min(pageNumber, lastPage)))
        const offset = (page.page - 1) * first.pageSize
        const prefix = page.entries.findIndex(entry => (definition.target === 'lp' ? entry.rankId! : entry.value) < threshold)
        if (prefix > 0) return offset + prefix
        if (prefix === 0) {
          upper = page.page
          if (page.page === 1) return 0
        } else {
          lower = page.page
          if (page.page >= page.totalPages) return page.totalCount
        }
        if (lower !== null && upper !== null) {
          // Conflicting observations guide neither acceptance nor a forced retry.
          if (lower >= upper) return null
          if (upper === lower + 1) return (upper - 1) * first.pageSize
          pageNumber = lower + Math.floor((upper - lower) / 2)
        } else {
          pageNumber = prefix === 0 ? page.page - step : page.page + step
          step *= 2
        }
      }
      return null
    }
    async function firstLess(threshold: number | null, candidate?: number): Promise<number> {
      if (threshold === null || definition.target === 'lp' && threshold > 36) return 0
      if (threshold <= (definition.target === 'lp' ? 1 : 0)) return latest.get(definition.target)!.total
      if (candidate !== undefined) {
        const found = await nearby(threshold, candidate)
        if (found !== null) return found
      }
      let low = 0, high = latest.get(definition.target)!.total
      while (low < high) {
        const middle = Math.floor((low + high) / 2), page = await cached(Math.floor(middle / first.pageSize) + 1)
        const entry = page.entries[middle % first.pageSize]
        if (!entry) drift('page-unavailable', middle, null)
        const metric = definition.target === 'lp' ? entry.rankId! : entry.value
        if (metric >= threshold) low = middle + 1
        else high = middle
      }
      return low
    }
    const rangeStart = await firstLess(definition.maximum, hintRange?.start), rangeEnd = await firstLess(definition.minimum, hintRange?.end)
    if (rangeStart > rangeEnd) drift('range-order', rangeStart, rangeEnd)
    const totalCount = latest.get(definition.target)!.total
    if (rangeEnd > totalCount) drift('boundary-end', rangeEnd, totalCount)
    return { target: definition.target, totalCount, pageSize: first.pageSize, totalPages: Math.ceil(totalCount / first.pageSize),
      checkedAt: new Date(now()).toISOString(), ranges: [{ stratumId: definition.id, start: rangeStart, end: rangeEnd }] }
  }
  async function confirm(frame: SampleSurveyFrame, definition: SampleSurveyStratumDefinition): Promise<void> {
    const first = await read(definition.target, 1), fresh = new Map<number, SampleSurveyPage>([[1, first]])
    const range = frame.ranges[0]
    for (const [cut, threshold, kind] of [[range.start, definition.maximum, 'boundary-start'], [range.end, definition.minimum, 'boundary-end']] as const) {
      if (threshold === null || definition.target === 'lp' && threshold > 36) { if (cut !== 0) drift(kind, cut, 0); continue }
      if (threshold <= (definition.target === 'lp' ? 1 : 0)) {
        if (cut !== latest.get(definition.target)!.total) drift(kind, cut, latest.get(definition.target)!.total)
        continue
      }
      if (cut > latest.get(definition.target)!.total) drift(kind, cut, latest.get(definition.target)!.total)
      for (const position of [cut - 1, cut]) {
        if (position < 0 || position >= latest.get(definition.target)!.total) continue
        const pageNumber = Math.floor(position / frame.pageSize) + 1
        const page = fresh.get(pageNumber) ?? await read(definition.target, pageNumber)
        fresh.set(pageNumber, page)
        const entry = page.entries[position % frame.pageSize]
        if (!entry) drift(kind, cut, null)
        const metric = definition.target === 'lp' ? entry.rankId! : entry.value
        if (position < cut ? metric < threshold : metric >= threshold) drift(kind, cut, null)
      }
      // A newly growing tail can invalidate a previously terminal cut.
      if (cut > latest.get(definition.target)!.total) drift(kind, cut, latest.get(definition.target)!.total)
    }
    frame.checkedAt = new Date(now()).toISOString()
  }
  function before(observed: SampleSurveyStratumObservation, frame: SampleSurveyFrame): void {
    Object.assign(observed, { totalCountBefore: frame.totalCount, startBefore: frame.ranges[0].start, endBefore: frame.ranges[0].end })
  }
  function after(observed: SampleSurveyStratumObservation, frame: SampleSurveyFrame): void {
    Object.assign(observed, { totalCountAfter: frame.totalCount, startAfter: frame.ranges[0].start, endAfter: frame.ranges[0].end })
    if (observed.startBefore !== null && observed.startBefore !== observed.startAfter) {
      change('boundary-start', observed.startBefore, observed.startAfter); observed.boundaryChanged = true
    }
    if (observed.endBefore !== null && observed.endBefore !== observed.endAfter) {
      change('boundary-end', observed.endBefore, observed.endAfter); observed.boundaryChanged = true
    }
    if (observed.boundaryChanged) report.frameChanged = true
  }
  function review(observed: SampleSurveyStratumObservation): void {
    observed.boundaryChanged = true; observed.status = 'review-required'; observed.finishedAt = new Date(now()).toISOString(); report.frameChanged = true
  }
  try {
    await publish()
    for (const definition of definitions) {
      current = definition
      const observed = observation.strata.find(item => item.id === definition.id)!
      if (observed.status === 'checked' || observed.status === 'review-required') continue
      observed.status = 'collecting'; observed.startedAt ??= new Date(now()).toISOString()
      report.phase = 'boundaries'; report.state = 'preparing'
      const saved = checkpoint.frames.find(frame => frame.ranges.some(range => range.stratumId === definition.id))
      if (saved && !latest.has(definition.target)) latest.set(definition.target, { total: saved.totalCount, pageSize: saved.pageSize })
      let frame: SampleSurveyFrame
      try {
        frame = await discover(definition, saved)
        if (!saved) before(observed, frame)
        for (let refinement = 0; ; refinement++) {
          try {
            await confirm(frame, definition)
            break
          } catch (error) {
            // Only an established, unsampled candidate may be refreshed. A failed
            // discovery, saved slots, or any read/authentication error cannot retry.
            if (!(error instanceof BoundaryDrift) || saved || refinement === INITIAL_BOUNDARY_REFINEMENTS) throw error
            observed.boundaryChanged = true; report.frameChanged = true
            const previous = frame.ranges[0]
            frame = await discover(definition, frame)
            const refreshed = frame.ranges[0]
            if (previous.start !== refreshed.start) change('boundary-start', previous.start, refreshed.start)
            if (previous.end !== refreshed.end) change('boundary-end', previous.end, refreshed.end)
            // The selected positions and published population must use the same
            // final frame; earlier candidates remain only in the change evidence.
            before(observed, frame)
          }
        }
      } catch (error) {
        if (!(error instanceof BoundaryDrift)) throw error
        if (saved) throw new SampleSurveyReadError('frame-changed')
        observed.totalCountAfter = latest.get(definition.target)?.total ?? null
        review(observed); await publish(); continue
      }
      if (saved) {
        after(observed, frame)
        if (saved.pageSize !== frame.pageSize) { change('page-size', saved.pageSize, frame.pageSize); throw new SampleSurveyReadError('frame-changed') }
        if (saved.ranges[0].start !== frame.ranges[0].start || saved.ranges[0].end !== frame.ranges[0].end) throw new SampleSurveyReadError('frame-changed')
        frame = saved
        // This was only a resume pre-check, not the required post-collection observation.
        observed.totalCountAfter = null; observed.startAfter = null; observed.endAfter = null
      } else {
        checkpoint.frames.push(frame)
        const range = frame.ranges[0]
        const positions = sampleSurveyPositions(range.start, range.end, Math.min(definition.requested, range.end - range.start), `${plan.seed}:${definition.id}`)
        for (const position of positions) checkpoint.slots.push({ id: `${definition.id}:${position}`, target: definition.target, stratumId: definition.id,
          position, page: Math.floor(position / frame.pageSize) + 1, rowIndex: position % frame.pageSize,
          status: 'pending', accountId: null, value: null, rankId: null, observedAt: null, reason: null })
      }
      report.phase = 'sampling'; report.state = 'running'
      await publish()
      const groups = new Map<number, SampleSurveySlot[]>()
      for (const slot of checkpoint.slots.filter(slot => slot.stratumId === definition.id && slot.status === 'pending')) {
        groups.set(slot.page, [...(groups.get(slot.page) ?? []), slot])
      }
      const seen = new Set(checkpoint.slots.filter(slot => slot.status === 'collected').map(slot => `${slot.target}:${slot.accountId}`))
      for (const slots of shuffled([...groups.values()], `${plan.seed}:${definition.id}:page-order`)) {
        check()
        // A prior page may already have established that these fixed slots no longer exist.
        // Keep them missing instead of asking for an invalid page or drawing replacements.
        if (slots[0].page > Math.ceil(latest.get(definition.target)!.total / frame.pageSize)) {
          for (const slot of slots) {
            Object.assign(slot, { status: 'missing', reason: 'page-unavailable', observedAt: new Date(now()).toISOString() })
            change('page-unavailable', slot.position, null)
          }
          report.frameChanged = true
          await publish(); continue
        }
        const page = await read(definition.target, slots[0].page)
        for (const slot of slots) {
          const entry = page.entries[slot.rowIndex]
          if (!entry) {
            Object.assign(slot, { status: 'missing', reason: 'page-unavailable', observedAt: page.observedAt })
            change('page-unavailable', slot.position, null); report.frameChanged = true; continue
          }
          const metric = slot.target === 'lp' ? entry.rankId! : entry.value
          Object.assign(slot, { accountId: entry.accountId, value: entry.value, rankId: entry.rankId, observedAt: page.observedAt })
          if (metric < definition.minimum || definition.maximum !== null && metric >= definition.maximum) {
            slot.status = 'missing'; slot.reason = 'stratum-changed'; report.frameChanged = true
            change('row-outside-stratum', definition.minimum, metric)
          } else if (seen.has(`${slot.target}:${entry.accountId}`)) {
            slot.status = 'duplicate'; slot.reason = 'duplicate'; report.frameChanged = true
            change('duplicate', 0, 1)
          } else { slot.status = 'collected'; seen.add(`${slot.target}:${entry.accountId}`) }
        }
        await publish()
      }
      // Re-discover from fresh pages. Equal cuts are an observation, never proof of no intervening movement.
      try {
        const endFrame = await discover(definition, frame)
        after(observed, endFrame)
        await confirm(endFrame, definition)
        observed.totalCountAfter = latest.get(definition.target)!.total
      } catch (error) {
        if (!(error instanceof BoundaryDrift)) throw error
        observed.totalCountAfter = latest.get(definition.target)?.total ?? null
        observed.boundaryChanged = true; report.frameChanged = true
      }
      const quality = checkpoint.slots.some(slot => slot.stratumId === definition.id && (slot.status === 'missing' || slot.status === 'duplicate'))
      observed.status = observed.boundaryChanged || quality ? 'review-required' : 'checked'
      observed.finishedAt = new Date(now()).toISOString()
      await publish()
    }
    report.state = 'complete'; report.phase = 'complete'; report.finishedAt = new Date(now()).toISOString()
    await publish()
  } catch (error) {
    const code: SampleSurveyError = options.signal.aborted
      ? options.signal.reason instanceof SampleSurveyReadError ? options.signal.reason.code : 'cancelled'
      : error instanceof SampleSurveyReadError ? error.code : 'read-failed'
    report.state = ['cancelled', 'limit-reached', 'interrupted'].includes(code) ? 'stopped' : 'error'
    report.stopReason = code; report.finishedAt = new Date(now()).toISOString()
    report.frameChanged ||= code === 'frame-changed'
    report.resumeAllowed = canResumeSampleSurvey(checkpoint)
    try { await publish() } catch { report.state = 'error'; report.stopReason = 'storage-error'; report.resumeAllowed = false }
  }
  return parseSampleSurveyCheckpoint(checkpoint)
}
