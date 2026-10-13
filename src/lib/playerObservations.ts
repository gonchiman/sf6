import type {
  PlayerObservationConditions, PlayerObservationCoverage, PlayerObservationDataset,
  PlayerObservationRun, PlayerObservationRunStatus, PlayerObservationSelection,
} from '../types/playerObservations.ts'

export const PLAYER_OBSERVATION_CONDITIONS: Readonly<PlayerObservationConditions> = Object.freeze({
  league: 'all', character: 'max-lp', region: 'all', platform: 'all', users: 'all',
})

export const PLAYER_OBSERVATION_SOURCE: PlayerObservationDataset['source'] = {
  title: 'Buckler’s Boot Camp リーグランキング',
  url: 'https://www.streetfighter.com/6/buckler/ja-jp/ranking/league',
  population: '総合・最大LP・全地域・全プラットフォーム・全ユーザーのランキングで観測したCFNアカウント',
  metric: '通算の観測履歴で初めて確認したCFNアカウント数',
  unit: 'cfn-account',
  notes: [
    '初観測は実際の参入日時・初プレイ日時・実人数を示しません。',
    '基準走査中の件数、欠測、取得失敗を0件として補完しません。',
    '全対象ページの訪問後も、走査中のランキング変動により単一時点の完全な名簿にはなりません。',
  ],
}

type UnknownRecord = Record<string, unknown>
const RUN_STATUSES: readonly PlayerObservationRunStatus[] = ['running', 'complete', 'partial', 'failed', 'missing']
const COVERAGES: readonly PlayerObservationCoverage[] = ['sample', 'all-pages', 'incomplete', 'none']
const JST_OFFSET = 9 * 60 * 60 * 1000

function invalid(field: string): never {
  throw new Error(`新規観測データの形式が正しくありません（${field}）。`)
}

/** An allowlist at every public object boundary excludes private IDs and authentication fields. */
function record(value: unknown, field: string, keys: readonly string[]): UnknownRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid(field)
  const input = value as UnknownRecord
  const unknown = Object.keys(input).find(key => !keys.includes(key))
  if (unknown) invalid(`${field}.${unknown}: unknown field`)
  for (const key of keys) if (!Object.hasOwn(input, key)) invalid(`${field}.${key}: required`)
  return input
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value || value !== value.trim()) invalid(field)
  return value
}

function array(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) invalid(field)
  return value
}

function notes(value: unknown, field: string): string[] {
  return array(value, field).map((item, index) => text(item, `${field}[${index}]`))
}

function count(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) invalid(field)
  return value
}

function nullableCount(value: unknown, field: string): number | null {
  return value === null ? null : count(value, field)
}

function calendarDate(value: unknown, field: string): string {
  const result = text(value, field)
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(result)
  if (!match) invalid(field)
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const monthDays = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  if (month < 1 || month > 12 || day < 1 || day > monthDays[month - 1]) invalid(field)
  return result
}

