import type {
  AdjustmentAnalysisCategoryId, AdjustmentAnalysisDirection, AdjustmentAnalysisFilters,
  AdjustmentAnalysisResult, AdjustmentAnalysisRow,
} from '../types/balanceAdjustmentAnalysis.ts'
import type { BalanceAdjustmentChange, BalanceAdjustmentPatchDetails } from '../types/balanceAdjustmentDetails.ts'
import type { BalanceAdjustmentSource } from '../types/balanceAdjustments.ts'

export const ADJUSTMENT_ANALYSIS_CATEGORIES: readonly { id: AdjustmentAnalysisCategoryId; label: string }[] = [
  { id: 'damage', label: 'ダメージ・補正' },
  { id: 'startup', label: '発生' },
  { id: 'active', label: '持続' },
  { id: 'recovery', label: '硬直・全体動作' },
  { id: 'frame-advantage', label: '硬直差' },
  { id: 'hitbox', label: '攻撃判定・リーチ' },
  { id: 'hurtbox', label: 'やられ判定' },
  { id: 'invincibility', label: '無敵' },
  { id: 'gauge', label: 'ゲージ' },
  { id: 'movement', label: '移動' },
  { id: 'pushback', label: '押し戻し・吹き飛び距離' },
  { id: 'cancel', label: 'キャンセル' },
  { id: 'input', label: '入力' },
  { id: 'hit-effect', label: 'ヒット効果・時間' },
  { id: 'unclassified', label: '未分類' },
]

interface Span { start: number; end: number }
interface ElementMatch extends Span { categoryId: AdjustmentAnalysisCategoryId; label: string }
interface Operation { start: number; direction: AdjustmentAnalysisDirection }
type UnevaluatedRow = Omit<AdjustmentAnalysisRow, 'evaluation'>
type Evaluation = AdjustmentAnalysisRow['evaluation']

// These terms identify the subject of an explicit modification. A term merely mentioned in a
// condition or comparison does not identify another change (e.g. 攻撃持続終了から…移動量を縮小).
const ELEMENT_RULES: readonly { categoryId: AdjustmentAnalysisCategoryId; pattern: string }[] = [
  { categoryId: 'damage', pattern: '削りダメージ(?:補正(?:率)?)?|コンボ補正(?:率)?|ダメージ補正(?:率)?|ダメージ' },
  { categoryId: 'startup', pattern: '(?:攻撃判定|ガード待機判定)の発生(?:タイミング)?|攻撃発生(?:時間)?|発生フレーム|発生時間|発生速度|発生' },
  { categoryId: 'active', pattern: '攻撃持続(?:時間|フレーム)?|持続時間' },
  { categoryId: 'frame-advantage', pattern: '(?:ヒット|ガード|空振り)(?:時|後)?の硬直差|硬直差|有利フレーム' },
  { categoryId: 'recovery', pattern: '全体動作|(?:ヒット|ガード|空振り)(?:時|後)の硬直(?!差)|着地(?:後)?硬直|硬直時間|硬直(?!差)' },
  { categoryId: 'hurtbox', pattern: 'やられ判定|喰らい判定' },
  { categoryId: 'hitbox', pattern: 'ガード待機判定|攻撃判定|リーチ' },
  { categoryId: 'invincibility', pattern: '(?:完全|打撃・投げ|打撃|投げ|飛び道具|足元|上半身|下半身|対空|空中攻撃|ジャンプ攻撃に対する)?無敵(?:時間)?' },
  { categoryId: 'gauge', pattern: '(?:SA|ドライブ|スーパーアーツ)ゲージ(?:増加量|減少量|消費量|回復量|回復速度|消費)?|ゲージ(?:増加量|減少量|消費量|回復量|回復速度)' },
  { categoryId: 'movement', pattern: '前進距離|後退距離|移動距離|移動量|移動速度|前進量|後退量|移動方向|前進速度|後退速度' },
  { categoryId: 'pushback', pattern: 'ヒット[/／]ガードバック|ヒットバック|ガードバック|吹き飛び距離|吹き飛ぶ距離|ノックバック' },
  { categoryId: 'cancel', pattern: 'キャンセル(?:可能(?:タイミング|時間|フレーム)|受付(?:時間|タイミング))?' },
  { categoryId: 'input', pattern: '先行入力(?:受付)?(?:時間|タイミング)?|入力受付(?:時間|タイミング)?|コマンド(?:入力)?|入力優先度' },
  { categoryId: 'hit-effect', pattern: '吹き飛び時間|吹き飛び(?:方向|高さ)|ダウン時間|ヒット効果|ヒットストップ|ガードストップ|のけぞり時間|受け身' },
]

