import { createHash } from 'node:crypto'
import { lstat, readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { normalizeBucklerSnapshot } from './buckler-snapshot.ts'
import { publishWinRateBatch } from './publish-win-rates.ts'
import type { WinRateDataset } from '../../src/types/winRates.ts'

const FIRST_MONTH = '2023-06'
const LEAGUES = ['ROOKIE', 'IRON', 'BRONZE', 'SILVER', 'GOLD', 'PLATINUM', 'DIAMOND', 'MASTER']
const MODES = ['combined', 'separate']

export const UPDATE_HELP = `保存した公式表の月別スナップショットから公開用の勝率JSONを更新します。

使い方:
  npm run data:update -- --month YYYY-MM
  npm run data:update -- --from YYYY-MM --to YYYY-MM
  npm run data:update -- --all

対象の指定は、単月・期間・保存済み全月のいずれか1つです。
--all は入力先に存在する YYYY-MM.json だけを対象にします。

オプション:
  --input-dir PATH   公式表から書き出した月別JSONの入力先
  --cache-dir PATH   保存済み入力の場所（既定: .cache/win-rates/snapshots）
  --output-dir PATH  公開用JSONの出力先（既定: public/data/win-rates）
  --help            この説明を表示

--input-dir がなければ --cache-dir を読みます。入力ファイルは変更・コピーしません。
各月は snapshotVersion: 1、month、16条件の snapshots を持つJSONです。
全対象の検証に成功してから更新し、対象外の月は保持します。
ネットワークからの自動取得は行いません。入力不足時は公式表を書き出してください。`

export interface UpdateOptions {
  help: false
  months: string[] | null
  inputDirectory: string
  outputDirectory: string
  cacheDirectory: string
  transactionDirectory: string
  currentMonth: string
}

function currentMonthInJapan(now: Date): string {
  if (!Number.isFinite(now.getTime())) throw new Error('現在日時が正しくありません。')
  const parts = new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit',
  }).formatToParts(now)
  return `${parts.find((part) => part.type === 'year')!.value}-${parts.find((part) => part.type === 'month')!.value}`
}

function validateMonth(month: string, currentMonth: string): string {
  if (!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(month)) throw new Error(`月はYYYY-MM形式で指定してください: ${month}`)
  if (month < FIRST_MONTH) throw new Error(`${FIRST_MONTH}より前の月は指定できません: ${month}`)
  if (month > currentMonth) throw new Error(`未来の月は指定できません: ${month}`)
  return month
}

function monthRange(from: string, to: string): string[] {
  if (from > to) throw new Error('開始月は終了月以前にしてください。')
  const months: string[] = []
  for (let month = from; month <= to;) {
    months.push(month)
    const [year, number] = month.split('-').map(Number)
    month = number === 12 ? `${year + 1}-01` : `${year}-${String(number + 1).padStart(2, '0')}`
  }
  return months
}

export function parseUpdateArguments(
  args: readonly string[],
  { cwd = process.cwd(), now = new Date() }: { cwd?: string; now?: Date } = {},
): UpdateOptions | { help: true } {
  if (args.length === 1 && args[0] === '--help') return { help: true }
  const flags = new Set(['--all'])
  const valued = new Set(['--month', '--from', '--to', '--input-dir', '--cache-dir', '--output-dir'])
  const values = new Map<string, string>()
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index]
    if (!flags.has(option) && !valued.has(option)) throw new Error(`未対応の引数です: ${option}（--helpで確認できます）`)
    if (values.has(option)) throw new Error(`同じ引数は1回だけ指定してください: ${option}`)
    if (flags.has(option)) values.set(option, '')
    else {
      const value = args[++index]
      if (!value || value.startsWith('--') || value !== value.trim()) throw new Error(`引数の値がありません、または正しくありません: ${option}`)
      values.set(option, value)
    }
  }
  const isRange = values.has('--from') || values.has('--to')
  if (Number(values.has('--month')) + Number(values.has('--all')) + Number(isRange) !== 1) {
    throw new Error('--month、--fromと--to、--all のいずれか1つを指定してください。')
  }
  if (isRange && (!values.has('--from') || !values.has('--to'))) throw new Error('期間指定には --from と --to の両方が必要です。')

  const currentMonth = currentMonthInJapan(now)
  const months = values.has('--month') ? [validateMonth(values.get('--month')!, currentMonth)]
    : isRange ? monthRange(validateMonth(values.get('--from')!, currentMonth), validateMonth(values.get('--to')!, currentMonth)) : null
  const cacheDirectory = resolve(cwd, values.get('--cache-dir') ?? '.cache/win-rates/snapshots')
  const outputDirectory = resolve(cwd, values.get('--output-dir') ?? 'public/data/win-rates')
  const outputKey = process.platform === 'win32' ? outputDirectory.toLowerCase() : outputDirectory
  const hash = createHash('sha256').update(outputKey).digest('hex').slice(0, 24)
  return {
    help: false, months, currentMonth, cacheDirectory, outputDirectory,
    inputDirectory: values.has('--input-dir') ? resolve(cwd, values.get('--input-dir')!) : cacheDirectory,
    transactionDirectory: resolve(cwd, '.cache/win-rates/publication', hash),
  }
}