function timestamp(value: unknown, field: string): string {
  const result = text(value, field)
  const match = /^(\d{4}-\d{2}-\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(result)
  if (!match || !Number.isFinite(Date.parse(result))) invalid(field)
  calendarDate(match[1], field)
  return result
}

function nullableTimestamp(value: unknown, field: string): string | null {
  return value === null ? null : timestamp(value, field)
}

function source(value: unknown): PlayerObservationDataset['source'] {
  const input = record(value, 'source', ['title', 'url', 'population', 'metric', 'unit', 'notes'])
  const url = text(input.url, 'source.url')
  // Query strings, credentials, fragments and alternate endpoints do not belong in public metadata.
  if (url !== PLAYER_OBSERVATION_SOURCE.url) invalid('source.url')
  if (input.unit !== 'cfn-account') invalid('source.unit')
  return {
    title: text(input.title, 'source.title'), url, population: text(input.population, 'source.population'),
    metric: text(input.metric, 'source.metric'), unit: 'cfn-account', notes: notes(input.notes, 'source.notes'),
  }
}

function conditions(value: unknown): PlayerObservationConditions {
  const input = record(value, 'conditions', Object.keys(PLAYER_OBSERVATION_CONDITIONS))
  for (const key of Object.keys(PLAYER_OBSERVATION_CONDITIONS) as (keyof PlayerObservationConditions)[]) {
    if (input[key] !== PLAYER_OBSERVATION_CONDITIONS[key]) invalid(`conditions.${key}`)
  }
  return { ...PLAYER_OBSERVATION_CONDITIONS }
}

function pages(value: unknown, field: string): PlayerObservationRun['pages'] {
  const input = record(value, field, ['expectedAtStart', 'expectedAtEnd', 'succeeded', 'failed', 'sampledPages'])
  const sampledPages = array(input.sampledPages, `${field}.sampledPages`).map((value, index) => {
    const page = count(value, `${field}.sampledPages[${index}]`)
    if (page === 0) invalid(`${field}.sampledPages: positive page required`)
    return page
  })
  if (new Set(sampledPages).size !== sampledPages.length) invalid(`${field}.sampledPages: duplicate`)
  return {
    expectedAtStart: nullableCount(input.expectedAtStart, `${field}.expectedAtStart`),
    expectedAtEnd: nullableCount(input.expectedAtEnd, `${field}.expectedAtEnd`),
    succeeded: count(input.succeeded, `${field}.succeeded`),
    failed: count(input.failed, `${field}.failed`), sampledPages,
  }
}

function run(value: unknown, index: number, generatedAt: string): PlayerObservationRun {
  const field = `runs[${index}]`
  const input = record(value, field, [
    'id', 'phase', 'status', 'scope', 'scheduledAt', 'startedAt', 'endedAt', 'observedIdCount',
    'newObservedCount', 'newObservedLowerBound', 'pages', 'coverage', 'reportedTotalAtStart',
    'reportedTotalAtEnd', 'warnings', 'failureReason',
  ])
  const id = text(input.id, `${field}.id`)
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id)) invalid(`${field}.id`)
  if (input.phase !== 'baseline' && input.phase !== 'observation') invalid(`${field}.phase`)
  if (!RUN_STATUSES.includes(input.status as PlayerObservationRunStatus)) invalid(`${field}.status`)
  if (input.scope !== 'probe' && input.scope !== 'population') invalid(`${field}.scope`)
  if (!COVERAGES.includes(input.coverage as PlayerObservationCoverage)) invalid(`${field}.coverage`)
  const result: PlayerObservationRun = {
    id, phase: input.phase, status: input.status as PlayerObservationRunStatus, scope: input.scope,
    scheduledAt: timestamp(input.scheduledAt, `${field}.scheduledAt`),
    startedAt: nullableTimestamp(input.startedAt, `${field}.startedAt`),
    endedAt: nullableTimestamp(input.endedAt, `${field}.endedAt`),
    observedIdCount: nullableCount(input.observedIdCount, `${field}.observedIdCount`),
    newObservedCount: nullableCount(input.newObservedCount, `${field}.newObservedCount`),
    newObservedLowerBound: nullableCount(input.newObservedLowerBound, `${field}.newObservedLowerBound`),
    pages: pages(input.pages, `${field}.pages`), coverage: input.coverage as PlayerObservationCoverage,
    reportedTotalAtStart: nullableCount(input.reportedTotalAtStart, `${field}.reportedTotalAtStart`),
    reportedTotalAtEnd: nullableCount(input.reportedTotalAtEnd, `${field}.reportedTotalAtEnd`),
    warnings: notes(input.warnings, `${field}.warnings`),
    failureReason: input.failureReason === null ? null : text(input.failureReason, `${field}.failureReason`),
  }
  const scheduled = Date.parse(result.scheduledAt)
  const started = result.startedAt === null ? null : Date.parse(result.startedAt)
  const ended = result.endedAt === null ? null : Date.parse(result.endedAt)
  const generated = Date.parse(generatedAt)
  if (scheduled > generated || (started !== null && (started < scheduled || started > generated))
    || (ended !== null && (ended < (started ?? scheduled) || ended > generated))) invalid(`${field}.timestamps: order`)

  if (result.status === 'running' && (started === null || ended !== null)) invalid(`${field}.running: timestamps`)
  if (['complete', 'partial'].includes(result.status) && (started === null || ended === null)) invalid(`${field}.timestamps: capture interval required`)
  if (result.status === 'failed' && (ended === null || result.observedIdCount !== null || result.pages.succeeded !== 0)) {
    invalid(`${field}.failed: end time and unknown counts required`)
  }
  if (result.status === 'missing' && (started !== null || ended !== null || result.observedIdCount !== null
    || result.pages.succeeded !== 0 || result.pages.failed !== 0 || result.pages.sampledPages.length
    || result.pages.expectedAtStart !== null || result.pages.expectedAtEnd !== null
    || result.coverage !== 'none' || result.reportedTotalAtStart !== null || result.reportedTotalAtEnd !== null)) {
    invalid(`${field}.missing: no capture allowed`)
  }
  for (const end of ['Start', 'End'] as const) {
    const total = result[`reportedTotalAt${end}`]
    const expected = result.pages[`expectedAt${end}`]
    if (total !== null && total < 1) invalid(`${field}.reportedTotalAt${end}: empty source not supported`)
    if (expected !== null && expected < 1) invalid(`${field}.pages.expectedAt${end}: positive page count required`)
    if (total !== null && expected !== null && expected !== Math.ceil(total / 20)) {
      invalid(`${field}.pages.expectedAt${end}: source total mismatch`)
    }
  }
  if (result.observedIdCount !== null && result.observedIdCount > result.pages.succeeded * 20) {
    invalid(`${field}.observedIdCount: exceeds captured rows`)
  }
  if (result.pages.succeeded > 0 && result.observedIdCount === null) invalid(`${field}.observedIdCount: required for successful pages`)
  if (result.scope === 'probe' && result.pages.sampledPages.length !== result.pages.succeeded) invalid(`${field}.pages.sampledPages: successful probe pages required`)
  if (result.scope === 'population' && result.pages.sampledPages.length !== 0) invalid(`${field}.pages.sampledPages: population uses aggregate coverage`)
  if (result.coverage === 'sample' && result.scope !== 'probe') invalid(`${field}.coverage: sample requires probe`)
  if (result.coverage === 'incomplete' && result.scope !== 'population') invalid(`${field}.coverage: incomplete requires population`)
  if (['sample', 'incomplete'].includes(result.coverage) && result.pages.succeeded === 0) invalid(`${field}.coverage: no successful pages`)
  if (result.coverage === 'none' && result.pages.succeeded > 0) invalid(`${field}.coverage: successful pages exist`)
  if (result.coverage === 'all-pages' && (result.status !== 'complete' || result.scope !== 'population')) invalid(`${field}.coverage: completed population scan required`)
  if (result.status === 'complete' && (result.coverage !== 'all-pages' || result.scope !== 'population'
    || result.pages.failed !== 0 || result.pages.expectedAtEnd === null || result.pages.expectedAtEnd < 1
    || result.pages.succeeded < result.pages.expectedAtEnd || result.observedIdCount === null || result.reportedTotalAtEnd === null)) {
    invalid(`${field}.complete: all pages required`)
  }
  if (result.phase === 'baseline' || ['failed', 'missing'].includes(result.status)) {
    if (result.newObservedCount !== null || result.newObservedLowerBound !== null) invalid(`${field}.newObservedCount: unavailable for this run`)
  } else if (result.status === 'complete') {
    if (result.newObservedCount === null || result.newObservedLowerBound !== null) invalid(`${field}.newObservedCount: complete count required`)
  } else if (result.newObservedCount !== null) invalid(`${field}.newObservedCount: incomplete scan`)
  for (const key of ['newObservedCount', 'newObservedLowerBound'] as const) {
    if (result[key] !== null && (result.observedIdCount === null || result[key] > result.observedIdCount)) invalid(`${field}.${key}: exceeds observed IDs`)
  }
  return result
}