const OPERATION_PATTERN = '(増加|減少|拡大|縮小|延長|短縮|付与|追加|削除|撤廃|変更|調整|修正|設定)(?:しました|します|した|し|する|させました|させる|$)|長くしました|短くしました|増やしました|減らしました|変えました|できるようにしました|できなくしました|可能にしました|不可にしました|になるようにしました'
const DIRECTION: Record<string, AdjustmentAnalysisDirection> = {
  増加: '増加', 増やしました: '増加', 延長: '増加', 長くしました: '増加',
  減少: '減少', 減らしました: '減少', 短縮: '減少', 短くしました: '減少',
  拡大: '拡大', 縮小: '縮小', 付与: '追加', 追加: '追加',
  削除: '削除', 撤廃: '削除', できるようにしました: '追加', 可能にしました: '追加',
  できなくしました: '削除', 不可にしました: '削除',
}
const QUANTITY = '[-+＋－−]?[0-9０-９]+(?:[.．][0-9０-９]+)?(?:F|Ｆ|フレーム|[%％]|秒|回|倍|ドット)?(?:\\s*[～〜~]\\s*[-+＋－−]?[0-9０-９]+(?:[.．][0-9０-９]+)?(?:F|Ｆ|フレーム|[%％]|秒|回|倍|ドット)?)?'

function trimSpan(description: string, span: Span): Span | null {
  const original = description.slice(span.start, span.end)
  const prefix = /^\s*(?:(?:[①-⑳㉑-㉟㊱-㊿]|[0-9０-９]+[.．](?![0-9０-９])|[・■●])\s*)*/u.exec(original)?.[0] ?? ''
  const suffix = /\s*$/u.exec(original)?.[0] ?? ''
  const start = span.start + prefix.length
  const end = span.end - suffix.length
  return start < end ? { start, end } : null
}

/** Split by source punctuation, retaining offsets in the original UTF-16 string. */
function descriptionSpans(description: string): Span[] {
  const result: Span[] = []
  let start = 0
  for (let index = 0; index < description.length; index += 1) {
    const character = description[index]
    const numbered = /[①-⑳㉑-㉟㊱-㊿]/u.test(character)
    if (numbered && index > start) {
      const before = trimSpan(description, { start, end: index })
      if (before) result.push(before)
      start = index
    }
    const delimiter = /[。！？\r\n]/u.test(character)
    // An explicit modification joined with し、 starts a new independent clause. A condition
    // ending with 際、/場合、 stays attached to its following subject.
    const parallel = character === '、' && /(?:増加|減少|拡大|縮小|延長|短縮|付与|追加|削除|変更|調整|修正)(?:し|して|しました|した)(?:が)?$/u.test(description.slice(start, index))
    if (delimiter || parallel) {
      const span = trimSpan(description, { start, end: index + 1 })
      if (span) result.push(span)
      start = index + 1
    }
  }
  const remainder = trimSpan(description, { start, end: description.length })
  if (remainder) result.push(remainder)
  // Even an empty official cell remains represented in the analysis.
  return result.length ? result : [{ start: 0, end: description.length }]
}

function cancelledSpans(description: string): Span[] {
  const result: Span[] = []
  let start: number | null = null
  for (const marker of description.matchAll(/【取消線】|【\/取消線】/gu)) {
    if (marker[0] === '【取消線】') {
      if (start === null) start = marker.index
    } else if (start !== null) {
      result.push({ start, end: marker.index + marker[0].length })
      start = null
    }
  }
  if (start !== null) result.push({ start, end: description.length })
  return result
}