function hasCode(error: unknown, code: string): boolean {
  return error !== null && typeof error === 'object' && 'code' in error && error.code === code
}

function missingInput(path: string): Error {
  return new Error(`入力ファイルがありません: ${path}\n公式の対戦ダイアグラムをブラウザーで開き、対象月の16条件を書き出してから再実行してください。`)
}

async function selectedMonths(options: UpdateOptions): Promise<string[]> {
  if (options.months) return [...options.months]
  let entries
  try { entries = await readdir(options.inputDirectory, { withFileTypes: true }) } catch (error) {
    if (hasCode(error, 'ENOENT')) throw missingInput(options.inputDirectory)
    throw error
  }
  const months = entries.filter((entry) => entry.isFile() && /^\d{4}-\d{2}\.json$/.test(entry.name))
    .map((entry) => validateMonth(entry.name.slice(0, -5), options.currentMonth)).sort()
  if (months.length === 0) throw new Error(`入力先に月別JSONがありません: ${options.inputDirectory}\n公式表を書き出した YYYY-MM.json を配置してください。`)
  return months
}

function normalizeMonth(value: unknown, month: string, generatedAt: string): WinRateDataset[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${month}: 月別スナップショットの形式が正しくありません。`)
  const input = value as Record<string, unknown>
  if (input.snapshotVersion !== 1 || input.month !== month || !Array.isArray(input.snapshots) || input.snapshots.length !== 16) {
    throw new Error(`${month}: snapshotVersion、対象月、16条件の snapshots を確認してください。`)
  }
  const expected = new Set(LEAGUES.flatMap((league) => MODES.map((mode) => `${league}/${mode}`)))
  const datasets = input.snapshots.map((snapshot) => {
    const dataset = normalizeBucklerSnapshot(snapshot, month, generatedAt)
    if (dataset.month !== month || !expected.delete(`${dataset.league}/${dataset.operationMode}`)) {
      throw new Error(`${month}: スナップショットの月・リーグ・操作タイプに重複または不一致があります。`)
    }
    return dataset
  })
  if (expected.size > 0) throw new Error(`${month}: 16条件が揃っていません。`)
  const characterIds = datasets.find((dataset) => dataset.operationMode === 'combined')!.fighters.map((fighter) => fighter.characterId)
  for (const dataset of datasets) {
    const controls = dataset.operationMode === 'combined' ? [null] : ['classic', 'modern']
    const identities = new Set(characterIds.flatMap((characterId) => controls.map((controlType) => JSON.stringify([characterId, controlType]))))
    if (dataset.fighters.length !== identities.size
      || dataset.fighters.some(({ characterId, controlType }) => !identities.has(JSON.stringify([characterId, controlType])))) {
      throw new Error(`${month}: 月内のキャラクター構成が一致しません（${dataset.league}/${dataset.operationMode}）。全16条件で同じ月の表を取得したか確認してください。`)
    }
  }
  return datasets
}

export async function updateWinRates(options: UpdateOptions, now = new Date()): Promise<{
  months: string[]; updatedDatasets: number; datasets: number; cells: number; generatedAt: string
}> {
  if (!Number.isFinite(now.getTime())) throw new Error('生成日時が正しくありません。')
  const generatedAt = now.toISOString()
  const months = await selectedMonths(options)
  // 期間の一部が不足していても、公開先やキャッシュを変更しない。
  for (const month of months) {
    const path = resolve(options.inputDirectory, `${month}.json`)
    try {
      const stat = await lstat(path)
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`入力は通常のJSONファイルである必要があります: ${path}`)
    } catch (error) {
      if (hasCode(error, 'ENOENT')) throw missingInput(path)
      throw error
    }
  }
  const datasets: WinRateDataset[] = []
  for (const month of months) {
    const path = resolve(options.inputDirectory, `${month}.json`)
    let value: unknown
    try { value = JSON.parse(await readFile(path, 'utf8')) } catch (error) {
      if (hasCode(error, 'ENOENT')) throw missingInput(path)
      if (error instanceof SyntaxError) throw new Error(`JSONを読み込めません: ${path}`)
      throw error
    }
    datasets.push(...normalizeMonth(value, month, generatedAt))
  }
  const result = await publishWinRateBatch({
    directory: options.outputDirectory, transactionDirectory: options.transactionDirectory,
    datasets, months, generatedAt,
  })
  return { ...result, months, updatedDatasets: datasets.length, generatedAt }
}
