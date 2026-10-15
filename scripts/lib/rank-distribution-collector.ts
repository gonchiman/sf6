import {
  parseRankDistributionDataset, RANK_DISTRIBUTION_CONDITIONS, RANK_DISTRIBUTION_SOURCE,
  RANK_DISTRIBUTION_VALIDATION_CHECKS,
} from '../../src/lib/rankDistribution.ts'
import type { RankDistributionDataset } from '../../src/types/rankDistribution.ts'
import {
  collectRankDistributionBoundaries, rankBoundaryPageUrl, RANK_BOUNDARY_SOURCE_URL,
} from './rank-distribution-boundaries.ts'
import type { RankBoundaryPage, RankLpBoundary } from './rank-distribution-boundaries.ts'

/** A caller records an actual observation; this collector does not manufacture evidence. */
export interface RankDistributionCollectionEvidence {
  status: 'confirmed'
  sourceUrl: string
  note: string
}

interface RankDistributionCollectionCommonOptions {
  fetchPage: (page: number, url: string) => Promise<RankBoundaryPage>
  /** Confirm the current LP thresholds or the official rank-ID/display-label mapping for the chosen mode. */
  currentMappingEvidence: RankDistributionCollectionEvidence
  maxLpAccountUnitEvidence: RankDistributionCollectionEvidence
  unrankedTailEvidence: RankDistributionCollectionEvidence
  now?: () => Date
  maxRequests?: number
  signal?: AbortSignal
}

export type RankDistributionCollectionOptions = RankDistributionCollectionCommonOptions & (
  /** Supply the current, independently confirmed mapping; no historical defaults are used. */
  | { mode?: 'league-point'; ranks: RankLpBoundary[] }
  /** Read IDs from the official rank display; do not supply or infer LP thresholds. */
  | { mode: 'rank-id'; ranks?: never }
)

export type RankDistributionCollectionErrorCode =
  | 'evidence-unconfirmed'
  | 'invalid-evidence'
  | 'evidence-source-mismatch'
  | 'invalid-options'
  | 'invalid-time'
  | 'invalid-rank-mapping'
  | 'page-read-failed'
  | 'invalid-page'
  | 'conditions-changed'
  | 'unknown-rank'
  | 'total-changed'
  | 'observation-changed'
  | 'request-limit'
  | 'cancelled'
  | 'collection-rejected'

const ERROR_MESSAGES: Record<RankDistributionCollectionErrorCode, string> = {
  'evidence-unconfirmed': '必要な確認根拠が揃っていません。',
  'invalid-evidence': '確認根拠の形式が正しくありません。',
  'evidence-source-mismatch': '確認根拠の出典が取得対象と一致しません。',
  'invalid-options': '取得処理の指定が正しくありません。',
  'invalid-time': '取得日時を正しく確認できませんでした。',
  'invalid-rank-mapping': '現在の36区分のLP・ランク対応が必要です。',
  'page-read-failed': '公式ランキングのページを読み取れませんでした。',
  'invalid-page': 'ページ番号・件数・表示内容を確認できませんでした。',
  'conditions-changed': '取得条件または表示中の出典が変わりました。',
  'unknown-rank': '未ランクまたは不明なランクがあり、補完せず取得を中止しました。',
  'total-changed': '取得中に総件数またはページ構成が変わりました。',
  'observation-changed': '再確認した一覧または境界の内容が一致しませんでした。',
  'request-limit': '取得回数の上限に達しました。',
  'cancelled': 'ランク分布の取得を中止しました。',
  'collection-rejected': 'ランク分布の検証を完了できませんでした。',
}

/** Codes and fixed messages are safe to report; transport errors and their causes are omitted. */
export class RankDistributionCollectionError extends Error {
  readonly code: RankDistributionCollectionErrorCode

  constructor(code: RankDistributionCollectionErrorCode) {
    super(ERROR_MESSAGES[code])
    this.name = 'RankDistributionCollectionError'
    this.code = code
  }
}

function fail(code: RankDistributionCollectionErrorCode): never {
  throw new RankDistributionCollectionError(code)
}