function elementMatches(text: string): ElementMatch[] {
  const found: ElementMatch[] = []
  for (const rule of ELEMENT_RULES) {
    for (const match of text.matchAll(new RegExp(rule.pattern, 'gu'))) {
      found.push({ start: match.index, end: match.index + match[0].length, categoryId: rule.categoryId, label: match[0] })
    }
  }
  found.sort((a, b) => a.start - b.start || b.end - a.end)
  const unique: ElementMatch[] = []
  for (const match of found) {
    if (!unique.some(previous => match.start < previous.end && previous.start < match.end)) unique.push(match)
  }
  return unique
}

function operation(text: string): Operation | null {
  // A reported old bug, a negated change, and a future repair are not a new numeric change.
  if (/変更(?:は|が)?(?:あり|ござい)ません|変更(?:は|が)?ない|変更していません|次回.*(?:修正|変更)|予定|意図せず/u.test(text)) return null
  if (/(?:なっていた|なってしまう|なってしまって|していた|されていた|できていた|消失していた|しなかった).*(?:不具合|現象|点|のを|為|ため).*(?:修正|対応)/u.test(text)) return null
  if (/(?:不具合|現象|誤り)/u.test(text) && !/(?:を|が)[^。]*[⇒→][^。]*(?:に変更|に修正)/u.test(text)) return null
  // One unresolved sentence containing multiple numeric mappings cannot safely assign each
  // mapping to its subject. Keep that complete sentence unclassified instead of selecting one.
  if ([...text.matchAll(/[⇒→]/gu)].length > 1) return null
  const matches = [...text.matchAll(new RegExp(OPERATION_PATTERN, 'gu'))]
  if (matches.length > 1) return null
  const last = matches.at(-1)
  if (!last) return null
  return { start: last.index, direction: DIRECTION[last[1] ?? last[0]] ?? '変更' }
}

function changedElements(text: string, action: Operation): ElementMatch[] {
  const elements = elementMatches(text).filter(element => element.end <= action.start)
  // Prefer the explicit を/が/は object, excluding terms inside a comparison after that object.
  const direct = elements.filter(element => /^\s*(?:を|が|は)/u.test(text.slice(element.end, action.start))
    || (element.categoryId === 'cancel' && /^\s*(?:できる|できなく|可能|不可)/u.test(text.slice(element.end))))
  const subject = direct.at(-1)
  if (!subject) return []
  const selected = [subject]
  let next = subject
  for (let index = elements.indexOf(subject) - 1; index >= 0; index -= 1) {
    const previous = elements[index]
    if (!/^\s*(?:と|及び|および|・|[/／])\s*$/u.test(text.slice(previous.end, next.start))) break
    selected.unshift(previous)
    next = previous
  }
  return selected.flatMap(element => /^ヒット[/／]ガードバック$/u.test(element.label)
    ? [{ ...element, label: 'ヒットバック' }, { ...element, label: 'ガードバック' }] : [element])
}

function normalized(value: string): string {
  return value.replace(/[０-９]/gu, digit => String(digit.charCodeAt(0) - 0xff10))
    .replace(/[＋]/gu, '+').replace(/[－−]/gu, '-').replace(/[．]/gu, '.')
    .replace(/Ｆ|フレーム/gu, 'F').replace(/％/gu, '%').replace(/\s/gu, '')
}

function scalar(value: string): { number: number; unit: string } | null {
  const match = /^([-+]?\d+(?:\.\d+)?)(F|%|秒|回|倍|ドット)?$/u.exec(normalized(value))
  if (!match) return null
  const number = Number(match[1])
  return Number.isFinite(number) ? { number, unit: match[2] ?? '' } : null
}

function difference(beforeValue: string, afterValue: string): { label: string; amount: number } | null {
  const before = scalar(beforeValue)
  const after = scalar(afterValue)
  if (!before || !after || before.unit !== after.unit) return null
  const amount = Number((after.number - before.number).toPrecision(12))
  const unit = before.unit === '%' ? 'pt' : before.unit
  return { label: `${amount > 0 ? '+' : ''}${amount}${unit}`, amount }
}

