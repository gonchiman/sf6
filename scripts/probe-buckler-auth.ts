import { lstat, mkdir, writeFile } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createInterface } from 'node:readline/promises'
import { chromium } from 'playwright'
import { runBucklerAuthProbe } from './lib/buckler-auth-probe.ts'
import type { BucklerAuthProbeObservation, BucklerAuthProbeReport, BucklerAuthProbeStatus } from './lib/buckler-auth-probe.ts'
import { readBucklerAuthProbePage } from './lib/buckler-auth-probe-dom.ts'

const HELP = `Bucklerの認証・閲覧検証（ユーザーによる手動ログイン）

npm run data:probe-buckler-auth
npm run data:probe-buckler-auth -- --browser chrome
npm run data:probe-buckler-auth -- --browser chromium

--browser msedge|chrome|chromium   表示付きブラウザー（既定: msedge）
--help                           この説明を表示

使い捨てのブラウザーで手動ログイン後、総合・最大LPの先頭ページを
同じ実行内の新しいタブでも読めるか確認します。
結果は .local/buckler-auth-probe/ に保存します。
Cookie・パスワード・ユーザーコード・ブラウザー状態は書き出しません。
自動ログイン・別起動・GitHub Actions・認証の有効期間は未検証です。
Chromiumを使う場合は先に npx playwright install chromium を実行してください。`

const STATUS_LABELS: Record<BucklerAuthProbeStatus, string> = {
  'maintenance': 'メンテナンス中',
  'login-required': 'ログインが必要',
  'unsupported-dom': '表示形式を確認できません',
  'condition-mismatch': '表示条件が一致しません',
  'signed-in-readable': 'ログイン済みで先頭ページを確認',
  'anonymous-readable': '未ログインで先頭ページを閲覧可能（認証は未確認）',
  'auth-unconfirmed-readable': '先頭ページを閲覧可能（ログイン状態の証拠は未確認）',
  'timeout': '時間切れ',
  'read-failed': '読み取り失敗',
}

class ProbeCliError extends Error {}

function parseArguments(args: string[]): 'msedge' | 'chrome' | 'chromium' {
  if (args.length === 0) return 'msedge'
  if (args.length === 2 && args[0] === '--browser' && ['msedge', 'chrome', 'chromium'].includes(args[1])) {
    return args[1] as 'msedge' | 'chrome' | 'chromium'
  }
  throw new ProbeCliError('使用できる引数は --help または --browser msedge|chrome|chromium です。')
}

async function saveReport(report: BucklerAuthProbeReport): Promise<string> {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const local = resolve(root, '.local')
  const directory = resolve(local, 'buckler-auth-probe')
  for (const path of [local, directory]) {
    try {
      const stat = await lstat(path)
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new ProbeCliError('検証結果の保存先を確認してください。')
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error
      await mkdir(path)
    }
  }
  const name = `probe-${report.startedAt.replace(/[:.]/g, '-')}.json`
  await writeFile(resolve(directory, name), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' })
  return `.local/buckler-auth-probe/${name}`
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  if (args.length === 1 && args[0] === '--help') { console.log(HELP); return }
  const channel = parseArguments(args)
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new ProbeCliError('手動ログインのため、通常の対話ターミナルから実行してください。')
  }
  let browser
  try {
    browser = await chromium.launch({ headless: false, ...(channel === 'chromium' ? {} : { channel }) })
  } catch {
    throw new ProbeCliError('ブラウザーを起動できません。Edge/Chromeのインストール、または npx playwright install chromium を確認してください。')
  }
  let terminal: ReturnType<typeof createInterface> | undefined
  const interrupted = new AbortController()
  const interrupt = () => { interrupted.abort(); void browser.close().catch(() => {}) }
  process.on('SIGINT', interrupt)
  try {
    const context = await browser.newContext({ locale: 'ja-JP', acceptDownloads: false })
    const page = await context.newPage()
    let preflight: BucklerAuthProbeObservation | undefined
    let preflightError: unknown
    try { preflight = await readBucklerAuthProbePage(page) } catch (error) { preflightError = error }
    if (preflight && !preflight.maintenance) {
      console.log('公式ページでログインし、同じタブのランキング先頭ページに戻ってから、このターミナルに戻ってください。')
      console.log('ID・パスワードはブラウザーにだけ入力してください。中止する場合は Ctrl+C。')
      terminal = createInterface({ input: process.stdin, output: process.stdout })
      await terminal.question('ログイン完了後に Enter: ', {
        signal: AbortSignal.any([interrupted.signal, AbortSignal.timeout(15 * 60_000)]),
      })
      terminal.close()
      terminal = undefined
    }
    const report = await runBucklerAuthProbe({
      readPage: async phase => {
        if (preflightError) throw preflightError
        if (preflight?.maintenance) return preflight
        if (phase === 'initial') return readBucklerAuthProbePage(page, false)
        const reusedPage = await context.newPage()
        try { return await readBucklerAuthProbePage(reusedPage) } finally { await reusedPage.close().catch(() => {}) }
      },
    })
    const output = await saveReport(report)
    console.log(`初回: ${STATUS_LABELS[report.initial.status]}`)
    if (report.reuse) console.log(`同じ実行内の新タブ: ${STATUS_LABELS[report.reuse.status]}`)
    console.log(`認証の再利用: ${report.sameSessionReuse === 'confirmed' ? '確認できました' : '未確認'}`)
    console.log(`結果: ${output}`)
    if (report.sameSessionReuse !== 'confirmed') process.exitCode = 2
  } finally {
    process.removeListener('SIGINT', interrupt)
    terminal?.close()
    await browser.close().catch(() => {})
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    // Never print raw Playwright errors: they may include auth redirect URLs.
    console.error(error instanceof ProbeCliError ? error.message
      : '認証検証を終了しました。--help で起動方法を確認してください。ブラウザー状態や認証情報は書き出していません。')
    process.exitCode = 1
  })
}
