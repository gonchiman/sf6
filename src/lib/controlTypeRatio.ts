import type { ControlTypeRatioDetail, ControlTypeRatioEstimate, ControlTypeRatioRow } from '../types/controlTypeRatio.ts'
import type { UsageRateDataset, UsageRateHistoryResult } from '../types/usageRates.ts'
import { parseUsageRateDataset, usageRateEditionOf } from './usageRates.ts'

function unavailable(characterCount: number, reason: string): ControlTypeRatioEstimate {
  return {
    status: 'unavailable', modernRatio: null, classicRatio: null, characterCount,
    maxAbsoluteErrorPoints: null, rmsErrorPoints: null, reason, details: [],
  }
}

/** Least-squares mixture of the published distributions; does not infer people or match counts. */
export function estimateControlTypeRatio(value: UsageRateDataset): ControlTypeRatioEstimate {
  let dataset: UsageRateDataset
  try { dataset = parseUsageRateDataset(value) } catch (cause) {
    return unavailable(0, cause instanceof Error ? cause.message : '使用率データの形式を確認できません。')
  }
  const all = dataset.distributions.find((item) => item.controlType === 'all')!.entries
  const mismatch = dataset.distributions.find((item) => item.totalMismatch)?.totalMismatch
  if (mismatch) {
    return unavailable(all.length, `公式使用率の合計が${(mismatch.observedPercentThousandths / 1000).toFixed(3)}%で、100%の丸め誤差の範囲を超えています。値を補正せず、操作タイプ比率は推定しません。`)
  }
  if (usageRateEditionOf(dataset) === 'master') {
    return unavailable(all.length, 'マスター版は操作タイプ別の使用率を公開していないため、混合比率を推定できません。')
  }
  const classic = new Map(dataset.distributions.find((item) => item.controlType === 'classic')!.entries.map((item) => [item.characterId, item]))
  const modern = new Map(dataset.distributions.find((item) => item.controlType === 'modern')!.entries.map((item) => [item.characterId, item]))
  if (classic.size !== all.length || modern.size !== all.length
    || all.some((entry) => !classic.has(entry.characterId) || !modern.has(entry.characterId))) {
    return unavailable(all.length, 'ALL・CLASSIC・MODERNのキャラクター集合が異なります。全キャラクターがそろった分布が必要です。')
  }
  if (dataset.distributions.some((item) => item.entries.some((entry) => entry.percentThousandths === null))) {
    return unavailable(all.length, 'ALL・CLASSIC・MODERNの使用率に欠損があります。全キャラクターの値が必要です。')
  }
  let numerator = 0
  let denominator = 0
  for (const entry of all) {
    const c = classic.get(entry.characterId)!.percentThousandths!
    const difference = modern.get(entry.characterId)!.percentThousandths! - c
    numerator += difference * (entry.percentThousandths! - c)
    denominator += difference * difference
  }
  if (denominator === 0) return unavailable(all.length, 'CLASSICとMODERNの分布が同じため、混合比率を特定できません。')
  const modernRatio = numerator / denominator
  if (!Number.isFinite(modernRatio) || modernRatio < 0 || modernRatio > 1) {
    return unavailable(all.length, '推定比率が0〜100%の範囲外です。同じ集計条件で合算された分布か確認が必要です。')
  }
  const classicRatio = 1 - modernRatio
  const details: ControlTypeRatioDetail[] = all.map((entry) => {
    const c = classic.get(entry.characterId)!
    const m = modern.get(entry.characterId)!
    const allPercent = entry.percentThousandths! / 1000
    const classicPercent = c.percentThousandths! / 1000
    const modernPercent = m.percentThousandths! / 1000
    const reconstructedAllPercent = classicRatio * classicPercent + modernRatio * modernPercent
    return {
      characterId: entry.characterId, name: entry.name, allText: entry.text, classicText: c.text, modernText: m.text,
      allPercent, classicPercent, modernPercent, reconstructedAllPercent,
      differencePoints: reconstructedAllPercent - allPercent,
    }
  })
  return {
    status: 'estimated', modernRatio, classicRatio, characterCount: all.length, reason: null, details,
    maxAbsoluteErrorPoints: Math.max(...details.map((entry) => Math.abs(entry.differencePoints))),
    rmsErrorPoints: Math.sqrt(details.reduce((sum, entry) => sum + entry.differencePoints ** 2, 0) / details.length),
  }
}

export function createControlTypeRatioRows(results: readonly UsageRateHistoryResult[]): ControlTypeRatioRow[] {
  return results.map((result) => {
    if (result.status === 'missing') return { month: result.month, status: 'missing', descriptor: null, dataset: null, estimate: null }
    if (result.status === 'error') return { month: result.month, status: 'error', descriptor: result.descriptor, dataset: null, estimate: null }
    try {
      if (result.month !== result.descriptor.month) throw new Error('月が一致しません。')
      const dataset = parseUsageRateDataset(result.dataset, result.descriptor)
      const estimate = estimateControlTypeRatio(dataset)
      return { month: result.month, status: estimate.status, descriptor: result.descriptor, dataset, estimate }
    } catch {
      return { month: result.month, status: 'error', descriptor: result.descriptor, dataset: null, estimate: null }
    }
  })
}
