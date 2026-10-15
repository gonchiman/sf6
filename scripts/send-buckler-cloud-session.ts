import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { link, lstat, mkdir, open, unlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseCaptureRecord } from './probe-buckler-session.ts'
import { BUCKLER_SESSION_CAPTURE_PATH, createBucklerSessionStore, validateBucklerSessionState } from './lib/buckler-session-store.ts'
import type { BucklerSessionStore } from './lib/buckler-session-store.ts'

export const BUCKLER_CLOUD_REPOSITORY = 'gonchiman/sf6'
export const BUCKLER_CLOUD_SECRET = 'BUCKLER_CLOUD_PROBE_SESSION'
export const BUCKLER_CLOUD_SECRET_LIMIT = 48 * 1024
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const LOCAL = resolve(ROOT, '.local')
const DIRECTORY = resolve(LOCAL, 'buckler-cloud-probe')
export const BUCKLER_CLOUD_RECEIPT_PATH = resolve(DIRECTORY, 'upload.json')
const SMALL_FILE_LIMIT = 1024
const LIST_LIMIT = 128 * 1024
const HELP = `Buckler認証状態の単発クラウド検証用送信（Windows・保存した本人専用）

--upload   UPLOADへの明示同意後、固定DPAPI保存を復号して固定Actions Secretへ送信
--cleanup  このツールの送信記録がある固定Actions Secretを削除
--help     この説明を表示

送信先: GitHub.com の公開リポジトリ gonchiman/sf6 のActions用Secret BUCKLER_CLOUD_PROBE_SESSION
認証状態は公開Git・ログ・artifactには保存せず、ghの公開鍵暗号化で送信します。
ローカル保存時の同意とは別に、クラウドへの送信への同意が必要です。
既存の同名Secretは上書きしません。単発検証後は --cleanup で削除します。
このコマンドはワークフローを実行せず、週次実行も設定しません。`

type ErrorCode = 'arguments' | 'interactive' | 'cancelled' | 'capture' | 'identity' | 'state' | 'size'
  | 'path' | 'receipt-exists' | 'receipt-missing' | 'receipt-invalid' | 'existing-secret' | 'github'
  | 'upload' | 'cleanup-needed'
const MESSAGES: Record<ErrorCode, string> = {
  arguments: '引数を確認してください。--upload、--cleanup、--helpのいずれか1つだけを指定します。',
  interactive: 'クラウドへの送信は対話ターミナルから明示同意して実行してください。',
  cancelled: 'クラウドへの送信を中止しました。',
  capture: '固定のcapture記録を確認できません。手動ログインによるcaptureを確認してください。',
  identity: '認証ファイルとcapture記録が一致しません。送信せず終了しました。',
  state: '認証状態の形式・対象サイトを確認できません。送信せず終了しました。',
  size: '認証状態が48KiB未満という送信上限を満たしません。送信せず終了しました。',
  path: '固定のローカル送信記録の保存先を安全に確認できません。',
  'receipt-exists': '前回の送信記録があります。先に --cleanup で後処理してください。',
  'receipt-missing': 'このツールの送信記録がありません。Secretは削除しません。',
  'receipt-invalid': '送信記録の対象・形式を確認できません。Secretは削除しません。',
  'existing-secret': '同名のActions Secretが既に存在します。上書きせず終了しました。',
  github: 'GitHub CLIによる固定Secretの操作・確認を完了できませんでした。生の出力は表示しません。',
  upload: 'Secretの送信を完了できませんでした。固定対象の後処理は完了しました。',
  'cleanup-needed': 'Secretの送信結果または削除を確認できません。送信記録を保持したので --cleanup を実行してください。',
}

export class BucklerCloudSendError extends Error {
  readonly code: ErrorCode
  constructor(code: ErrorCode) { super(MESSAGES[code]); this.name = 'BucklerCloudSendError'; this.code = code }
}
function fail(code: ErrorCode): never { throw new BucklerCloudSendError(code) }
function safeError(error: unknown): BucklerCloudSendError {
  return error instanceof BucklerCloudSendError ? error : new BucklerCloudSendError('path')
}

export function parseCloudSendArguments(args: string[]): 'upload' | 'cleanup' | 'help' {
  if (args.length !== 1 || !['--upload', '--cleanup', '--help'].includes(args[0])) fail('arguments')
  return args[0].slice(2) as 'upload' | 'cleanup' | 'help'
}