function extractedValues(text: string, element: ElementMatch, action: Operation) {
  const values = { beforeValue: null as string | null, afterValue: null as string | null, deltaValue: null as string | null,
    direction: action.direction }
  const tail = text.slice(element.end)
  // Do not extract a scalar substring from a multi-hit sum/product or a parenthesized formula.
  // Leading signed scalars such as -5F⇒-4F remain valid; an operator between numbers is not.
  if (/[0-9０-９)]\s*[+＋×＊*÷/／−－-]\s*[-+＋−－]?[0-9０-９]/u.test(tail)) return values
  const arrows = [...tail.matchAll(/[⇒→]/gu)]
  if (arrows.length === 1) {
    const pair = new RegExp(`(?<![0-9０-９.．～〜~×])(${QUANTITY})\\s*[⇒→]\\s*(${QUANTITY})(?![0-9０-９.．～〜~])`, 'u').exec(tail)
    if (pair) {
      values.beforeValue = pair[1].trim()
      values.afterValue = pair[2].trim()
      const delta = difference(values.beforeValue, values.afterValue)
      values.deltaValue = delta?.label ?? null
      if (action.direction === '変更' && delta) values.direction = delta.amount > 0 ? '増加' : delta.amount < 0 ? '減少' : '変更'
      return values
    }
  }
  // Absolute after-values require に; a bare 1F増加 is a delta, never an old/new value.
  const after = new RegExp(`(?:を|が|は)\\s*(${QUANTITY})に(?:変更|修正|設定|増加|減少|延長|短縮)`, 'u').exec(tail)
  if (after) {
    values.afterValue = after[1].trim()
    return values
  }
  const deltaOnly = new RegExp(`(?:を|が|は)\\s*(${QUANTITY})(?:分)?(?:増加|減少|延長|短縮)`, 'u').exec(tail)
  const value = deltaOnly && scalar(deltaOnly[1])
  if (value && value.number >= 0 && (action.direction === '増加' || action.direction === '減少')) {
    const unit = value.unit === '%' ? 'pt' : value.unit
    values.deltaValue = `${action.direction === '増加' ? '+' : '-'}${value.number}${unit}`
  }
  return values
}

function extractCondition(text: string, element: ElementMatch): string | null {
  const prefix = text.slice(0, element.start)
  const endings = [...prefix.matchAll(/(?:場合(?:のみ)?|際(?:のみ)?|状況(?:のみ)?|(?:ヒット|ガード|空振り|バーンアウト|発動|派生|成立)(?:中|時|後)(?:のみ)?|(?:[0-9０-９FＦ～〜~]+(?:目)?まで)|のみ)/gu)]
  const last = endings.at(-1)
  if (last) return prefix.slice(0, last.index + last[0].length).trim() || null
  const embedded = /^(?:ヒット|ガード|空振り)(?:時|後)/u.exec(element.label)
  return embedded?.[0] ?? null
}

function unjudged(reason: string): Evaluation {
  return { verdict: 'unjudged', reason, ruleId: null }
}

