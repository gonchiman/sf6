import type { CharacterControlTypeRatioRow, CharacterControlTypeRatioSort } from '../types/characterControlTypeRatio.ts'
import type { ControlTypeRatioEstimate } from '../types/controlTypeRatio.ts'
import type { UsageRateDataset, UsageRateEntry } from '../types/usageRates.ts'
import { estimateControlTypeRatio } from './controlTypeRatio.ts'
import { parseUsageRateDataset } from './usageRates.ts'

function percent(entry: UsageRateEntry | undefined): number | null {
  return entry?.percentThousandths === null || entry?.percentThousandths === undefined
    ? null : entry.percentThousandths / 1000
}

/**
 * Project the existing global mixture onto each character in official ALL order.
 * An injected estimate must be the global estimate for this same dataset.
 * Published ALL is evidence only; the conditional ratio uses reconstructed ALL as its denominator.
 */
export function createCharacterControlTypeRatioRows(
  value: UsageRateDataset,
  estimate?: ControlTypeRatioEstimate,
): CharacterControlTypeRatioRow[] {
  let dataset = value
  let dataReason: string | null = null
  try { dataset = parseUsageRateDataset(value) } catch (cause) {
    dataReason = cause instanceof Error ? cause.message : '使用率データの形式を確認できません。'
  }
  const all = dataset.distributions.find((distribution) => distribution.controlType === 'all')?.entries ?? []
  const classic = new Map((dataset.distributions.find((distribution) => distribution.controlType === 'classic')?.entries ?? [])
    .map((entry) => [entry.characterId, entry]))
  const modern = new Map((dataset.distributions.find((distribution) => distribution.controlType === 'modern')?.entries ?? [])
    .map((entry) => [entry.characterId, entry]))
  const overall = estimate ?? estimateControlTypeRatio(dataset)
  const p = overall.modernRatio
  const globalReason = dataReason ?? (overall.status !== 'estimated'
    ? `全体の操作タイプ比率を推定できません：${overall.reason ?? '条件を確認できません。'}`
    : p === null || !Number.isFinite(p) || p < 0 || p > 1
      ? '全体の操作タイプ比率が0〜100%の範囲内で確認できません。' : null)

  return all.map((entry, officialOrder): CharacterControlTypeRatioRow => {
    const c = classic.get(entry.characterId)
    const m = modern.get(entry.characterId)
    const classicPercent = percent(c)
    const modernPercent = percent(m)
    const row: CharacterControlTypeRatioRow = {
      characterId: entry.characterId, name: entry.name, officialOrder,
      allText: entry.text, classicText: c?.text ?? null, modernText: m?.text ?? null,
      allPercent: percent(entry), classicPercent, modernPercent, reconstructedAllPercent: null,
      modernWithinCharacterRatio: null, classicWithinCharacterRatio: null,
      status: 'unavailable', reason: globalReason,
    }
    if (globalReason || p === null) return row
    if (classicPercent === null || modernPercent === null) {
      return { ...row, reason: 'CLASSICまたはMODERNの使用率が欠損・未掲載のため、キャラ内の比率を算出できません。' }
    }
    const modernContribution = p * modernPercent
    const reconstructedAllPercent = (1 - p) * classicPercent + modernContribution
    if (!Number.isFinite(reconstructedAllPercent) || reconstructedAllPercent <= 0) {
      return { ...row, reconstructedAllPercent, reason: '再現ALLが0%のため、キャラ内の比率を算出できません。' }
    }
    const modernWithinCharacterRatio = modernContribution / reconstructedAllPercent
    if (!Number.isFinite(modernWithinCharacterRatio) || modernWithinCharacterRatio < 0 || modernWithinCharacterRatio > 1) {
      return { ...row, reconstructedAllPercent, reason: 'キャラ内の推定比率が0〜100%の範囲内で確認できません。' }
    }
    return {
      ...row, status: 'estimated', reason: null, reconstructedAllPercent,
      modernWithinCharacterRatio, classicWithinCharacterRatio: 1 - modernWithinCharacterRatio,
    }
  })
}

/** Keep missing values last in both directions and use the original official order for ties. */
export function sortCharacterControlTypeRatioRows(
  rows: readonly CharacterControlTypeRatioRow[],
  sort: CharacterControlTypeRatioSort,
): CharacterControlTypeRatioRow[] {
  if (sort.key === 'official') return [...rows].sort((left, right) => left.officialOrder - right.officialOrder)
  const key = sort.key === 'modern' ? 'modernWithinCharacterRatio' : 'classicWithinCharacterRatio'
  const direction = sort.direction === 'ascending' ? 1 : -1
  return rows.map((row) => ({ row, value: row.status === 'estimated' && Number.isFinite(row[key]) ? row[key] : null }))
    .sort((left, right) => {
      if (left.value === null) return right.value === null ? left.row.officialOrder - right.row.officialOrder : 1
      if (right.value === null) return -1
      return (left.value - right.value) * direction || left.row.officialOrder - right.row.officialOrder
    })
    .map(({ row }) => row)
}
