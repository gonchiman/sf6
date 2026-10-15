import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createInterface } from 'node:readline/promises'
import { chromium } from 'playwright'
import type { Browser, BrowserContext, Page } from 'playwright'
import { BUCKLER_AUTH_PROBE_URL, classifyBucklerAuthProbeObservation } from './lib/buckler-auth-probe.ts'
import type { BucklerAuthProbeObservation } from './lib/buckler-auth-probe.ts'
import { readBucklerAuthProbePage } from './lib/buckler-auth-probe-dom.ts'
import { BUCKLER_PRIVATE_SESSION_PATH, BUCKLER_SESSION_CAPTURE_PATH, BucklerSessionStoreError, createBucklerSessionStore } from './lib/buckler-session-store.ts'
import type { BucklerSessionStore } from './lib/buckler-session-store.ts'
import { BucklerManualBrowserError, closeManualBrowser, closeManualLoginBrowser, prepareManualBrowser,
  prepareManualLoginBrowser, readManualBrowserEndpoint, restartManualBrowserForCapture } from './lib/buckler-manual-browser.ts'

const DIRECTORY = dirname(BUCKLER_PRIVATE_SESSION_PATH)
const CAPTURE_PATH = BUCKLER_SESSION_CAPTURE_PATH
const LAUNCH_ID = randomUUID()
const HELP = `Bucklerの別起動による認証再利用検証（Windows・同じユーザー専用）

npm run data:probe-buckler-session -- --capture
npm run data:probe-buckler-session -- --reuse
npm run data:probe-buckler-session -- --open-manual-browser
npm run data:probe-buckler-session -- --capture --manual-browser
npm run data:probe-buckler-session -- --open-login-browser
npm run data:probe-buckler-session -- --capture --login-browser

--capture  新しいEdgeで手動ログイン後、認証状態をこのPC内に暗号化保存
--reuse    保存状態で新しいEdgeを起動し、手動ログインなしで先頭ページを検証
--open-manual-browser  接続用の専用Edgeを通常起動（OPENへの同意後）
--manual-browser  手動ログイン後の専用Edgeへ接続するcapture方式
--open-login-browser  接続設定なしの専用Edgeを通常起動（OPENへの同意後）
--login-browser  ログイン後、同じ専用プロファイルを接続用に再起動してcapture
--close-manual-browser  このツールが用意した専用Edgeを終了
--close-login-browser  接続設定なしで開いた専用Edgeを終了
--browser msedge|chrome|chromium  ブラウザー（既定: msedge）
--help     この説明を表示

保存先: .local/buckler-auth-probe/private-session.dpapi
認証Cookie等をWindows DPAPIで暗号化し、同じWindowsユーザーでのみ復号します。
Street Fighterサイトの状態だけを保存します。CAPCOM ID側の状態やパスワードは保存しません。
数値と状態だけの検証結果も .local/buckler-auth-probe/ に保存します。
GitHub・クラウドへの送信、全ランクの集計、週次実行は行いません。
初回ログイン後に SAVE と入力した場合だけ認証状態を保存します。
通常起動の専用プロファイルには、ブラウザー自身がCAPCOM IDを含むログイン状態を保持する場合があります。
専用プロファイル: .local/buckler-auth-probe/manual-browser-profile
接続はこのPC内だけで、手動ログイン中には取得ツールを接続しません。`

class SessionProbeCliError extends Error {}

interface SessionProbeOptions {
  mode: 'capture' | 'reuse' | 'open-manual-browser' | 'close-manual-browser' | 'open-login-browser' | 'close-login-browser'
  browser: 'msedge' | 'chrome' | 'chromium'
  manualBrowser: boolean
  loginBrowser: boolean
}

export function parseSessionProbeArguments(args: string[]): SessionProbeOptions {
  let mode: SessionProbeOptions['mode'] | undefined
  let browser: 'msedge' | 'chrome' | 'chromium' = 'msedge'
  let hasBrowser = false
  let manualBrowser = false
  let loginBrowser = false
  for (let index = 0; index < args.length; index++) {
    if (['--capture', '--reuse', '--open-manual-browser', '--close-manual-browser', '--open-login-browser', '--close-login-browser'].includes(args[index])) {
      if (mode) throw new SessionProbeCliError('実行方式は1つだけ指定してください。')
      mode = args[index].slice(2) as SessionProbeOptions['mode']
    } else if (args[index] === '--manual-browser' && !manualBrowser) {
      manualBrowser = true
    } else if (args[index] === '--login-browser' && !loginBrowser) {
      loginBrowser = true
    } else if (args[index] === '--browser' && !hasBrowser && ['msedge', 'chrome', 'chromium'].includes(args[index + 1])) {
      browser = args[++index] as typeof browser
      hasBrowser = true
    } else throw new SessionProbeCliError('引数を確認してください。--helpで使用方法を表示します。')
  }
  if (!mode) throw new SessionProbeCliError('実行方式を指定してください。--helpで使用方法を表示します。')
  if (((manualBrowser || loginBrowser) && mode !== 'capture') || (manualBrowser && loginBrowser)
    || ((manualBrowser || loginBrowser || mode.endsWith('manual-browser') || mode.endsWith('login-browser')) && hasBrowser)) {
    throw new SessionProbeCliError('手動ブラウザー方式は専用Edgeのcaptureで使用してください。')
  }
  return { mode, browser, manualBrowser, loginBrowser }
}

