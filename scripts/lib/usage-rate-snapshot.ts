import { parseCharacterManifest } from '../../src/lib/characters.ts'
import { parseUsageRateDataset, parseUsageRateDescriptor, usageRatePercentThousandths, USAGE_RATE_EDITION_LEAGUES, USAGE_RATE_EDITION_SOURCES } from '../../src/lib/usageRates.ts'
import type { CharacterDescriptor } from '../../src/types/characters.ts'
import type { UsageRateControlType, UsageRateDataset, UsageRateEdition, UsageRateTotalMismatch } from '../../src/types/usageRates.ts'

type UnknownRecord = Record<string, unknown>
export interface UsageRateSnapshotCoverage {
  edition: UsageRateEdition
  sourceUrl: string
  months: string[]
}
export interface NormalizedUsageRateSnapshots {
  schemaVersion: 1
  datasets: UsageRateDataset[]
}
const CONTROLS: Readonly<Record<UsageRateEdition, readonly UsageRateControlType[]>> = {
  general: ['all', 'classic', 'modern'], master: ['all'],
}

function invalid(field: string): never {
  throw new Error(`使用率スナップショットの形式が正しくありません（${field}）。`)
}
function record(value: unknown, field: string): UnknownRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid(field)
  return value as UnknownRecord
}
function array(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) invalid(field)
  return value
}
function string(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value || value !== value.trim()) invalid(field)
  return value
}
function edition(value: unknown): UsageRateEdition {
  if (value !== 'general' && value !== 'master') invalid('edition')
  return value
}
function month(value: unknown): string {
  const result = string(value, 'month')
  if (!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(result)) invalid('month')
  return result
}
function sourceUrl(value: unknown, selectedEdition: UsageRateEdition): string {
  const result = string(value, 'sourceUrl')
  if (result !== USAGE_RATE_EDITION_SOURCES[selectedEdition].url) invalid('sourceUrl: edition mismatch')
  return result
}
function league(value: unknown, selectedEdition: UsageRateEdition): string {
  const result = string(value, 'league').replaceAll(' ', '_')
  if (!USAGE_RATE_EDITION_LEAGUES[selectedEdition].includes(result)) invalid('league')
  return result
}
function unique(values: string[], field: string): void {
  if (new Set(values).size !== values.length) invalid(`${field}: duplicate`)
}

/** Resolve official list names by exact registry names and two explicit regional aliases. */
function characterNames(manifest: unknown): Map<string, CharacterDescriptor> {
  const characters = parseCharacterManifest(manifest).characters
  const names = new Map(characters.map((character) => [character.englishName, character]))
  if (names.size !== characters.length) invalid('characters.englishName: duplicate')
  for (const [officialName, id] of [['GOUKI', 'gouki_akuma'], ['VEGA', 'vega_mbison']]) {
    const character = characters.find((item) => item.id === id)
    if (character) {
      if (names.has(officialName) && names.get(officialName)!.id !== id) invalid('characters: alias collision')
      names.set(officialName, character)
    }
  }
  return names
}

/**
 * Require every discovered month, control type and rank before making publishable datasets.
 * Different published rosters are retained verbatim; absent characters are never filled with zero.
 */