/** Only four explicit, directional scalar changes have initial evaluation rules. */
function evaluateChange(row: UnevaluatedRow): Evaluation {
  const text = row.description.slice(row.evidence.start, row.evidence.end)
  if (row.officialCategoryLabel.includes('取消線') || cancelledSpans(row.description).some(span => span.start < row.evidence.end && row.evidence.start < span.end)
    || /^【取消線】[\s\S]*【\/取消線】$/u.test(row.target.trim())) return unjudged('取り消された記述のため')
  if (row.subjectId === 'common') return unjudged('共通の変更は評価対象外')
  if (/意図せず|次回|予定|不具合|現象|なっていた|されていた/u.test(text)) return unjudged('不具合・旧記述の文脈を要確認')
  if (row.status !== 'candidate') return unjudged('変更内容が未分類')

  let metric: { key: string; label: string; goodSign: 1 | -1; units: readonly string[]; pairOnly: boolean } | null = null
  if (row.categoryId === 'damage' && /^(?:削り)?ダメージ$/u.test(row.elementLabel)) {
    if (/補正|被ダメージ|受け(?:る|た)[^、。]*ダメージ|相手(?:側)?(?:の|が与える|が受ける)[^、。]*ダメージ/u.test(`${row.target}\n${text}`)) {
      return unjudged('補正・被ダメージ・相手側の変更は評価対象外')
    }
    metric = { key: 'damage', label: row.elementLabel, goodSign: 1, units: [''], pairOnly: false }
  } else if (row.categoryId === 'startup' && /^攻撃発生(?:時間)?$/u.test(row.elementLabel)) {
    metric = { key: 'attack-startup', label: '攻撃発生', goodSign: -1, units: ['F'], pairOnly: false }
  } else if (row.categoryId === 'recovery' && /^(?:全体動作|硬直(?:時間)?|着地(?:後)?硬直|(?:ヒット|ガード|空振り)(?:時|後)の硬直)$/u.test(row.elementLabel)) {
    metric = { key: 'self-recovery', label: row.elementLabel, goodSign: -1, units: ['F'], pairOnly: false }
  } else if (row.categoryId === 'frame-advantage' && /^(?:ヒット|ガード)(?:時|後)の硬直差$/u.test(row.elementLabel)) {
    metric = { key: 'frame-advantage', label: row.elementLabel, goodSign: 1, units: ['F', ''], pairOnly: true }
  }
  if (!metric) return unjudged('この変更要素の評価ルールは未対応')
  // A change in the opponent's recovery does not have the same sign as one's own recovery.
  if (/(?:相手|相手側|敵|敵側)(?:の|側の)[^、。]*(?:硬直|全体動作|攻撃発生)|相手側|受けるダメージ/u.test(`${row.target}\n${text}`)) {
    return unjudged('効果が及ぶ側を特定できないため')
  }
  if ((metric.key === 'self-recovery' && /(?:ガード|ヒット)硬直/u.test(text))
    || /(?:相手|相手側|敵|敵側)(?:への|に与える|にかかる)[^、。]*硬直/u.test(text)) {
    return unjudged('ガード・ヒット硬直の主体を要確認')
  }
  if (/条件により|場合によって|いずれか|相殺|一方|ただし/u.test(text)) return unjudged('複数条件・相反する記述を要確認')
  if (/[0-9０-９)]\s*[+＋×＊*÷/／−－-]\s*[-+＋−－]?[0-9０-９]/u.test(text)
    || [...text.matchAll(/[⇒→]/gu)].length > 1) return unjudged('式・複数の数値対応は評価対象外')

  let amount: number
  let unit: string
  let evidence: string
  if (row.beforeValue !== null && row.afterValue !== null) {
    const before = scalar(row.beforeValue)
    const after = scalar(row.afterValue)
    if (!before || !after || before.unit !== after.unit) return unjudged('変更前後を単一の数値として比較できないため')
    amount = after.number - before.number
    unit = before.unit
    if (!metric.units.includes(unit)) return unjudged('数値の単位が評価ルールの対象外')
    if (metric.key !== 'frame-advantage' && (before.number < 0 || after.number < 0)) return unjudged('ダメージ・動作時間に負の値があるため')
    evidence = `${row.beforeValue}から${row.afterValue}`
    if (row.deltaValue !== null) {
      const statedDelta = scalar(row.deltaValue)
      if (!statedDelta || statedDelta.unit !== unit || Math.abs(statedDelta.number - amount) > 1e-9) {
        return unjudged('変更前後と増減量が一致しないため')
      }
    }
  } else if (!metric.pairOnly && row.beforeValue === null && row.afterValue === null && row.deltaValue !== null) {
    const delta = scalar(row.deltaValue)
    if (!delta) return unjudged('増減量を単一の数値として比較できないため')
    amount = delta.number
    unit = delta.unit
    evidence = `${Math.abs(amount)}${unit}${amount > 0 ? '増加' : '減少'}`
  } else {
    return unjudged(metric.pairOnly ? '比較できる変更前後の数値が未抽出' : '比較できる変更前後・増減量が未抽出')
  }
  if (!metric.units.includes(unit)) return unjudged('数値の単位が評価ルールの対象外')
  if (amount === 0) return unjudged('変更前後の数値が同じため')
  if ((row.direction === '増加' && amount < 0) || (row.direction === '減少' && amount > 0)
    || (row.direction !== '増加' && row.direction !== '減少' && row.direction !== '変更')) {
    return unjudged('記述と数値の増減が一致しないため')
  }
  const verdict = Math.sign(amount) === metric.goodSign ? 'buff' : 'nerf'
  const change = metric.key === 'frame-advantage' ? (amount > 0 ? '改善' : '悪化')
    : metric.key === 'damage' ? (amount > 0 ? '増加' : '減少') : (amount < 0 ? '短縮' : '延長')
  return {
    verdict,
    reason: row.beforeValue !== null ? `${metric.label}が${evidence}へ${change}` : `${metric.label}が${evidence}`,
    ruleId: `${metric.key}-${amount > 0 ? 'increase' : 'decrease'}-v1`,
  }
}