/** Excludes identity-provider state from the encrypted export, including for manual profiles. */
export async function bucklerOnlyStorageState(context: BrowserContext): Promise<string> {
  const state = await context.storageState()
  const allowed = (host: string) => host === 'streetfighter.com' || host.endsWith('.streetfighter.com')
  return JSON.stringify({
    cookies: state.cookies.filter(cookie => allowed(cookie.domain.replace(/^\./, '').toLowerCase())),
    origins: state.origins.filter(origin => { try { const url = new URL(origin.origin); return url.protocol === 'https:' && allowed(url.hostname) } catch { return false } }),
  })
}

/** Only a rendered Buckler league page in the owned dedicated context can be selected. */
export function selectManualBucklerPage(context: BrowserContext): Page {
  const pages = context.pages().filter(page => {
    try {
      const url = new URL(page.url())
      return !url.username && !url.password && url.origin === 'https://www.streetfighter.com'
        && url.pathname === '/6/buckler/ja-jp/ranking/league'
    } catch { return false }
  })
  if (pages.length !== 1) throw new SessionProbeCliError('専用Edgeでログイン後、Bucklerの総合ランキングを1つだけ開いてください。')
  return pages[0]
}

export interface BucklerCaptureRecord {
  schemaVersion: 1
  capturedAt: string
  processId: number
  launchId: string
  stateIdentity: string
}

export function parseCaptureRecord(input: unknown): BucklerCaptureRecord {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new SessionProbeCliError('captureの記録を確認できません。')
  const value = input as Record<string, unknown>
  if (Object.keys(value).some(key => !['schemaVersion', 'capturedAt', 'processId', 'launchId', 'stateIdentity'].includes(key))
    || value.schemaVersion !== 1 || !Number.isSafeInteger(value.processId) || (value.processId as number) < 1
    || typeof value.launchId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value.launchId)
    || typeof value.stateIdentity !== 'string' || !/^[0-9a-f]{64}$/.test(value.stateIdentity)
    || typeof value.capturedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.capturedAt)
    || !Number.isFinite(Date.parse(value.capturedAt)) || new Date(value.capturedAt).toISOString() !== value.capturedAt) {
    throw new SessionProbeCliError('captureの記録を確認できません。')
  }
  return { schemaVersion: 1, capturedAt: new Date(value.capturedAt).toISOString(), processId: value.processId as number,
    launchId: value.launchId, stateIdentity: value.stateIdentity }
}

export function isSeparateLaunch(capture: BucklerCaptureRecord, launchId: string): boolean {
  // A PID can be reused after a process exits. The UUID is generated once per module/process launch.
  return capture.launchId !== launchId
}

async function safeCaptureMetadata(store: BucklerSessionStore): Promise<BucklerCaptureRecord> {
  try {
    await store.checkCapturePath(CAPTURE_PATH)
    const stat = await lstat(CAPTURE_PATH)
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 1024) throw new Error()
    return parseCaptureRecord(JSON.parse(await readFile(CAPTURE_PATH, 'utf8')))
  } catch { throw new SessionProbeCliError('captureの検証記録を確認できません。手動ログインによるcaptureを実行してください。') }
}

