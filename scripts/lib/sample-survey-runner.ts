import { createHash, randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { parseSampleSurveyPlan, parseSampleSurveyRun, SAMPLE_SURVEY_INTERVAL_MS, SAMPLE_SURVEY_MR_BANDS, SAMPLE_SURVEY_RANKS } from '../../src/lib/sampleSurvey.ts'
import type { SampleSurveyConfig, SampleSurveyError, SampleSurveyPlan, SampleSurveyRun, SampleSurveyTarget } from '../../src/types/sampleSurvey.ts'
import { SampleSurveyReadError } from './sample-survey-reader.ts'
import type { SampleSurveyPage, SampleSurveyReader } from './sample-survey-reader.ts'

export { SAMPLE_SURVEY_INTERVAL_MS }
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
  reason: 'stratum-changed' | 'duplicate' | null
}
/** Private checkpoint. Only its `report` may cross the local service boundary. */
export interface SampleSurveyCheckpoint {
  schemaVersion: 1; plan: SampleSurveyPlan; report: SampleSurveyRun; frames: SampleSurveyFrame[]; slots: SampleSurveySlot[]
}

/** A concrete Act identity is not yet available, so observed MR rows cannot cross a restart. */
export function canResumeSampleSurvey(checkpoint: SampleSurveyCheckpoint): boolean {
  return ['stopped', 'error'].includes(checkpoint.report.state)
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
  if (data.schemaVersion !== 1 || report.planId !== plan.id || JSON.stringify(report.config) !== JSON.stringify(plan.config)
    || !Array.isArray(data.frames) || data.frames.length > 2 || !Array.isArray(data.slots) || data.slots.length > 14_000) fail()
  const definitions = sampleSurveyStratumDefinitions(plan.config)
  const frameTargets = new Set<string>(), knownRanges = new Set<string>()
  const frames: SampleSurveyFrame[] = data.frames.map(raw => {
    const frame = object(raw)
    if ((frame.target !== 'lp' && frame.target !== 'mr') || frameTargets.has(frame.target) || !integer(frame.totalCount)
      || !integer(frame.pageSize, 1, 20) || !integer(frame.totalPages) || frame.totalPages !== Math.ceil(frame.totalCount / frame.pageSize)
      || !utc(frame.checkedAt) || !Array.isArray(frame.ranges)) fail()
    frameTargets.add(frame.target)
    const expected = definitions.filter(definition => definition.target === frame.target)
    if (frame.ranges.length !== expected.length) fail()
    const ranges = frame.ranges.map((rawRange, index) => {
      const range = object(rawRange)
      if (range.stratumId !== expected[index].id || knownRanges.has(String(range.stratumId))
        || !integer(range.start, 0, frame.totalCount as number) || !integer(range.end, range.start, frame.totalCount as number)) fail()
      knownRanges.add(String(range.stratumId))
      return { stratumId: range.stratumId as string, start: range.start as number, end: range.end as number }
    })
    if (ranges.some((range, index) => index > 0 && range.end > ranges[index - 1].start)) fail()
    return { target: frame.target as SampleSurveyTarget, totalCount: frame.totalCount as number, pageSize: frame.pageSize as number,
      totalPages: frame.totalPages as number, checkedAt: frame.checkedAt as string, ranges }
  })
  const seenPositions = new Set<string>(), seenSlotIds = new Set<string>()
  const slots: SampleSurveySlot[] = data.slots.map(raw => {
    const slot = object(raw), definition = definitions.find(item => item.id === slot.stratumId)
    const frame = frames.find(item => item.target === slot.target), range = frame?.ranges.find(item => item.stratumId === slot.stratumId)
    if (!definition || !frame || !range || slot.target !== definition.target || !integer(slot.position, range.start, range.end - 1)
      || slot.id !== `${slot.stratumId}:${slot.position}` || seenSlotIds.has(String(slot.id))
      || seenPositions.has(`${slot.target}:${slot.position}`) || slot.page !== Math.floor(slot.position / frame.pageSize) + 1
      || slot.rowIndex !== slot.position % frame.pageSize || !['pending', 'collected', 'missing', 'duplicate'].includes(String(slot.status))) fail()
    seenPositions.add(`${slot.target}:${slot.position}`); seenSlotIds.add(String(slot.id))
    if (slot.status === 'pending') {
      if ([slot.accountId, slot.value, slot.rankId, slot.observedAt, slot.reason].some(item => item !== null)) fail()
    } else if (typeof slot.accountId !== 'string' || !/^\d{1,32}$/.test(slot.accountId) || !integer(slot.value)
      || !utc(slot.observedAt) || (slot.target === 'lp' ? !integer(slot.rankId, 1, 36) : slot.rankId !== null)
      || slot.reason !== (slot.status === 'missing' ? 'stratum-changed' : slot.status === 'duplicate' ? 'duplicate' : null)) fail()
    return { id: slot.id as string, target: slot.target as SampleSurveyTarget, stratumId: slot.stratumId as string,
      position: slot.position as number, page: slot.page as number, rowIndex: slot.rowIndex as number, status: slot.status as SampleSurveySlot['status'],
      accountId: slot.accountId as string | null, value: slot.value as number | null, rankId: slot.rankId as number | null,
      observedAt: slot.observedAt as string | null, reason: slot.reason as SampleSurveySlot['reason'] }
  })
  const checkpoint = { schemaVersion: 1 as const, plan, report, frames, slots }
  const recomputed = aggregate(checkpoint)
  if (slots.length || report.phase !== 'boundaries') {
    if (definitions.some(definition => !knownRanges.has(definition.id))
      || recomputed.strata.some(stratum => stratum.selected !== Math.min(stratum.requested, stratum.population ?? 0))) fail()
  }
  if (JSON.stringify(report.strata) !== JSON.stringify(recomputed.strata) || report.uniqueAccountCount !== recomputed.uniqueAccountCount) fail()
  return checkpoint
}