export function parsePlayerObservationDataset(value: unknown): PlayerObservationDataset {
  const input = record(value, 'dataset', ['schemaVersion', 'definitionVersion', 'seriesId', 'generatedAt', 'source', 'conditions', 'baseline', 'runs'])
  if (input.schemaVersion !== 1) invalid('schemaVersion')
  if (input.definitionVersion !== 1) invalid('definitionVersion')
  if (input.seriesId !== 'buckler-max-lp-v1') invalid('seriesId')
  const generatedAt = timestamp(input.generatedAt, 'generatedAt')
  const baselineInput = record(input.baseline, 'baseline', ['status', 'completedAt'])
  if (baselineInput.status !== 'preparing' && baselineInput.status !== 'ready') invalid('baseline.status')
  const completedAt = nullableTimestamp(baselineInput.completedAt, 'baseline.completedAt')
  if ((baselineInput.status === 'ready') !== (completedAt !== null)
    || (completedAt !== null && Date.parse(completedAt) > Date.parse(generatedAt))) invalid('baseline.completedAt')
  const runs = array(input.runs, 'runs').map((value, index) => run(value, index, generatedAt))
  if (new Set(runs.map(item => item.id)).size !== runs.length) invalid('runs.id: duplicate')
  const completedBaselineRuns = runs.filter(item => item.phase === 'baseline' && item.status === 'complete')
  if (completedAt === null ? completedBaselineRuns.length > 0 : completedBaselineRuns.length !== 1
    || Date.parse(completedBaselineRuns[0].endedAt!) !== Date.parse(completedAt)) invalid('baseline: completed scan mismatch')
  for (const item of runs) {
    if (item.phase === 'observation' && (completedAt === null || item.startedAt !== null && Date.parse(item.startedAt) < Date.parse(completedAt)
      || item.startedAt === null && Date.parse(item.scheduledAt) < Date.parse(completedAt))) invalid(`runs.${item.id}: baseline not ready at observation`)
    const baselineEnd = item.status === 'missing' ? item.scheduledAt : item.endedAt
    if (item.phase === 'baseline' && completedAt !== null && (baselineEnd === null || Date.parse(baselineEnd) > Date.parse(completedAt))) {
      invalid(`runs.${item.id}: baseline phase after completion`)
    }
  }
  return {
    schemaVersion: 1, definitionVersion: 1, seriesId: 'buckler-max-lp-v1', generatedAt,
    source: source(input.source), conditions: conditions(input.conditions),
    baseline: { status: baselineInput.status, completedAt }, runs,
  }
}