function analyzeChange(change: BalanceAdjustmentChange, subjectId: string, subjectName: string,
  source: BalanceAdjustmentSource): AdjustmentAnalysisRow[] {
  const base = { sourceChangeId: change.id, subjectId, subjectName, target: change.target,
    officialCategoryLabel: change.categoryLabel, description: change.description, source }
  const cancelled = cancelledSpans(change.description)
  const cancelledRow = change.categoryLabel.includes('取消線') || /^【取消線】[\s\S]*【\/取消線】$/u.test(change.target.trim())
  const rows = descriptionSpans(change.description).flatMap<UnevaluatedRow>((span, spanIndex) => {
    const text = change.description.slice(span.start, span.end)
    const withdrawn = cancelledRow || cancelled.some(range => range.start < span.end && span.start < range.end)
    const action = withdrawn ? null : operation(text)
    const elements = action && !/^※/u.test(text) ? changedElements(text, action) : []
    if (!action || elements.length === 0) {
      return [{ ...base, id: `${subjectId}:${change.id}:${spanIndex}:unclassified`, categoryId: 'unclassified' as const,
        elementLabel: '未分類', direction: '不明' as const, beforeValue: null, afterValue: null, deltaValue: null,
        condition: null, evidence: span, status: 'unclassified' as const }]
    }
    return elements.map((element, elementIndex) => ({ ...base,
      id: `${subjectId}:${change.id}:${spanIndex}:${elementIndex}:${element.categoryId}`,
      categoryId: element.categoryId, elementLabel: element.label,
      ...extractedValues(text, element, action), condition: extractCondition(text, element),
      evidence: span, status: 'candidate' as const,
    }))
  })
  return rows.map(row => ({ ...row, evaluation: evaluateChange(row) }))
}

export function analyzeBalanceAdjustmentPatch(patch: BalanceAdjustmentPatchDetails): AdjustmentAnalysisResult {
  const subjects = [
    { id: 'common', name: '共通', changes: patch.common.changes, source: patch.source },
    ...patch.characters.filter(character => character.status === 'ready').map(character => ({
      id: character.characterId, name: character.name, changes: character.changes, source: character.source ?? patch.source,
    })),
  ]
  return {
    rows: subjects.flatMap(subject => subject.changes.flatMap(change => analyzeChange(change, subject.id, subject.name, subject.source))),
    sourceRowCount: subjects.reduce((sum, subject) => sum + subject.changes.length, 0),
  }
}

export function filterAdjustmentAnalysisRows(rows: readonly AdjustmentAnalysisRow[], filters: AdjustmentAnalysisFilters): AdjustmentAnalysisRow[] {
  return rows.filter(row => (filters.subjectId === 'all' || filters.subjectId === row.subjectId)
    && (filters.categoryId === 'all' || filters.categoryId === row.categoryId)
    && (filters.status === 'all' || filters.status === row.status)
    && (!filters.verdict || filters.verdict === 'all' || filters.verdict === row.evaluation.verdict))
}