function cancelled(signal?: AbortSignal): void {
  if (signal?.aborted) fail('cancelled')
}

function evidenceSource(value: unknown): string {
  if (typeof value !== 'string') fail('evidence-source-mismatch')
  if (value === RANK_DISTRIBUTION_SOURCE.url) return value
  try {
    const url = new URL(value)
    const pageText = url.searchParams.get('page')
    const page = pageText === null ? 1 : Number(pageText)
    if (pageText !== null && (!/^[1-9]\d*$/.test(pageText) || !Number.isSafeInteger(page))) {
      fail('evidence-source-mismatch')
    }
    const normalized = rankBoundaryPageUrl(value, page)
    if (normalized !== rankBoundaryPageUrl(RANK_BOUNDARY_SOURCE_URL, page)) fail('evidence-source-mismatch')
    return normalized
  } catch {
    return fail('evidence-source-mismatch')
  }
}

export function validateRankDistributionCollectionEvidence(value: unknown): RankDistributionCollectionEvidence {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !('status' in value) || value.status !== 'confirmed') fail('evidence-unconfirmed')
  if (Object.keys(value).some((key) => !['status', 'sourceUrl', 'note'].includes(key))) fail('invalid-evidence')
  const input = value as Record<string, unknown>
  const sourceUrl = evidenceSource(input.sourceUrl)
  if (typeof input.note !== 'string' || !input.note.trim() || input.note !== input.note.trim()
    || input.note.length > 1000 || /[<>\u0000-\u001f\u007f]/.test(input.note)) fail('invalid-evidence')
  return { status: 'confirmed', sourceUrl, note: input.note }
}

function time(now: () => Date): string {
  try {
    const value = Date.prototype.getTime.call(now())
    if (!Number.isFinite(value)) fail('invalid-time')
    const result = new Date(value).toISOString()
    if (!/^\d{4}-\d{2}-\d{2}T/.test(result)) fail('invalid-time')
    return result
  } catch {
    return fail('invalid-time')
  }
}

/** Only classify fixed errors emitted by the existing pure boundary helper. */
function boundaryFailure(error: unknown): RankDistributionCollectionErrorCode {
  if (!(error instanceof Error)) return 'collection-rejected'
  const prefix = 'ランク分布の境界取得を中止しました: '
  if (!error.message.startsWith(prefix)) return 'collection-rejected'
  switch (error.message.slice(prefix.length)) {
    case '1〜36のLP・ランク対応が必要です。':
    case 'LP・ランク対応に重複、不明区分、または逆転があります。': return 'invalid-rank-mapping'
    case '取得回数の上限が不正です。':
    case '境界の比較方法が不正です。':
    case 'ランクID比較ではLP対応表を指定できません。': return 'invalid-options'
    case '取得が中止されました。': return 'cancelled'
    case '取得回数の上限に達しました。全件取得への切替は行いません。': return 'request-limit'
    case '取得中に総件数またはページ構成が変わりました。': return 'total-changed'
    case 'LP・ランク対応が一致しません。未ランクを補完しません。': return 'unknown-rank'
    case '取得中に表示条件が変更されました。':
    case '観測対象の固定条件が一致しません。':
    case '未確認の取得条件が含まれています。':
    case '公式LPランキング以外のURLは使用できません。': return 'conditions-changed'
    case '再確認したページの内容が変わりました。':
    case '確認した一覧にアカウント重複または位置変化があります。':
    case 'ランク境界の前後が一致しません。':
    case 'ページ内のLP順が逆転しています。':
    case 'ページ間のLP順が逆転しています。':
    case 'ページ内のランク順が逆転しています。':
    case 'ページ間のランク順が逆転しています。': return 'observation-changed'
    case 'ページ番号が不正です。':
    case 'ページ情報の形式または到達先が不正です。':
    case '表示中のURLが不正です。':
    case '表示中のURLで要求ページへの到達を確認できません。':
    case '総件数と最終ページが一致しません。':
    case '最終ページより後の取得結果です。':
    case 'ページの項目数が不足または過剰です。':
    case 'アカウント識別の確認値が不正です。': return 'invalid-page'
    default: return 'collection-rejected'
  }
}