export function normalizeUsageRateSnapshots(value: unknown, characterManifest: unknown, generatedAt = new Date().toISOString()): NormalizedUsageRateSnapshots {
  const input = record(value, 'bundle')
  if (input.schemaVersion !== 1 || input.kind !== 'buckler-usage-rate-snapshots') invalid('bundle version/kind')
  const names = characterNames(characterManifest)
  const coverage = array(input.editions, 'editions').map((value): UsageRateSnapshotCoverage => {
    const item = record(value, 'editions[]')
    const selectedEdition = edition(item.edition)
    const months = array(item.months, 'editions.months').map(month)
    if (months.length === 0) invalid('editions.months: empty')
    unique(months, 'editions.months')
    return { edition: selectedEdition, sourceUrl: sourceUrl(item.sourceUrl, selectedEdition), months }
  })
  if (coverage.length === 0) invalid('editions: empty')
  unique(coverage.map((item) => item.edition), 'editions')
  const expected = new Set(coverage.flatMap((item) => item.months.flatMap((selectedMonth) =>
    CONTROLS[item.edition].map((controlType) => `${item.edition}/${selectedMonth}/${controlType}`))))
  const found = new Set<string>()
  const datasets = new Map<string, {
    edition: UsageRateEdition; month: string; league: string; capturedAt: string;
    captures: string[]; pages: string[]; warnings: string[]; distributions: UsageRateDataset['distributions'];
  }>()
  for (const raw of array(input.snapshots, 'snapshots')) {
    const item = record(raw, 'snapshot')
    const selectedEdition = edition(item.edition)
    sourceUrl(item.sourceUrl, selectedEdition)
    const selectedMonth = month(item.month)
    const capturedPageUrl = item.capturedPageUrl === undefined ? undefined : string(item.capturedPageUrl, 'capturedPageUrl')
    if (capturedPageUrl !== undefined && capturedPageUrl !== item.sourceUrl
      && capturedPageUrl !== `${item.sourceUrl}/${selectedMonth.replace('-', '')}`) invalid('capturedPageUrl: selected month mismatch')
    if (!CONTROLS[selectedEdition].includes(item.controlType as UsageRateControlType)) invalid('controlType')
    const controlType = item.controlType as UsageRateControlType
    const condition = `${selectedEdition}/${selectedMonth}/${controlType}`
    if (!expected.has(condition)) invalid(`snapshot condition not in coverage: ${condition}`)
    if (found.has(condition)) invalid(`snapshot condition duplicate: ${condition}`)
    found.add(condition)
    const capturedAt = string(item.capturedAt, 'capturedAt')
    parseUsageRateDescriptor({ id: 'snapshot', edition: selectedEdition, month: selectedMonth,
      league: USAGE_RATE_EDITION_LEAGUES[selectedEdition][0], path: 'snapshot.json', capturedAt })
    if (!Number.isFinite(Date.parse(capturedAt)) || Date.parse(capturedAt) > Date.parse(generatedAt)) invalid('capturedAt/generatedAt')
    const leagues = array(item.leagues, 'leagues').map((value) => {
      const rawLeague = record(value, 'leagues[]')
      const selectedLeague = league(rawLeague.league, selectedEdition)
      const entries = array(rawLeague.entries, 'entries').map((value) => {
        const entry = record(value, 'entry')
        const officialName = string(entry.name, 'entry.name')
        const character = names.get(officialName)
        if (!character) invalid(`unknown official character name: ${officialName}`)
        const rawText = string(entry.text, 'entry.text')
        const text = rawText.endsWith('%') ? rawText.slice(0, -1) : rawText
        return { characterId: character.id, name: character.name, text, percentThousandths: usageRatePercentThousandths(text) }
      })
      if (!entries.some((entry) => entry.percentThousandths !== null)) invalid(`entries: no numeric values (${condition}/${selectedLeague})`)
      // The dataset parser checks every annotation field against the actual sum and source.
      // Merely observing a mismatch must not automatically authorize bypassing validation.
      const totalMismatch = rawLeague.totalMismatch as UsageRateTotalMismatch | undefined
      return { league: selectedLeague, entries, ...(totalMismatch === undefined ? {} : { totalMismatch }) }
    })
    unique(leagues.map((item) => item.league), 'leagues')
    if (leagues.length !== USAGE_RATE_EDITION_LEAGUES[selectedEdition].length) invalid(`leagues: incomplete (${condition})`)
    for (const item of leagues) {
      const key = `${selectedEdition}/${selectedMonth}/${item.league}`
      const target = datasets.get(key) ?? { edition: selectedEdition, month: selectedMonth, league: item.league, capturedAt, captures: [], pages: [], warnings: [], distributions: [] }
      if (Date.parse(capturedAt) > Date.parse(target.capturedAt)) target.capturedAt = capturedAt
      target.captures.push(`${controlType.toUpperCase()}: ${capturedAt}`)
      if (capturedPageUrl && !target.pages.includes(capturedPageUrl)) target.pages.push(capturedPageUrl)
      target.distributions.push({ controlType, month: selectedMonth, league: item.league, entries: item.entries,
        ...(item.totalMismatch === undefined ? {} : { totalMismatch: item.totalMismatch }) })
      if (item.totalMismatch !== undefined) {
        target.warnings.push(`${controlType.toUpperCase()}の掲載値合計は${(item.totalMismatch.observedPercentThousandths / 1000).toFixed(3)}%。${item.totalMismatch.reason}（再確認: ${item.totalMismatch.verifiedAt} / ${item.totalMismatch.sourceUrl}）。掲載値を変更せず保持。`)
      }
      datasets.set(key, target)
    }
  }
  if (found.size !== expected.size) {
    const missing = [...expected].filter((key) => !found.has(key))
    invalid(`coverage incomplete: ${missing.join(', ')}`)
  }
  return {
    schemaVersion: 1,
    datasets: [...datasets.values()].map((item) => parseUsageRateDataset({
      schemaVersion: 1,
      id: `${item.month}-${item.edition === 'master' ? 'master-edition-' : ''}${item.league.toLowerCase()}`,
      ...(item.edition === 'master' ? { edition: item.edition } : {}),
      month: item.month, league: item.league, capturedAt: item.capturedAt, generatedAt,
      source: {
        ...USAGE_RATE_EDITION_SOURCES[item.edition],
        population: '公式のランクマッチ統計（選択月・掲載リーグ）',
        metric: item.edition === 'general' ? 'ALL・CLASSIC・MODERNそれぞれのキャラクター使用率' : 'マスター版の操作タイプ合算キャラクター使用率',
        unit: '公開された割合（%）。1使用の集計単位と分母の詳細は未確認。',
        notes: [
          '公式ページの掲載値を読み取り、小数第3位をそのまま保存。合計100%への再正規化は行わない。',
          '未掲載のキャラクターは0%として補完しない。操作タイプごとの掲載キャラクター数が異なる場合がある。',
          'プレイヤー人数・試合数・割合の分母は取得していない。人数比や正確な件数は復元しない。',
          'パッチ・地域・その他の除外条件はこの公開表から未確認。',
          'BucklerのGOUKI/VEGAはキャラクター一覧のAKUMA/M. BISONに明示対応して識別する。',
          ...(item.edition === 'master' ? ['総合版MASTERとは別の掲載区分として保持。各区分のMR境界と対象プレイヤーの判定時点は未確認。'] : []),
          `各表示の取得日時（UTC）: ${item.captures.join(' / ')}`,
          ...(item.pages.length ? [`取得時のページURL: ${item.pages.join(' / ')}`] : []),
          ...item.warnings,
        ],
      },
      distributions: item.distributions.sort((a, b) => CONTROLS[item.edition].indexOf(a.controlType) - CONTROLS[item.edition].indexOf(b.controlType)),
    })).sort((a, b) => a.id.localeCompare(b.id)),
  }
}