type GhOperation = 'list' | 'set' | 'delete'
/** All commands are fixed; authentication content is never an argument. */
export function cloudSecretArguments(operation: GhOperation): string[] {
  if (operation === 'list') return ['secret', 'list', '--repo', BUCKLER_CLOUD_REPOSITORY, '--json', 'name']
  if (operation === 'set') return ['secret', 'set', BUCKLER_CLOUD_SECRET, '--repo', BUCKLER_CLOUD_REPOSITORY]
  if (operation === 'delete') return ['secret', 'delete', BUCKLER_CLOUD_SECRET, '--repo', BUCKLER_CLOUD_REPOSITORY]
  return fail('arguments')
}

/** Avoid inherited debug/tracing hooks and host overrides while retaining gh's own authentication. */
export function cloudSecretEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {}
  const allowed = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP',
    'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'HOME', 'XDG_CONFIG_HOME', 'GH_CONFIG_DIR', 'GH_TOKEN', 'GITHUB_TOKEN',
    'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'ALL_PROXY', 'SSL_CERT_FILE', 'SSL_CERT_DIR'])
  for (const [key, value] of Object.entries(source)) if (allowed.has(key.toUpperCase()) && value !== undefined) result[key] = value
  return { ...result, GH_HOST: 'github.com', GH_PROMPT_DISABLED: '1', GH_PAGER: 'cat', NO_COLOR: '1' }
}

function silentProcess(command: string, args: string[], input: string, captureLimit: number, env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolveOutput, reject) => {
    let settled = false
    let total = 0
    const chunks: Buffer[] = []
    const child = spawn(command, args, { shell: false, windowsHide: true, env,
      stdio: ['pipe', captureLimit > 0 ? 'pipe' : 'ignore', 'ignore'] })
    const finish = (success: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (success) resolveOutput(Buffer.concat(chunks).toString('utf8'))
      else { child.kill(); reject(new BucklerCloudSendError('github')) }
    }
    const timer = setTimeout(() => finish(false), 30_000)
    timer.unref()
    child.on('error', () => finish(false))
    child.on('close', code => finish(code === 0))
    child.stdin!.on('error', () => finish(false))
    child.stdout?.on('data', (chunk: Buffer) => {
      total += chunk.length
      if (total > captureLimit) finish(false)
      else chunks.push(Buffer.from(chunk))
    })
    child.stdin!.end(input)
  })
}

async function defaultGh(operation: GhOperation, input = ''): Promise<string> {
  return silentProcess('gh', cloudSecretArguments(operation), input, operation === 'list' ? LIST_LIMIT : 0, cloudSecretEnvironment(process.env))
}

export interface CloudSessionFileInfo { kind: 'file' | 'directory' | 'other'; symbolicLink: boolean; reparsePoint: boolean; size: number }
export interface CloudSessionIo {
  inspect(path: string): Promise<CloudSessionFileInfo | null>
  mkdir(path: string): Promise<void>
  readBounded(path: string, limit: number): Promise<Uint8Array>
  writeExclusive(path: string, bytes: Uint8Array): Promise<void>
  linkExclusive(from: string, to: string): Promise<void>
  unlink(path: string): Promise<void>
}
const REPARSE_SCRIPT = "$ErrorActionPreference='Stop'; [Console]::InputEncoding=[Text.UTF8Encoding]::new($false); try { $p=[Console]::In.ReadToEnd(); $i=Get-Item -LiteralPath $p -Force; [Console]::Out.Write([int][bool]($i.Attributes -band [IO.FileAttributes]::ReparsePoint)); } catch { exit 1 }"
const defaultIo: CloudSessionIo = {
  async inspect(path) {
    let info
    try { info = await lstat(path) } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null
      throw error
    }
    let reparsePoint = info.isSymbolicLink()
    if (!reparsePoint && process.platform === 'win32') {
      const env = cloudSecretEnvironment(process.env)
      delete env.GH_TOKEN; delete env.GITHUB_TOKEN
      const result = await silentProcess('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', REPARSE_SCRIPT], path, 8, env)
      if (result !== '0' && result !== '1') fail('path')
      reparsePoint = result === '1'
    }
    return { kind: info.isFile() ? 'file' : info.isDirectory() ? 'directory' : 'other',
      symbolicLink: info.isSymbolicLink(), reparsePoint, size: info.size }
  },
  mkdir: path => mkdir(path, { mode: 0o700 }).then(() => {}),
  async readBounded(path, limit) {
    const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      const info = await file.stat()
      if (!info.isFile() || !Number.isSafeInteger(info.size) || info.size < 1 || info.size > limit) fail('path')
      const bytes = Buffer.alloc(info.size + 1)
      let count = 0
      while (count < bytes.length) {
        const read = await file.read(bytes, count, bytes.length - count, null)
        if (!read.bytesRead) break
        count += read.bytesRead
      }
      if (count !== info.size || (await file.stat()).size !== info.size) fail('path')
      return bytes.subarray(0, count)
    } finally { await file.close() }
  },
  writeExclusive: (path, bytes) => writeFile(path, bytes, { flag: 'wx', mode: 0o600 }),
  linkExclusive: link,
  unlink,
}