/**
 * Collect a complete interval observation through an authorized reader. Explicit caller
 * evidence supplies the checks that page-boundary observations cannot establish alone.
 * This neither reads authentication nor writes files, retries, or enumerates all accounts.
 */
export async function collectRankDistributionDataset(
  options: RankDistributionCollectionOptions,
): Promise<RankDistributionDataset> {
  try {
    cancelled(options.signal)
    if (typeof options.fetchPage !== 'function' || (options.now !== undefined && typeof options.now !== 'function')) {
      fail('invalid-options')
    }
    const mapping = validateRankDistributionCollectionEvidence(options.currentMappingEvidence)
    const accountUnit = validateRankDistributionCollectionEvidence(options.maxLpAccountUnitEvidence)
    const tail = validateRankDistributionCollectionEvidence(options.unrankedTailEvidence)
    const now = options.now ?? (() => new Date())
    const captureStartedAt = time(now)
    const comparison = options.mode === 'rank-id'
      ? { mode: 'rank-id' as const, ranks: options.ranks }
      : { mode: options.mode, ranks: options.ranks }
    const result = await collectRankDistributionBoundaries({
      sourceUrl: RANK_BOUNDARY_SOURCE_URL, ...comparison,
      maxRequests: options.maxRequests, signal: options.signal,
      fetchPage: async (page, url) => {
        cancelled(options.signal)
        let value: RankBoundaryPage
        try { value = await options.fetchPage(page, url) } catch {
          cancelled(options.signal)
          return fail('page-read-failed')
        }
        cancelled(options.signal)
        return value
      },
    })
    cancelled(options.signal)
    const captureEndedAt = time(now)
    if (Date.parse(captureEndedAt) < Date.parse(captureStartedAt)) fail('invalid-time')
    // Only the successful helper's observed checks plus the two explicit extra confirmations.
    const checks = [...result.observedChecks, 'max-lp-account-unit-confirmed', 'unranked-tail-confirmed']
    if (new Set(checks).size !== RANK_DISTRIBUTION_VALIDATION_CHECKS.length
      || RANK_DISTRIBUTION_VALIDATION_CHECKS.some((check) => !checks.includes(check))) fail('collection-rejected')
    return parseRankDistributionDataset({
      schemaVersion: 1, id: `max-lp-${captureStartedAt.replace(/[:.]/g, '-')}`,
      captureStartedAt, captureEndedAt, generatedAt: captureEndedAt,
      source: {
        ...RANK_DISTRIBUTION_SOURCE, population: '総合・最大LP条件で掲載されたファイターアカウント',
        metric: 'LPランク別の掲載アカウント数', unit: 'fighter-account',
        notes: ['同じ人の別プラットフォームのアカウントを統合した実人数や、直近の活動人口ではない。'],
      },
      conditions: { ...RANK_DISTRIBUTION_CONDITIONS }, method: 'boundary-search',
      totalCount: result.totalCount,
      entries: result.entries.map(({ rankId, count }) => ({ rankId, count })),
      validation: {
        status: 'verified', coverage: 'all-listed-accounts', checks,
        notes: [
          `${options.mode === 'rank-id' ? '公式ランクID・表示名対応' : '現行LP・ランク対応'}の確認: ${mapping.note} 出典: ${mapping.sourceUrl}`,
          `最大LPのアカウント単位の確認: ${accountUnit.note} 出典: ${accountUnit.sourceUrl}`,
          `未ランク・不明区分と末尾の確認: ${tail.note} 出典: ${tail.sourceUrl}`,
          `先頭・末尾・全35境界の前後を再観測した。読取回数: ${result.requestCount}。`,
          '確認した全ページの総件数・ページ構成・再観測内容が一致した取得期間の観測値であり、単一時点の原子的なスナップショットや未観測行の一意性を証明しない。',
        ],
      },
    })
  } catch (error) {
    if (error instanceof RankDistributionCollectionError) throw error
    return fail(boundaryFailure(error))
  }
}