async function saveCaptureMetadata(store: BucklerSessionStore, value: BucklerCaptureRecord): Promise<void> {
  const record = parseCaptureRecord(value)
  const temporary = `${CAPTURE_PATH}.tmp-${randomUUID()}`
  let created = false
  try {
    await store.checkCapturePath(CAPTURE_PATH)
    await store.checkCapturePath(temporary)
    await writeFile(temporary, JSON.stringify(record, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    created = true
    await store.checkCapturePath(temporary)
    await store.checkCapturePath(CAPTURE_PATH)
    if (await store.identity() !== record.stateIdentity) throw new SessionProbeCliError('保存中に認証状態が変わりました。captureをやり直してください。')
    await rename(temporary, CAPTURE_PATH)
    created = false
  } finally {
    if (created) await unlink(temporary).catch(() => {})
  }
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  if (args.length === 1 && args[0] === '--help') { console.log(HELP); return }
  const options = parseSessionProbeArguments(args)
  if (['capture', 'open-manual-browser', 'open-login-browser'].includes(options.mode) && (!process.stdin.isTTY || !process.stdout.isTTY)) {
    throw new SessionProbeCliError('手動ログインの準備・captureは対話ターミナルから実行してください。')
  }
  if (options.mode === 'close-manual-browser') {
    await closeManualBrowser()
    console.log('専用Edgeを終了しました。専用プロファイルの保存状態は残っています。')
    return
  }
  if (options.mode === 'close-login-browser') {
    await closeManualLoginBrowser()
    console.log('接続設定なしの専用Edgeを終了しました。専用プロファイルは保持しています。')
    return
  }
  if (options.mode === 'open-manual-browser' || options.mode === 'open-login-browser') {
    const loginOnly = options.mode === 'open-login-browser'
    console.log(loginOnly ? '接続用の設定を付けずに専用Edgeを通常起動します。ログイン後に同じプロファイルを接続用へ再起動します。'
      : '専用Edgeを通常起動します。ログイン中に取得ツールは接続しません。')
    console.log('専用プロファイル .local/buckler-auth-probe/manual-browser-profile には、ブラウザー自身がCAPCOM IDを含むログイン状態を保持する場合があります。')
    console.log('暗号化ファイルだけに保存される方式ではありません。普段のプロファイルは使用せず、GitHubやクラウドへ送りません。')
    const terminal = createInterface({ input: process.stdin, output: process.stdout })
    try {
      const answer = await terminal.question('この専用プロファイルで手動ログインを試す場合は OPEN: ', { signal: AbortSignal.timeout(15 * 60_000) })
      if (answer.trim() !== 'OPEN') throw new SessionProbeCliError('専用Edgeを起動せず終了しました。')
      const launch = await (loginOnly ? prepareManualLoginBrowser() : prepareManualBrowser())
      console.log(JSON.stringify({ mode: options.mode, launch }))
      console.log('開いた専用Edgeで手動ログインし、Bucklerの総合ランキングに戻ってください。')
      console.log(`ログイン後: npm run data:probe-buckler-session -- --capture --${loginOnly ? 'login-browser' : 'manual-browser'}`)
    } finally { terminal.close() }
    return
  }
  const store = createBucklerSessionStore()
  const capture = options.mode === 'reuse' ? await safeCaptureMetadata(store) : null
  let state
  if (capture) {
    if (await store.identity() !== capture.stateIdentity) throw new SessionProbeCliError('認証ファイルとcaptureの記録が一致しません。captureをやり直してください。')
    state = JSON.parse(await store.load())
    if (await store.identity() !== capture.stateIdentity) throw new SessionProbeCliError('読み込み中に認証状態が変わりました。captureをやり直してください。')
  }
  const startedAt = new Date().toISOString()
  let browser: Browser | undefined
  let manualConnectionStarted = false
  let loginRestartStarted = false
  const interrupted = new AbortController()
  const interrupt = () => { interrupted.abort(); void browser?.close().catch(() => {}) }
  process.on('SIGINT', interrupt)
  let terminal: ReturnType<typeof createInterface> | undefined
  try {
    let context: BrowserContext
    let page: Page
    let observation: BucklerAuthProbeObservation
    if (options.manualBrowser || options.loginBrowser) {
      console.log('通常起動した専用Edgeで手動ログインし、Bucklerの総合ランキングに戻ってください。ログイン中は接続しません。')
      console.log('接続後、Street Fighterサイトの認証Cookie等をこのPCの .local/buckler-auth-probe/private-session.dpapi に暗号化保存します。GitHubやクラウドへ送りません。')
      if (options.loginBrowser) console.log('SAVE後に専用Edgeを終了し、同じプロファイルを接続用に再起動します。再起動後のログイン状態を確認できた場合だけ暗号化保存します。')
      terminal = createInterface({ input: process.stdin, output: process.stdout })
      const answer = await terminal.question('ログイン完了・暗号化保存に同意する場合は SAVE: ', { signal: AbortSignal.any([interrupted.signal, AbortSignal.timeout(15 * 60_000)]) })
      terminal.close(); terminal = undefined
      if (answer.trim() !== 'SAVE') throw new SessionProbeCliError('接続・暗号化保存をせず終了しました。専用Edgeは開いたままです。')
      if (options.loginBrowser) {
        interrupted.signal.throwIfAborted()
        loginRestartStarted = true
        await restartManualBrowserForCapture(interrupted.signal)
      }
      const connection = await readManualBrowserEndpoint()
      interrupted.signal.throwIfAborted()
      manualConnectionStarted = true
      browser = await chromium.connectOverCDP(connection.endpointURL, { noDefaults: true, isLocal: true, timeout: 15_000 })
      interrupted.signal.throwIfAborted()
      const contexts = browser.contexts()
      if (contexts.length !== 1) throw new SessionProbeCliError('専用Edgeの検証用コンテキストを確認できません。')
      context = contexts[0]
      page = selectManualBucklerPage(context)
      observation = await readBucklerAuthProbePage(page, true, true)
    } else {
      browser = await chromium.launch({ headless: false, ...(options.browser === 'chromium' ? {} : { channel: options.browser }) })
      context = await browser.newContext({ locale: 'ja-JP', acceptDownloads: false, ...(state ? { storageState: state } : {}) })
      page = await context.newPage()
      observation = await readBucklerAuthProbePage(page, true, options.mode === 'reuse')
    }
    interrupted.signal.throwIfAborted()
    if (options.mode === 'capture' && !options.manualBrowser && !options.loginBrowser && !observation.maintenance) {
      console.log('新しいEdgeウィンドウの公式ページでログインしてください。ID・パスワードはブラウザーにだけ入力してください。')
      console.log('ログイン後、認証Cookie等をこのPCの .local/buckler-auth-probe/private-session.dpapi に暗号化保存する場合は SAVE と入力してください。')
      console.log('保存すると次の起動があなたのログイン状態を使えます。GitHubやクラウドには送りません。中止はCtrl+C。')
      terminal = createInterface({ input: process.stdin, output: process.stdout })
      const answer = await terminal.question('ログイン完了・保存に同意: ', { signal: AbortSignal.any([interrupted.signal, AbortSignal.timeout(15 * 60_000)]) })
      terminal.close(); terminal = undefined
      if (answer.trim() !== 'SAVE') throw new SessionProbeCliError('認証状態を保存せず検証を終了しました。')
      observation = await readBucklerAuthProbePage(page, true, true)
    }
    interrupted.signal.throwIfAborted()
    const result = classifyBucklerAuthProbeObservation(observation)
    let authenticationStateSaved = false
    if (options.mode === 'capture' && result.status === 'signed-in-readable') {
      const exportedState = await bucklerOnlyStorageState(context)
      interrupted.signal.throwIfAborted()
      await store.save(exportedState, 'capture', interrupted.signal)
      await saveCaptureMetadata(store, { schemaVersion: 1, capturedAt: new Date().toISOString(), processId: process.pid,
        launchId: LAUNCH_ID, stateIdentity: await store.identity() })
      authenticationStateSaved = true
    }
    const differentProcess = capture ? isSeparateLaunch(capture, LAUNCH_ID) : null
    const report = {
      schemaVersion: 1, startedAt, endedAt: new Date().toISOString(), sourceUrl: BUCKLER_AUTH_PROBE_URL,
      mode: options.mode, processId: process.pid, browserMode: 'headed', cliProcessExecuted: true,
      captureMethod: options.loginBrowser ? 'manual-login-then-restart' : options.manualBrowser ? 'manual-browser-attachment' : 'playwright-launch',
      storageStateLoaded: options.mode === 'reuse', manualLoginPerformed: options.mode === 'capture' && result.status === 'signed-in-readable',
      authenticationStateSaved, capturedAt: capture?.capturedAt ?? null, differentProcess,
      observation: result,
      separateLaunchReuse: options.mode === 'capture' ? 'not-tested'
        : differentProcess && result.status === 'signed-in-readable' ? 'confirmed' : 'not-confirmed',
      automaticLogin: 'not-tested', cloudAuthentication: 'not-tested', sessionLifetime: 'not-tested', wholeDistribution: 'not-tested',
    }
    for (const directory of [dirname(DIRECTORY), DIRECTORY]) {
      try {
        const info = await lstat(directory)
        if (!info.isDirectory() || info.isSymbolicLink()) throw new SessionProbeCliError('検証結果の保存先を確認してください。')
      } catch (error) {
        if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error
        await mkdir(directory, { mode: 0o700 })
      }
    }
    const name = `session-${options.mode}-${startedAt.replace(/[:.]/g, '-')}.json`
    await writeFile(resolve(DIRECTORY, name), JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    console.log(JSON.stringify({ status: result.status, separateLaunchReuse: report.separateLaunchReuse, authenticationStateSaved, totalCount: result.totalCount, report: `.local/buckler-auth-probe/${name}` }))
    if (result.status !== 'signed-in-readable' || options.mode === 'reuse' && !differentProcess) process.exitCode = 2
  } finally {
    process.removeListener('SIGINT', interrupt)
    terminal?.close()
    await browser?.close().catch(() => {})
    if (manualConnectionStarted) await closeManualBrowser()
    else if (loginRestartStarted) {
      await closeManualBrowser().catch(() => closeManualLoginBrowser()).catch(() => {})
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(error instanceof SessionProbeCliError || error instanceof BucklerSessionStoreError || error instanceof BucklerManualBrowserError
      ? error.message : '別起動の検証を完了できませんでした。認証状態や生のエラーは表示しません。')
    process.exitCode = 1
  })
}