interface Receipt { repository: typeof BUCKLER_CLOUD_REPOSITORY; secret: typeof BUCKLER_CLOUD_SECRET; uploadedAt: string }
function receipt(value: unknown): Receipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('receipt-invalid')
  const item = value as Record<string, unknown>
  if (Object.keys(item).length !== 3 || Object.keys(item).some(key => !['repository', 'secret', 'uploadedAt'].includes(key))
    || item.repository !== BUCKLER_CLOUD_REPOSITORY || item.secret !== BUCKLER_CLOUD_SECRET
    || typeof item.uploadedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(item.uploadedAt)
    || !Number.isFinite(Date.parse(item.uploadedAt)) || new Date(item.uploadedAt).toISOString() !== item.uploadedAt) fail('receipt-invalid')
  return { repository: BUCKLER_CLOUD_REPOSITORY, secret: BUCKLER_CLOUD_SECRET, uploadedAt: item.uploadedAt }
}

export interface CloudSendDependencies {
  store?: Pick<BucklerSessionStore, 'load' | 'identity' | 'checkCapturePath'>
  io?: CloudSessionIo
  runGh?: (operation: GhOperation, input?: string) => Promise<string>
  confirm?: () => Promise<string>
  isTTY?: boolean
  now?: () => Date
  write?: (message: string) => void
}

