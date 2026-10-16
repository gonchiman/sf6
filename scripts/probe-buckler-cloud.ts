import { randomUUID } from 'node:crypto'
import { lstat, mkdir, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { BrowserContextOptions } from 'playwright'
import { BucklerAuthProbeReadError, classifyBucklerAuthProbeObservation } from './lib/buckler-auth-probe.ts'
import type { BucklerAuthProbePhaseResult } from './lib/buckler-auth-probe.ts'
import { readBucklerAuthProbePage } from './lib/buckler-auth-probe-dom.ts'
import { validateBucklerSessionState } from './lib/buckler-session-store.ts'

export const BUCKLER_CLOUD_SESSION_ENV = 'BUCKLER_CLOUD_PROBE_SESSION'
export const BUCKLER_CLOUD_SESSION_SIZE_LIMIT = 48 * 1024
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const LOCAL = resolve(ROOT, '.local')
const DIRECTORY = resolve(LOCAL, 'buckler-cloud-probe')
export const BUCKLER_CLOUD_REPORT_PATH = resolve(DIRECTORY, 'result.json')

const HELP = `Bucklerのクラウド閲覧・認証再利用の単発検証

node scripts/probe-buckler-cloud.ts --anonymous
node scripts/probe-buckler-cloud.ts --saved-session

--anonymous      認証状態を使わず、固定ランキング先頭ページの表示を確認
--saved-session  BUCKLER_CLOUD_PROBE_SESSION の保存状態をメモリ内で再利用
--headless       比較用に画面なしで起動（既定: Windows Edge・画面あり）
--help           この説明を表示

認証状態は48KiB未満のStreet Fighterサイト用JSONだけを受け付けます。
読み取った環境変数はブラウザー起動前に削除します。認証状態をファイルに保存しません。
自動ログイン、再試行、認証チャレンジの操作、全分布集計、週次実行は行いません。
数値と判定だけを .local/buckler-cloud-probe/result.json に保存します。`

type CloudProbeErrorCode = 'arguments' | 'session-missing' | 'session-invalid' | 'session-too-large' | 'time' | 'report'
const MESSAGES: Record<CloudProbeErrorCode, string> = {
  arguments: '--anonymous または --saved-session を1つ指定してください。使用できる追加引数は --headless だけです。',
  'session-missing': 'クラウド検証用の保存状態が設定されていません。',
  'session-invalid': 'クラウド検証用の保存状態の形式・対象サイトを確認できません。',
  'session-too-large': 'クラウド検証用の保存状態は48KiB未満にしてください。',
  time: 'クラウド検証の日時を確認できません。',
  report: 'クラウド検証結果を保存できませんでした。',
}

export class BucklerCloudProbeError extends Error {
  readonly code: CloudProbeErrorCode
  constructor(code: CloudProbeErrorCode) {
    super(MESSAGES[code])
    this.name = 'BucklerCloudProbeError'
    this.code = code
  }
}

export interface BucklerCloudProbeOptions {
  mode: 'anonymous' | 'saved-session'
  headless: boolean
}

export function parseCloudProbeArguments(args: string[]): BucklerCloudProbeOptions {
  let mode: BucklerCloudProbeOptions['mode'] | undefined
  let headless = false
  for (const argument of args) {
    if (argument === '--anonymous' || argument === '--saved-session') {
      if (mode) throw new BucklerCloudProbeError('arguments')
      mode = argument === '--anonymous' ? 'anonymous' : 'saved-session'
    } else if (argument === '--headless' && !headless) headless = true
    else throw new BucklerCloudProbeError('arguments')
  }
  if (!mode) throw new BucklerCloudProbeError('arguments')
  return { mode, headless }
}

type Environment = Record<string, string | undefined>
type StorageState = Exclude<NonNullable<BrowserContextOptions['storageState']>, string>

export interface BucklerCloudProbeLaunchOptions {
  headless: boolean
  expectSignedIn: boolean
  storageState?: StorageState
  env: Record<string, string>
}

export interface BucklerCloudProbeTransport {
  read(): Promise<unknown>
  diagnostics?(): Promise<unknown>
  close(): Promise<void>
}

export interface BucklerCloudProbeDependencies {
  env?: Environment
  launch?: (options: BucklerCloudProbeLaunchOptions) => Promise<BucklerCloudProbeTransport>
  now?: () => Date
}

export interface BucklerCloudProbeReport {
  schemaVersion: 1
  startedAt: string
  endedAt: string
  browserMode: 'headed' | 'headless'
  mode: BucklerCloudProbeOptions['mode']
  observation: BucklerAuthProbePhaseResult
  documentHttpStatus: number | null
  accessBlocker: 'cloudfront-blocked' | 'cloudflare-challenge' | 'none' | 'unknown'
  failureStage: 'browser-launch' | 'page-read' | null
  cloudExecution: boolean
  cloudAuthentication: 'confirmed' | 'not-confirmed' | 'not-tested'
  manualLoginPerformed: false
  wholeDistribution: 'not-tested'
  sessionLifetime: 'not-tested'
  weeklyExecution: 'not-tested'
}

/** Consume the only credential input before parsing arguments or starting any child. */
function consumeSessionAndDisableDiagnostics(env: Environment): string | undefined {
  const session = env[BUCKLER_CLOUD_SESSION_ENV]
  delete env[BUCKLER_CLOUD_SESSION_ENV]
  for (const key of Object.keys(env)) {
    if (/^(?:DEBUG(?:_|$)|PWDEBUG$|NODE_DEBUG(?:_|$)|NODE_OPTIONS$|PW_(?:LOG|TRACE|VIDEO|SCREENSHOT)|PLAYWRIGHT_(?:DEBUG|TRACE|LOG))/i.test(key)) {
      delete env[key]
    }
  }
  return session
}

/** Both exact runner markers are required; the actual Actions run remains the external evidence. */
export function isHostedGitHubExecution(env: Environment): boolean {
  return env.GITHUB_ACTIONS === 'true' && env.RUNNER_ENVIRONMENT === 'github-hosted'
}

function safeDate(now: () => Date): string {
  const date = now()
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) throw new BucklerCloudProbeError('time')
  return new Date(date.getTime()).toISOString()
}