const requests = new Map<string, Promise<PlayerObservationDataset>>()

export function loadPlayerObservations(): Promise<PlayerObservationDataset> {
  const base = import.meta.env?.BASE_URL ?? '/'
  const url = `${base.endsWith('/') ? base : `${base}/`}data/player-observations/index.json`
  const existing = requests.get(url)
  if (existing) return existing
  const request = Promise.resolve().then(() => fetch(url)).then(async response => {
    if (!response.ok) throw new Error('新規観測データを読み込めませんでした。もう一度お試しください。')
    return parsePlayerObservationDataset(await response.json())
  }).catch(cause => {
    if (requests.get(url) === request) requests.delete(url)
    throw cause
  })
  requests.set(url, request)
  return request
}

export function clearPlayerObservationRequests(): void {
  requests.clear()
}

function jstDate(value: string): string {
  return new Date(Date.parse(value) + JST_OFFSET).toISOString().slice(0, 10)
}

export function playerObservationRunDate(run: PlayerObservationRun): string {
  return jstDate(run.startedAt ?? run.scheduledAt)
}

function runDateRange(run: PlayerObservationRun, generatedAt: string): { fromDate: string; toDate: string } {
  const fromDate = playerObservationRunDate(run)
  return { fromDate, toDate: jstDate(run.endedAt ?? (run.status === 'running' ? generatedAt : run.startedAt ?? run.scheduledAt)) }
}

export function playerObservationDateRange(dataset: PlayerObservationDataset): { fromDate: string; toDate: string } {
  const ranges = dataset.runs.map(run => runDateRange(run, dataset.generatedAt))
  if (!ranges.length) { const date = jstDate(dataset.generatedAt); return { fromDate: date, toDate: date } }
  return { fromDate: ranges.map(item => item.fromDate).sort()[0], toDate: ranges.map(item => item.toDate).sort().at(-1)! }
}

export function initialPlayerObservationSelection(dataset: PlayerObservationDataset): PlayerObservationSelection {
  return { ...playerObservationDateRange(dataset), status: 'all' }
}

/** Include any observation interval overlapping selected JST days, including multi-day scans. */
export function filterPlayerObservationRuns(dataset: PlayerObservationDataset, selection: PlayerObservationSelection): PlayerObservationRun[] {
  const from = calendarDate(selection.fromDate, 'fromDate')
  const to = calendarDate(selection.toDate, 'toDate')
  if (from > to) throw new Error('開始日は終了日以前にしてください。')
  if (!['all', 'baseline', ...RUN_STATUSES].includes(selection.status)) invalid('selection.status')
  return dataset.runs.filter(run => {
    const range = runDateRange(run, dataset.generatedAt)
    return range.fromDate <= to && range.toDate >= from
      && (selection.status === 'all' || selection.status === 'baseline' && run.phase === 'baseline' || run.status === selection.status)
  }).sort((left, right) => Date.parse(left.startedAt ?? left.scheduledAt) - Date.parse(right.startedAt ?? right.scheduledAt) || left.id.localeCompare(right.id))
}

export function playerObservationRunStatusLabel(run: PlayerObservationRun): string {
  const label: Record<PlayerObservationRunStatus, string> = {
    running: '取得中', complete: '走査完了', partial: '部分取得', failed: '取得失敗', missing: '欠測',
  }
  return run.phase === 'baseline' ? run.status === 'complete' ? '基準走査完了' : `基準準備（${label[run.status]}）` : label[run.status]
}

export function playerObservationRunCountLabel(run: PlayerObservationRun): string {
  if (run.newObservedCount !== null) return run.newObservedCount.toLocaleString('ja-JP')
  if (run.newObservedLowerBound !== null) return `少なくとも ${run.newObservedLowerBound.toLocaleString('ja-JP')} 件（暫定）`
  return '—'
}