/** Only synthetic dependencies are needed in tests; real authentication is never printed. */
export async function main(args = process.argv.slice(2), dependencies: CloudSendDependencies = {}): Promise<void> {
  const mode = parseCloudSendArguments(args)
  const write = dependencies.write ?? console.log
  if (mode === 'help') { write(HELP); return }
  const io = dependencies.io ?? defaultIo
  const gh = dependencies.runGh ?? defaultGh
  const store = dependencies.store ?? createBucklerSessionStore()
  async function inspect(path: string): Promise<CloudSessionFileInfo | null> {
    const value = await io.inspect(path)
    if (value && (value.symbolicLink || value.reparsePoint || value.kind === 'other')) fail('path')
    return value
  }
  async function directories(create: boolean): Promise<void> {
    const ancestors: string[] = []
    for (let path = ROOT; ; path = dirname(path)) { ancestors.unshift(path); if (path === dirname(path)) break }
    for (const path of ancestors) if ((await inspect(path))?.kind !== 'directory') fail('path')
    for (const path of [LOCAL, DIRECTORY]) {
      let info = await inspect(path)
      if (!info && create) { await io.mkdir(path); info = await inspect(path) }
      if (info?.kind !== 'directory') fail(create ? 'path' : 'receipt-missing')
    }
  }
  async function readSmall(path: string): Promise<string> {
    const info = await inspect(path)
    if (info?.kind !== 'file' || !Number.isSafeInteger(info.size) || info.size < 1 || info.size > SMALL_FILE_LIMIT) fail('path')
    const bytes = Buffer.from(await io.readBounded(path, SMALL_FILE_LIMIT))
    if (bytes.length !== info.size || bytes.length > SMALL_FILE_LIMIT || (await inspect(path))?.kind !== 'file') fail('path')
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  }
  async function readReceipt(): Promise<Receipt> {
    await directories(false)
    if (!await inspect(BUCKLER_CLOUD_RECEIPT_PATH)) fail('receipt-missing')
    try { return receipt(JSON.parse(await readSmall(BUCKLER_CLOUD_RECEIPT_PATH))) }
    catch (error) { if (error instanceof BucklerCloudSendError && error.code === 'path') throw error; return fail('receipt-invalid') }
  }
  async function hasSecret(): Promise<boolean> {
    let output: string
    try { output = await gh('list') } catch { return fail('github') }
    try {
      if (typeof output !== 'string' || Buffer.byteLength(output) > LIST_LIMIT) fail('github')
      const names: unknown = JSON.parse(output)
      if (!Array.isArray(names) || names.some(value => !value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).length !== 1 || typeof value.name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,255}$/.test(value.name))) fail('github')
      return names.some(value => value.name.toUpperCase() === BUCKLER_CLOUD_SECRET)
    } catch { return fail('github') }
  }
  async function removeReceipt(expected: Receipt): Promise<void> {
    if (JSON.stringify(await readReceipt()) !== JSON.stringify(expected)) fail('receipt-invalid')
    await io.unlink(BUCKLER_CLOUD_RECEIPT_PATH)
  }
  async function cleanup(expected: Receipt): Promise<void> {
    if (JSON.stringify(await readReceipt()) !== JSON.stringify(expected)) fail('receipt-invalid')
    if (await hasSecret()) {
      try { await gh('delete') } catch { return fail('cleanup-needed') }
      if (await hasSecret()) fail('cleanup-needed')
    }
    await removeReceipt(expected)
  }
  async function writeReceipt(value: Receipt): Promise<void> {
    const temporary = `${BUCKLER_CLOUD_RECEIPT_PATH}.tmp-${randomUUID()}`
    const bytes = Buffer.from(JSON.stringify(receipt(value)) + '\n')
    let staged = false
    try {
      await directories(true)
      if (await inspect(BUCKLER_CLOUD_RECEIPT_PATH)) fail('receipt-exists')
      if (await inspect(temporary)) fail('path')
      await io.writeExclusive(temporary, bytes); staged = true
      await directories(false)
      if ((await inspect(temporary))?.kind !== 'file' || await readSmall(temporary) !== bytes.toString('utf8')) fail('path')
      // Hard-link creation is atomic and refuses to replace an existing receipt.
      await io.linkExclusive(temporary, BUCKLER_CLOUD_RECEIPT_PATH)
    } finally { if (staged) await io.unlink(temporary).catch(() => {}) }
  }
  try {
    if (mode === 'cleanup') {
      const previous = await readReceipt()
      await cleanup(previous)
      write('固定のActions Secretを削除し、ローカル送信記録の後処理を完了しました。')
      return
    }
    if (!(dependencies.isTTY ?? (process.stdin.isTTY && process.stdout.isTTY))) fail('interactive')
    write(HELP)
    let answer: string
    try {
      if (dependencies.confirm) answer = await dependencies.confirm()
      else {
        const terminal = createInterface({ input: process.stdin, output: process.stdout })
        try { answer = await terminal.question('上記の固定Actions Secretへの認証状態の送信に同意する場合は UPLOAD: ', { signal: AbortSignal.timeout(15 * 60_000) }) }
        finally { terminal.close() }
      }
    } catch { return fail('cancelled') }
    if (answer.trim() !== 'UPLOAD') fail('cancelled')
    await directories(true)
    if (await inspect(BUCKLER_CLOUD_RECEIPT_PATH)) fail('receipt-exists')
    if (await hasSecret()) fail('existing-secret')
    let capture
    try {
      await store.checkCapturePath(BUCKLER_SESSION_CAPTURE_PATH)
      capture = parseCaptureRecord(JSON.parse(await readSmall(BUCKLER_SESSION_CAPTURE_PATH)))
      await store.checkCapturePath(BUCKLER_SESSION_CAPTURE_PATH)
    } catch { return fail('capture') }
    if (await store.identity() !== capture.stateIdentity) fail('identity')
    let state: string
    try { state = validateBucklerSessionState(await store.load()) } catch { return fail('state') }
    if (await store.identity() !== capture.stateIdentity) fail('identity')
    if (Buffer.byteLength(state, 'utf8') >= BUCKLER_CLOUD_SECRET_LIMIT) fail('size')
    const date = (dependencies.now ?? (() => new Date()))()
    if (!(date instanceof Date) || !Number.isFinite(date.getTime())) fail('path')
    const uploaded = receipt({ repository: BUCKLER_CLOUD_REPOSITORY, secret: BUCKLER_CLOUD_SECRET, uploadedAt: date.toISOString() })
    // Persist only non-secret ownership metadata before transmission, so interruption
    // during gh can always be followed by the fixed-target cleanup command.
    await writeReceipt(uploaded)
    try { await gh('set', state) } catch {
      try { await cleanup(uploaded) } catch { return fail('cleanup-needed') }
      return fail('upload')
    }
    write('固定のActions Secretへの送信を完了しました。平文の認証内容は表示・ファイル保存していません。単発検証後に --cleanup を実行してください。')
  } catch (error) { throw safeError(error) }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(safeError(error).message); process.exitCode = 1 })
}