function readFailure(error: unknown): BucklerAuthProbePhaseResult {
  return {
    status: error instanceof BucklerAuthProbeReadError && error.status === 'timeout' ? 'timeout' : 'read-failed',
    signedIn: null, rankingRows: null, totalCount: null, controlMatches: null, pageConfirmed: null,
  }
}

/** Visible headings are classified in the browser; their text is never returned. */
export function observeCloudProbeBlocker(): BucklerCloudProbeReport['accessBlocker'] {
  const headings = [...document.querySelectorAll('h1,h2,h3')].filter(element => {
    const rectangle = element.getBoundingClientRect()
    if (rectangle.width <= 0 || rectangle.height <= 0) return false
    for (let parent: Element | null = element; parent; parent = parent.parentElement) {
      const style = window.getComputedStyle(parent)
      if (parent.hasAttribute('hidden') || style.display === 'none' || style.visibility === 'hidden'
        || style.visibility === 'collapse' || Number(style.opacity) === 0) return false
    }
    return true
  }).slice(0, 40).map(element => (element as HTMLElement).innerText?.trim() ?? '')
  if (headings.some(value => /the request could not be satisfied|cloudfront.*(?:error|block)/i.test(value))) return 'cloudfront-blocked'
  if (headings.some(value => /cloudflare|セキュリティ検証|security verification|verify (?:that )?you are human|just a moment/i.test(value))) return 'cloudflare-challenge'
  return headings.some(Boolean) ? 'none' : 'unknown'
}

/** No text, URLs, response headers or unrecognized transport fields enter the report. */
export function sanitizeCloudProbeDiagnostics(input: unknown): Pick<BucklerCloudProbeReport, 'documentHttpStatus' | 'accessBlocker'> {
  const value = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {}
  const status = value.documentHttpStatus
  return {
    documentHttpStatus: Number.isSafeInteger(status) && (status as number) >= 100 && (status as number) <= 599 ? status as number : null,
    accessBlocker: ['cloudfront-blocked', 'cloudflare-challenge', 'none', 'unknown'].includes(value.accessBlocker as string)
      ? value.accessBlocker as BucklerCloudProbeReport['accessBlocker'] : 'unknown',
  }
}

async function launchEdge(options: BucklerCloudProbeLaunchOptions): Promise<BucklerCloudProbeTransport> {
  // Load Playwright only after DEBUG/PWDEBUG were removed, before its loggers initialize.
  const { chromium } = await import('playwright')
  const browser = await chromium.launch({ channel: 'msedge', headless: options.headless, env: options.env, timeout: 30_000 })
  try {
    const context = await browser.newContext({ locale: 'ja-JP', acceptDownloads: false,
      ...(options.storageState ? { storageState: options.storageState } : {}) })
    const page = await context.newPage()
    let documentHttpStatus: number | null = null
    page.on('response', response => {
      try {
        if (response.request().isNavigationRequest() && response.request().resourceType() === 'document'
          && response.frame() === page.mainFrame()) documentHttpStatus = response.status()
      } catch { /* Missing frames provide no additional diagnostic evidence. */ }
    })
    return {
      read: () => readBucklerAuthProbePage(page, true, options.expectSignedIn),
      diagnostics: async () => {
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          const accessBlocker = await Promise.race([
            page.evaluate(observeCloudProbeBlocker),
            new Promise<'unknown'>(resolveTimeout => { timer = setTimeout(() => resolveTimeout('unknown'), 1_500) }),
          ])
          return { documentHttpStatus, accessBlocker }
        } catch { return { documentHttpStatus, accessBlocker: 'unknown' } }
        finally { if (timer) clearTimeout(timer) }
      },
      close: () => browser.close(),
    }
  } catch (error) {
    await browser.close().catch(() => {})
    throw error
  }
}

