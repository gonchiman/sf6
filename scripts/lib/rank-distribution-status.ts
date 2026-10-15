import { randomUUID } from 'node:crypto'
import { lstat, open, readFile, rename, unlink } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseRankDistributionManifest } from '../../src/lib/rankDistribution.ts'
import type { RankDistributionManifest } from '../../src/types/rankDistribution.ts'
import { rankDistributionPathWithin, validateRankDistributionDirectory } from '../validate-rank-distribution-data.ts'

const messages = {
  'source-changed': 'Bucklerの取得条件または表示形式の変更を確認したため、ランク分布を更新していません。',
  'unknown-rank': '不明なランク区分またはLPとの不一致があるため、ランク分布を更新していません。',
  'evidence-unconfirmed': '集計に必要な確認が完了していないため、検証済みのランク分布として登録していません。',
  'authentication-required': 'Bucklerでログインが必要な表示を確認したため、ランク分布を取得できませんでした。',
  'authentication-unconfirmed': 'Bucklerの画面でログイン状態を確認できなかったため、ランク分布の取得を完了できませんでした。',
  'access-denied': 'Bucklerへのアクセスが拒否されたため、ランク分布を取得できませんでした。',
  maintenance: 'Bucklerのメンテナンス表示を確認したため、ランク分布を取得できませんでした。',
  'read-failed': '取得ページの読み取りを完了できなかったため、ランク分布を更新していません。',
  'publication-failed': '検証済みの集計結果を保存または取り込みできなかったため、ランク分布を更新していません。',
  'configuration-invalid': '取得設定を確認できなかったため、ランク分布を更新していません。',
  'checkpoint-unavailable': '取得途中の探索位置を確認または保存できなかったため、ランク分布を更新していません。',
  cancelled: '取得を中止したため、ランク分布を更新していません。',
  'request-limit': '取得回数の上限に達したため、ランク分布を更新していません。',
  'observation-changed': '取得中に総件数または確認したページ内容が変化したため、ランク分布を更新していません。',
} as const

export type RankDistributionAvailabilityReason = keyof typeof messages
export interface RecordRankDistributionAvailabilityOptions {
  status: 'collection-failed' | 'verification-pending'
  reason: RankDistributionAvailabilityReason
  checkedAt: string
  /** Override for isolated tests; production callers use the repository's fixed data directory. */
  directory?: string
}

const defaultDirectory = fileURLToPath(new URL('../../public/data/rank-distribution/', import.meta.url))
const knownOptions = ['status', 'reason', 'checkedAt', 'directory']

function errorCode(error: unknown, value: string): boolean {
  return error !== null && typeof error === 'object' && 'code' in error && error.code === value
}

async function checkDirectoryParents(directory: string): Promise<void> {
  for (let current = directory; ; current = dirname(current)) {
    const stat = await lstat(current)
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('ランク分布の保存先にリンク等は指定できません。')
    if (current === dirname(current)) return
  }
}

/** Record only a fixed, non-private status; never replace verified snapshot files with partial results. */
export async function recordRankDistributionAvailability(options: RecordRankDistributionAvailabilityOptions): Promise<RankDistributionManifest> {
  if (!options || typeof options !== 'object' || Array.isArray(options)
    || Object.keys(options).some(key => !knownOptions.includes(key))
    || !['collection-failed', 'verification-pending'].includes(options.status)
    || typeof options.reason !== 'string' || !Object.hasOwn(messages, options.reason)
    || typeof options.checkedAt !== 'string'
    || options.directory !== undefined && (typeof options.directory !== 'string' || !options.directory.trim())) {
    throw new Error('ランク分布の取得状況の指定が正しくありません。')
  }
  // The existing manifest parser also validates calendar dates and timezone-bearing timestamps.
  const status = options.status
  const checkedAt = options.checkedAt
  const message = messages[options.reason]
  const directory = resolve(options.directory ?? defaultDirectory)
  const parent = dirname(directory)
  if (parent === directory) throw new Error('ランク分布の保存先にルートディレクトリは指定できません。')
  await checkDirectoryParents(directory)
  const lockPath = resolve(parent, `.${basename(directory)}-import.lock`)
  const lock = await open(lockPath, 'wx', 0o600).catch(error => {
    if (errorCode(error, 'EEXIST')) throw new Error('ランク分布の取り込みロックが存在します。別の処理の終了を確認してください。')
    throw error
  })
  let temporaryPath: string | undefined
  let ownsTemporary = false
  let committed = false
  try {
    await checkDirectoryParents(directory)
    await validateRankDistributionDirectory(directory)
    const indexPath = resolve(directory, 'index.json')
    const previousText = await readFile(indexPath, 'utf8')
    const previous = parseRankDistributionManifest(JSON.parse(previousText))
    const next = parseRankDistributionManifest({
      ...previous, generatedAt: checkedAt, availability: { status, message, checkedAt },
    })
    if (Date.parse(checkedAt) < Date.parse(previous.generatedAt)) {
      throw new Error('既存の一覧より前の確認日時では取得状況を更新できません。')
    }
    temporaryPath = resolve(parent, `.${basename(directory)}-status-${randomUUID()}.tmp`)
    if (!rankDistributionPathWithin(parent, temporaryPath)) throw new Error('ランク分布の作業先が正しくありません。')
    const temporary = await open(temporaryPath, 'wx', 0o600)
    ownsTemporary = true
    try {
      await temporary.writeFile(`${JSON.stringify(next, null, 2)}\n`, 'utf8')
      await temporary.sync()
    } finally { await temporary.close() }
    // Recheck the existing tree just before committing; cooperative importers share this lock.
    await checkDirectoryParents(directory)
    await validateRankDistributionDirectory(directory)
    if (await readFile(indexPath, 'utf8') !== previousText) throw new Error('更新中にランク分布の一覧が変化したため、取得状況を保存していません。')
    const temporaryStat = await lstat(temporaryPath)
    if (temporaryStat.isSymbolicLink() || !temporaryStat.isFile()) throw new Error('ランク分布の作業ファイルが正しくありません。')
    await rename(temporaryPath, indexPath)
    ownsTemporary = false
    committed = true
    return next
  } finally {
    // Cleanup problems must not turn a completed atomic update into a reported failed capture.
    if (temporaryPath && ownsTemporary) {
      try { await unlink(temporaryPath) } catch { console.warn('ランク分布の取得状況の作業ファイルの後片付けが残っています。') }
    }
    try { await lock.close() } catch { console.warn('ランク分布の取得状況のロックを閉じられませんでした。') }
    try { await unlink(lockPath) } catch {
      console.warn(committed ? '取得状況は保存済みですが、取り込みロックの後片付けが残っています。' : 'ランク分布の取り込みロックの後片付けが残っています。')
    }
  }
}