function aggregate(checkpoint: SampleSurveyCheckpoint): Pick<SampleSurveyRun, 'strata' | 'uniqueAccountCount'> {
  const allIds = new Set<string>()
  const strata = sampleSurveyStratumDefinitions(checkpoint.plan.config).map(definition => {
    const range = checkpoint.frames.find(frame => frame.target === definition.target)?.ranges.find(item => item.stratumId === definition.id)
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

function validatePage(page: SampleSurveyPage, target: SampleSurveyTarget, requested: number): SampleSurveyPage {
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
    if (metric > previous) throw new SampleSurveyReadError('frame-changed')
    previous = metric; ids.add(entry.accountId)
  }
  return page
}

/** Check every saved cut whose immediate left or right row is visible on this page. */
function assertVisibleBoundaries(page: SampleSurveyPage, frame: SampleSurveyFrame, definitions: SampleSurveyStratumDefinition[]): void {
  const pageStart = (page.page - 1) * page.pageSize
  for (const range of frame.ranges) {
    const definition = definitions.find(item => item.id === range.stratumId)!
    for (const [position, threshold] of [[range.start, definition.maximum], [range.end, definition.minimum]] as const) {
      if (threshold === null) continue
      for (const index of [position - 1, position]) {
        if (index < 0 || index >= frame.totalCount || index < pageStart || index >= pageStart + page.entries.length) continue
        const row = page.entries[index - pageStart], metric = page.target === 'lp' ? row.rankId! : row.value
        if (index < position ? metric < threshold : metric >= threshold) throw new SampleSurveyReadError('frame-changed')
      }
    }
  }
}
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
  const checkpoint: SampleSurveyCheckpoint = { schemaVersion: 1, plan, frames: [], slots: [], report: {
    schemaVersion: 1, id: randomUUID(), planId: plan.id, config: plan.config, state: 'preparing', phase: 'boundaries',
    startedAt: timestamp, updatedAt: timestamp, finishedAt: null, elapsedMs: 0, attempts: 0, successfulPages: 0,
    uniqueAccountCount: 0, strata: [], frameChanged: false, stopReason: null, resumeAllowed: false,
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
  if (base && (JSON.stringify(base.plan) !== JSON.stringify(plan) || !(base.report.resumeAllowed && canResumeSampleSurvey(base))
    && !(base.report.state === 'preparing' && base.report.attempts === 0 && !base.frames.length && !base.slots.length))) fail()
  const checkpoint: SampleSurveyCheckpoint = base ?? createSampleSurveyCheckpoint(plan, start)
  const previousElapsed = checkpoint.report.elapsedMs, initialAttempts = checkpoint.report.attempts
  const timeoutMs = plan.config.maxDurationMinutes * 60_000, maxReads = Math.floor(timeoutMs / SAMPLE_SURVEY_INTERVAL_MS) + 1
  let lastStart: number | null = null
  const wait = options.wait ?? (async (milliseconds: number) => { await delay(milliseconds, undefined, { signal: options.signal }) })
  const pages = new Map<string, SampleSurveyPage>()
  const definitions = sampleSurveyStratumDefinitions(plan.config)
  const report = checkpoint.report
  report.state = 'preparing'; report.phase = 'boundaries'; report.stopReason = null; report.finishedAt = null; report.resumeAllowed = false
  const check = () => {
    if (options.signal.aborted) throw new SampleSurveyReadError(options.signal.reason instanceof SampleSurveyReadError ? options.signal.reason.code : 'cancelled')
    if (now() - start >= timeoutMs) throw new SampleSurveyReadError('limit-reached')
  }
  async function publish() {
    report.elapsedMs = previousElapsed + Math.max(0, now() - start)
    report.updatedAt = new Date(now()).toISOString()
    Object.assign(report, aggregate(checkpoint))
    try { await options.onUpdate?.(parseSampleSurveyCheckpoint(checkpoint)) }
    catch { throw new SampleSurveyReadError('storage-error') }
  }
  async function read(target: SampleSurveyTarget, page: number, cached = true): Promise<SampleSurveyPage> {
    check()
    const key = `${target}:${page}`
    if (cached && pages.has(key)) return pages.get(key)!
    if (report.attempts - initialAttempts >= maxReads) throw new SampleSurveyReadError('limit-reached')
    if (lastStart !== null) {
      const remaining = Math.max(0, SAMPLE_SURVEY_INTERVAL_MS - (now() - lastStart))
      if (now() - start + remaining >= timeoutMs) throw new SampleSurveyReadError('limit-reached')
      await wait(remaining); check()
    }
    report.attempts++; lastStart = now()
    await publish()
    const pageValue = validatePage(await options.reader.readPage(target, page), target, page)
    check()
    const known = pages.get(`${target}:1`)
    if (known && (known.totalCount !== pageValue.totalCount || known.pageSize !== pageValue.pageSize)) throw new SampleSurveyReadError('frame-changed')
    report.successfulPages++; pages.set(key, pageValue)
    await publish()
    return pageValue
  }
  try {
    await publish()
    for (const target of ['lp', 'mr'] as const) {
      const targetDefinitions = definitions.filter(definition => definition.target === target)
      if (!targetDefinitions.length) continue
      const first = await read(target, 1, false)
      const existing = checkpoint.frames.find(frame => frame.target === target)
      if (existing && (existing.totalCount !== first.totalCount || existing.pageSize !== first.pageSize)) throw new SampleSurveyReadError('frame-changed')
      const thresholds = new Map<number, number>()
      async function firstLess(threshold: number | null): Promise<number> {
        if (threshold === null || target === 'lp' && threshold > 36) return 0
        if (threshold <= (target === 'lp' ? 1 : 0)) return first.totalCount
        if (thresholds.has(threshold)) return thresholds.get(threshold)!
        let low = 0, high = first.totalCount
        while (low < high) {
          const middle = Math.floor((low + high) / 2)
          const page = await read(target, Math.floor(middle / first.pageSize) + 1)
          const entry = page.entries[middle % first.pageSize]
          const metric = target === 'lp' ? entry.rankId! : entry.value
          if (metric >= threshold) low = middle + 1
          else high = middle
        }
        thresholds.set(threshold, low)
        return low
      }
      const ranges: SampleSurveyFrame['ranges'] = []
      for (const definition of targetDefinitions) {
        const rangeStart = await firstLess(definition.maximum), rangeEnd = await firstLess(definition.minimum)
        if (rangeStart > rangeEnd) throw new SampleSurveyReadError('frame-changed')
        ranges.push({ stratumId: definition.id, start: rangeStart, end: rangeEnd })
      }
      if (existing && JSON.stringify(existing.ranges) !== JSON.stringify(ranges)) throw new SampleSurveyReadError('frame-changed')
      const confirmedFrame: SampleSurveyFrame = { target, totalCount: first.totalCount, pageSize: first.pageSize, totalPages: first.totalPages,
        checkedAt: new Date(now()).toISOString(), ranges }
      const edgePages = new Set<number>()
      for (const range of ranges) for (const cut of [range.start, range.end]) {
        for (const position of [cut - 1, cut]) if (position >= 0 && position < first.totalCount) edgePages.add(Math.floor(position / first.pageSize) + 1)
      }
      // Search-cache observations can be stale. Read each adjacent page afresh before accepting the frame.
      for (const page of edgePages) assertVisibleBoundaries(await read(target, page, false), confirmedFrame, definitions)
      confirmedFrame.checkedAt = new Date(now()).toISOString()
      if (!existing) checkpoint.frames.push(confirmedFrame)
      await publish()
    }
    if (!checkpoint.slots.length) {
      for (const frame of checkpoint.frames) for (const range of frame.ranges) {
        const definition = definitions.find(item => item.id === range.stratumId)!
        const positions = sampleSurveyPositions(range.start, range.end, Math.min(definition.requested, range.end - range.start), `${plan.seed}:${range.stratumId}`)
        for (const position of positions) checkpoint.slots.push({ id: `${range.stratumId}:${position}`, target: frame.target, stratumId: range.stratumId,
          position, page: Math.floor(position / frame.pageSize) + 1, rowIndex: position % frame.pageSize,
          status: 'pending', accountId: null, value: null, rankId: null, observedAt: null, reason: null })
      }
    }
    report.phase = 'sampling'; report.state = 'running'
    await publish()
    const groups = new Map<string, SampleSurveySlot[]>()
    for (const slot of checkpoint.slots) {
      const key = `${slot.target}:${slot.page}`
      groups.set(key, [...(groups.get(key) ?? []), slot])
    }
    const seen = new Set(checkpoint.slots.filter(slot => slot.status === 'collected').map(slot => `${slot.target}:${slot.accountId}`))
    for (const allSlots of shuffled([...groups.values()], `${plan.seed}:page-order`)) {
      const group = allSlots.filter(slot => slot.status === 'pending')
      if (!group.length) continue
      check()
      const page = await read(group[0].target, group[0].page, false)
      assertVisibleBoundaries(page, checkpoint.frames.find(frame => frame.target === page.target)!, definitions)
      for (const slot of group) {
        const entry = page.entries[slot.rowIndex]
        const definition = definitions.find(item => item.id === slot.stratumId)!
        const metric = slot.target === 'lp' ? entry.rankId! : entry.value
        Object.assign(slot, { accountId: entry.accountId, value: entry.value, rankId: entry.rankId, observedAt: page.observedAt })
        if (metric < definition.minimum || definition.maximum !== null && metric >= definition.maximum) {
          slot.status = 'missing'; slot.reason = 'stratum-changed'; report.frameChanged = true
        } else if (seen.has(`${slot.target}:${entry.accountId}`)) {
          slot.status = 'duplicate'; slot.reason = 'duplicate'; report.frameChanged = true
        } else { slot.status = 'collected'; seen.add(`${slot.target}:${entry.accountId}`) }
      }
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