/** One launch and one page read. Browser errors and extra DOM fields never reach the report. */
export async function runBucklerCloudProbe(args: string[], dependencies: BucklerCloudProbeDependencies = {}): Promise<{
  report: BucklerCloudProbeReport; succeeded: boolean
}> {
  const env = dependencies.env ?? process.env
  const sessionJson = consumeSessionAndDisableDiagnostics(env)
  const options = parseCloudProbeArguments(args)
  let storageState: StorageState | undefined
  if (options.mode === 'saved-session') {
    if (!sessionJson) throw new BucklerCloudProbeError('session-missing')
    if (Buffer.byteLength(sessionJson, 'utf8') >= BUCKLER_CLOUD_SESSION_SIZE_LIMIT) throw new BucklerCloudProbeError('session-too-large')
    try { storageState = JSON.parse(validateBucklerSessionState(sessionJson)) as StorageState }
    catch { throw new BucklerCloudProbeError('session-invalid') }
  }
  const clock = dependencies.now ?? (() => new Date())
  const startedAt = safeDate(clock)
  const cloudExecution = isHostedGitHubExecution(env)
  const browserEnv = Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
  let transport: BucklerCloudProbeTransport | undefined
  let observation: BucklerAuthProbePhaseResult
  let failureStage: BucklerCloudProbeReport['failureStage'] = null
  let diagnostics = sanitizeCloudProbeDiagnostics(undefined)
  try {
    transport = await (dependencies.launch ?? launchEdge)({ headless: options.headless,
      expectSignedIn: options.mode === 'saved-session', ...(storageState ? { storageState } : {}), env: browserEnv })
    observation = classifyBucklerAuthProbeObservation(await transport.read())
  } catch (error) {
    failureStage = transport ? 'page-read' : 'browser-launch'
    observation = readFailure(error)
  }
  finally {
    try { diagnostics = sanitizeCloudProbeDiagnostics(await transport?.diagnostics?.()) } catch { /* Fixed unknown diagnostics remain. */ }
    await transport?.close().catch(() => {})
  }
  const endedAt = safeDate(clock)
  if (endedAt < startedAt) throw new BucklerCloudProbeError('time')
  const authenticated = options.mode === 'saved-session' && cloudExecution && observation.status === 'signed-in-readable'
  const report: BucklerCloudProbeReport = {
    schemaVersion: 1, startedAt, endedAt, browserMode: options.headless ? 'headless' : 'headed', mode: options.mode,
    observation, ...diagnostics, failureStage, cloudExecution,
    cloudAuthentication: options.mode === 'anonymous' ? 'not-tested' : authenticated ? 'confirmed' : 'not-confirmed',
    manualLoginPerformed: false, wholeDistribution: 'not-tested', sessionLifetime: 'not-tested', weeklyExecution: 'not-tested',
  }
  return { report, succeeded: options.mode === 'saved-session' ? authenticated
    : ['anonymous-readable', 'auth-unconfirmed-readable', 'signed-in-readable'].includes(observation.status) }
}

async function checkDirectory(path: string): Promise<void> {
  try {
    const info = await lstat(path)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new BucklerCloudProbeError('report')
  } catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error
    await mkdir(path)
    const info = await lstat(path)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new BucklerCloudProbeError('report')
  }
}

async function checkDestination(): Promise<void> {
  try {
    const info = await lstat(BUCKLER_CLOUD_REPORT_PATH)
    if (!info.isFile() || info.isSymbolicLink() || info.size > 16_384) throw new BucklerCloudProbeError('report')
  } catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error
  }
}

/** Only the fixed safe report is written, never browser state or browser diagnostics. */
async function writeReport(report: BucklerCloudProbeReport): Promise<void> {
  const temporary = `${BUCKLER_CLOUD_REPORT_PATH}.tmp-${randomUUID()}`
  let staged = false
  try {
    await checkDirectory(LOCAL)
    await checkDirectory(DIRECTORY)
    await checkDestination()
    const output = JSON.stringify(report, null, 2) + '\n'
    if (Buffer.byteLength(output, 'utf8') > 16_384) throw new BucklerCloudProbeError('report')
    await writeFile(temporary, output, { flag: 'wx', mode: 0o600 })
    staged = true
    await checkDirectory(LOCAL)
    await checkDirectory(DIRECTORY)
    await checkDestination()
    await rename(temporary, BUCKLER_CLOUD_REPORT_PATH)
    staged = false
  } catch { throw new BucklerCloudProbeError('report') }
  finally { if (staged) await unlink(temporary).catch(() => {}) }
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  if (args.length === 1 && args[0] === '--help') {
    consumeSessionAndDisableDiagnostics(process.env)
    console.log(HELP)
    return
  }
  const result = await runBucklerCloudProbe(args)
  await writeReport(result.report)
  console.log(JSON.stringify(result.report))
  if (!result.succeeded) process.exitCode = 2
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(error instanceof BucklerCloudProbeError ? error.message : 'クラウド検証を完了できませんでした。')
    process.exitCode = 1
  })
}
