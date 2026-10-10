import type {
  BalanceAdjustment,
  BalanceAdjustmentCatalog,
  BalanceAdjustmentMonth,
  BalanceAdjustmentSource,
} from '../types/balanceAdjustments.ts'

type UnknownRecord = Record<string, unknown>

function invalid(field: string): never {
  throw new Error(`バランス調整履歴の形式が正しくありません（${field}）。`)
}

function record(value: unknown, field: string): UnknownRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid(field)
  return value as UnknownRecord
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) invalid(field)
  return value
}

function month(value: unknown, field: string): string {
  const result = text(value, field)
  if (!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(result)) invalid(field)
  return result
}

function date(value: unknown, field: string): string {
  const result = text(value, field)
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(result)
  if (!match) invalid(field)
  const year = Number(match[1])
  const monthNumber = Number(match[2])
  const day = Number(match[3])
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const days = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  if (monthNumber < 1 || monthNumber > 12 || day < 1 || day > days[monthNumber - 1]) invalid(field)
  return result
}

function timestamp(value: unknown, field: string): string {
  const result = text(value, field)
  const match = /^(\d{4}-\d{2}-\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(result)
  if (!match || !Number.isFinite(Date.parse(result))) invalid(field)
  date(match[1], field)
  return result
}

function source(value: unknown, field: string, path: RegExp): BalanceAdjustmentSource {
  const input = record(value, field)
  const url = text(input.url, `${field}.url`)
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return invalid(`${field}.url`)
  }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'www.streetfighter.com'
    || parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash
    || !path.test(parsed.pathname)) invalid(`${field}.url`)
  return { url, title: text(input.title, `${field}.title`) }
}

function event(value: unknown, index: number): BalanceAdjustment {
  const field = `events[${index}]`
  const input = record(value, field)
  const id = text(input.id, `${field}.id`)
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id)) invalid(`${field}.id`)
  if (input.dateBasis !== 'effective' && input.dateBasis !== 'list') invalid(`${field}.dateBasis`)
  const announcement = input.announcement === null ? null : source(
    input.announcement, `${field}.announcement`, /^\/6\/buckler\/ja-jp\/information\/detail\/update\d{8}\/?$/,
  )
  if (input.dateBasis === 'effective' && announcement === null) invalid(`${field}.announcement`)
  return {
    id,
    date: date(input.date, `${field}.date`),
    dateBasis: input.dateBasis,
    kindLabel: text(input.kindLabel, `${field}.kindLabel`),
    title: text(input.title, `${field}.title`),
    source: source(input.source, `${field}.source`, /^\/6\/buckler\/ja-jp\/battle_change\/\d{6}(?:\d{2})?\/?$/),
    announcement,
  }
}

export function parseBalanceAdjustmentCatalog(value: unknown): BalanceAdjustmentCatalog {
  const input = record(value, 'catalog')
  if (input.schemaVersion !== 1) invalid('schemaVersion')
  const coverageInput = record(input.coverage, 'coverage')
  const fromMonth = month(coverageInput.fromMonth, 'coverage.fromMonth')
  const toMonth = month(coverageInput.toMonth, 'coverage.toMonth')
  if (fromMonth > toMonth) invalid('coverage')
  if (!Array.isArray(input.events)) invalid('events')
  const events = input.events.map(event)
  const seen = new Set<string>()
  for (const item of events) {
    if (seen.has(item.id)) invalid('events.id の重複')
    seen.add(item.id)
    const eventMonth = item.date.slice(0, 7)
    if (eventMonth < fromMonth || eventMonth > toMonth) invalid('events.date と coverage')
  }
  return {
    schemaVersion: 1,
    generatedAt: timestamp(input.generatedAt, 'generatedAt'),
    checkedAt: timestamp(input.checkedAt, 'checkedAt'),
    source: source(input.source, 'source', /^\/6\/buckler\/ja-jp\/information\/battle_change\/1\/?$/),
    coverage: { fromMonth, toMonth },
    events,
  }
}

let catalogRequest: Promise<BalanceAdjustmentCatalog> | null = null

export function loadBalanceAdjustmentCatalog(): Promise<BalanceAdjustmentCatalog> {
  if (catalogRequest) return catalogRequest
  const base = import.meta.env?.BASE_URL ?? '/'
  const url = `${base.endsWith('/') ? base : `${base}/`}data/balance-adjustments.json`
  const request = Promise.resolve().then(() => fetch(url)).then(async (response) => {
    if (!response.ok) throw new Error('バランス調整履歴を読み込めませんでした。もう一度お試しください。')
    return parseBalanceAdjustmentCatalog(await response.json())
  }).catch((cause) => {
    if (catalogRequest === request) catalogRequest = null
    throw cause
  })
  catalogRequest = request
  return request
}

export function balanceAdjustmentsForMonth(catalog: BalanceAdjustmentCatalog, value: string): BalanceAdjustmentMonth {
  const selectedMonth = month(value, 'month')
  if (selectedMonth < catalog.coverage.fromMonth || selectedMonth > catalog.coverage.toMonth) {
    return { month: selectedMonth, status: 'unverified', events: [] }
  }
  const events = catalog.events.filter((item) => item.date.slice(0, 7) === selectedMonth)
    .sort((first, second) => first.date.localeCompare(second.date) || first.id.localeCompare(second.id))
  return { month: selectedMonth, status: 'ready', events }
}

export function balanceAdjustmentShortDate(event: BalanceAdjustment): string {
  const [, monthNumber, day] = date(event.date, 'event.date').split('-')
  return `${Number(monthNumber)}/${Number(day)}${event.dateBasis === 'list' ? '（リスト日）' : ''}`
}
