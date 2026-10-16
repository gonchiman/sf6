import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BUCKLER_AUTH_PROBE_URL } from './buckler-auth-probe.ts'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const LOCAL_ROOT = resolve(REPO_ROOT, '.local')
const DIRECTORY = resolve(LOCAL_ROOT, 'buckler-auth-probe')
export const BUCKLER_MANUAL_PROFILE_RELATIVE_PATH = '.local/buckler-auth-probe/manual-browser-profile'
export const BUCKLER_MANUAL_PROFILE_PATH = resolve(REPO_ROOT, BUCKLER_MANUAL_PROFILE_RELATIVE_PATH)
export const BUCKLER_MANUAL_LAUNCH_PATH = resolve(DIRECTORY, 'manual-browser-launch.json')
export const BUCKLER_MANUAL_LOGIN_PATH = resolve(DIRECTORY, 'manual-browser-login.json')
export const BUCKLER_MANUAL_DEBUG_PATH = resolve(BUCKLER_MANUAL_PROFILE_PATH, 'DevToolsActivePort')
const LOCK_PATH = resolve(DIRECTORY, 'manual-browser-launch.lock')
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export type BucklerManualBrowserErrorCode = 'unsupported-platform' | 'unsafe-path' | 'already-open'
  | 'edge-unavailable' | 'launch-failed' | 'missing-browser' | 'identity-mismatch' | 'io-failed' | 'cancelled'
const MESSAGES: Record<BucklerManualBrowserErrorCode, string> = {
  'unsupported-platform': '手動ブラウザーの検証はWindowsで実行してください。',
  'unsafe-path': '検証用ブラウザーの保存先にリンクまたは不正なファイルがあります。',
  'already-open': '検証用ブラウザーまたは起動記録が残っています。終了状態を確認してください。',
  'edge-unavailable': 'Microsoft署名を確認できるインストール済みEdgeが見つかりません。',
  'launch-failed': '専用Edgeの起動を確認できませんでした。',
  'missing-browser': '専用Edgeの起動記録がありません。先に手動ブラウザーを開いてください。',
  'identity-mismatch': '起動した専用Edgeとの一致を確認できないため、接続・終了は行いません。',
  'io-failed': '専用Edgeの安全な起動・接続・終了を完了できませんでした。',
  'cancelled': '専用Edgeの起動・切り替えを中止しました。',
}
export class BucklerManualBrowserError extends Error {
  readonly code: BucklerManualBrowserErrorCode
  constructor(code: BucklerManualBrowserErrorCode) {
    super(MESSAGES[code] ?? MESSAGES['io-failed'])
    this.name = 'BucklerManualBrowserError'
    this.code = Object.hasOwn(MESSAGES, code) ? code : 'io-failed'
  }
}
function fail(code: BucklerManualBrowserErrorCode): never { throw new BucklerManualBrowserError(code) }
function safeError(error: unknown): BucklerManualBrowserError {
  return new BucklerManualBrowserError(error instanceof BucklerManualBrowserError ? error.code : 'io-failed')
}

export interface ManualBrowserLaunch {
  launchId: string
  processId: number
  startedAt: string
  processCreatedAt: string
  profilePath: typeof BUCKLER_MANUAL_PROFILE_RELATIVE_PATH
}
interface LaunchRecord extends ManualBrowserLaunch { schemaVersion: 1; port: number; browserId: string }
interface LoginRecord extends ManualBrowserLaunch { schemaVersion: 1 }
export interface ManualBrowserFileInfo { kind: 'directory' | 'file' | 'other'; symbolicLink: boolean; reparsePoint: boolean; size: number }
/** The helper only inspects directories and reads its metadata and DevToolsActivePort. */
export interface ManualBrowserIo {
  inspect(path: string): Promise<ManualBrowserFileInfo | null>
  inspectMany?(paths: readonly string[]): Promise<(ManualBrowserFileInfo | null)[]>
  mkdir(path: string): Promise<void>
  readFile(path: string): Promise<Uint8Array>
  writeFile(path: string, bytes: Uint8Array): Promise<void>
  rename(from: string, to: string): Promise<void>
  unlink(path: string): Promise<void>
}
export interface ManualBrowserProcessIdentity {
  processId: number
  createdAt: string
  officialEdge: boolean
  dedicatedProfile: boolean
  browserProcess: boolean
}
export interface ManualBrowserRuntime {
  launch(profilePath: string, arguments_: readonly string[]): Promise<number>
  inspectProcess(processId: number, profilePath: string): Promise<ManualBrowserProcessIdentity | null>
  hasRunningProfile(profilePath: string): Promise<boolean>
  ownsLoopbackListener(processId: number, port: number): Promise<boolean>
  closeProcess(processId: number, createdAt: string, profilePath: string): Promise<void>
  sleep(milliseconds: number): Promise<void>
}
export interface ManualBrowserOptions { io?: ManualBrowserIo; runtime?: ManualBrowserRuntime; platform?: NodeJS.Platform }
export interface ManualBrowserController {
  prepareManualBrowser(): Promise<ManualBrowserLaunch>
  prepareManualLoginBrowser(signal?: AbortSignal): Promise<ManualBrowserLaunch>
  restartManualBrowserForCapture(signal?: AbortSignal): Promise<ManualBrowserLaunch>
  closeManualLoginBrowser(): Promise<void>
  readManualBrowserEndpoint(): Promise<{ endpointURL: string; launch: ManualBrowserLaunch }>
  closeManualBrowser(): Promise<void>
}

function iso(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try { return new Date(value).toISOString() === value } catch { return false }
}
function launchOnly(record: ManualBrowserLaunch): ManualBrowserLaunch {
  return { launchId: record.launchId, processId: record.processId, startedAt: record.startedAt,
    processCreatedAt: record.processCreatedAt, profilePath: record.profilePath }
}
function parseLoginRecord(value: unknown): LoginRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('identity-mismatch')
  const item = value as Record<string, unknown>
  if (Object.keys(item).sort().join(',') !== 'launchId,processCreatedAt,processId,profilePath,schemaVersion,startedAt'
    || item.schemaVersion !== 1 || typeof item.launchId !== 'string' || !UUID.test(item.launchId)
    || !Number.isSafeInteger(item.processId) || (item.processId as number) < 1
    || !iso(item.startedAt) || !iso(item.processCreatedAt)
    || item.profilePath !== BUCKLER_MANUAL_PROFILE_RELATIVE_PATH) fail('identity-mismatch')
  return item as unknown as LoginRecord
}
function parseRecord(value: unknown): LaunchRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('identity-mismatch')
  const item = value as Record<string, unknown>
  if (Object.keys(item).sort().join(',') !== 'browserId,launchId,port,processCreatedAt,processId,profilePath,schemaVersion,startedAt'
    || item.schemaVersion !== 1 || typeof item.launchId !== 'string' || !UUID.test(item.launchId)
    || !Number.isSafeInteger(item.processId) || (item.processId as number) < 1
    || !iso(item.startedAt) || !iso(item.processCreatedAt)
    || item.profilePath !== BUCKLER_MANUAL_PROFILE_RELATIVE_PATH
    || !Number.isSafeInteger(item.port) || (item.port as number) < 1 || (item.port as number) > 65535
    || typeof item.browserId !== 'string' || !UUID.test(item.browserId)) fail('identity-mismatch')
  return item as unknown as LaunchRecord
}
export function parseManualDevToolsPort(value: Uint8Array): { port: number; browserId: string } {
  if (value.byteLength < 1 || value.byteLength > 256) fail('identity-mismatch')
  let text: string
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(value) } catch { return fail('identity-mismatch') }
  const match = /^([1-9]\d{0,4})\r?\n\/devtools\/browser\/([0-9a-f-]{36})(?:\r?\n)?$/.exec(text)
  if (!match || Number(match[1]) > 65535 || !UUID.test(match[2])) fail('identity-mismatch')
  return { port: Number(match[1]), browserId: match[2] }
}
/** No Playwright launch, automation flag removal, user-agent override or profile copy. */
export function manualEdgeArguments(): readonly string[] {
  return [`--user-data-dir=${BUCKLER_MANUAL_PROFILE_PATH}`, '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0', '--new-window', BUCKLER_AUTH_PROBE_URL]
}
export function manualLoginEdgeArguments(): readonly string[] {
  return [`--user-data-dir=${BUCKLER_MANUAL_PROFILE_PATH}`, '--new-window', BUCKLER_AUTH_PROBE_URL]
}

const PREAMBLE = `$ErrorActionPreference='Stop'; [Console]::InputEncoding=[Text.UTF8Encoding]::new($false); [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);`
const PROFILE_TEST = `function Uses-Profile($command,$profile) { if(!$command) { return $false }; $pattern='(?:^|\\s)(?:"--user-data-dir='+[regex]::Escape($profile)+'"|--user-data-dir="'+[regex]::Escape($profile)+'"|--user-data-dir='+[regex]::Escape($profile)+')(?=\\s|$)'; return [regex]::IsMatch($command,$pattern,[Text.RegularExpressions.RegexOptions]::IgnoreCase) };`
// Windows PowerShell 5 can inherit a PowerShell 7 PSModulePath that breaks security-module autoloading.
// Load its own bundled manifest explicitly; signature verification remains mandatory.
const EDGE_TEST = `function Is-OfficialEdge($path,$paths) { if(!$path -or !($paths -contains $path)) { return $false }; $item=Get-Item -LiteralPath $path; if($item.VersionInfo.ProductName -ne 'Microsoft Edge') { return $false }; Import-Module -Name ([IO.Path]::Combine($PSHOME,'Modules','Microsoft.PowerShell.Security','Microsoft.PowerShell.Security.psd1')) -ErrorAction Stop; $signature=Get-AuthenticodeSignature -LiteralPath $path; return $signature.Status -eq 'Valid' -and $signature.SignerCertificate.Subject -match '(?:^|, )O=Microsoft Corporation(?:,|$)' };`
const INSPECT_SCRIPT = `${PREAMBLE}${PROFILE_TEST}${EDGE_TEST} try { $inputValue=ConvertFrom-Json ([Console]::In.ReadToEnd()); $entry=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$inputValue.processId); if(!$entry) { [Console]::Out.Write('null'); exit 0 }; $result=@{processId=[int]$entry.ProcessId;createdAt=$entry.CreationDate.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ');officialEdge=[bool](Is-OfficialEdge $entry.ExecutablePath $inputValue.paths);dedicatedProfile=[bool](Uses-Profile $entry.CommandLine $inputValue.profile);browserProcess=[bool]($entry.Name -ieq 'msedge.exe' -and $entry.CommandLine -notmatch '(?:^|\\s)--type=')}; [Console]::Out.Write((ConvertTo-Json -Compress $result)) } catch { exit 1 }`
const RUNNING_SCRIPT = `${PREAMBLE}${PROFILE_TEST} try { $inputValue=[Console]::In.ReadToEnd(); $entries=@(Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { Uses-Profile $_.CommandLine $inputValue }); [Console]::Out.Write([int][bool]$entries.Count) } catch { exit 1 }`
const LISTENER_SCRIPT = `${PREAMBLE} try { $inputValue=ConvertFrom-Json ([Console]::In.ReadToEnd()); $entries=@(Get-NetTCPConnection -State Listen -LocalPort ([int]$inputValue.port) -ErrorAction SilentlyContinue); $ok=$entries.Count -gt 0 -and @($entries | Where-Object { $_.LocalAddress -ne '127.0.0.1' -or $_.OwningProcess -ne [int]$inputValue.processId }).Count -eq 0; [Console]::Out.Write([int][bool]$ok) } catch { exit 1 }`
const CLOSE_SCRIPT = `${PREAMBLE}${PROFILE_TEST}${EDGE_TEST} try { $inputValue=ConvertFrom-Json ([Console]::In.ReadToEnd()); function Check-Process { $entry=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$inputValue.processId); if(!$entry) { return $null }; if($entry.Name -ine 'msedge.exe' -or $entry.CommandLine -match '(?:^|\\s)--type=' -or !(Uses-Profile $entry.CommandLine $inputValue.profile) -or !(Is-OfficialEdge $entry.ExecutablePath $inputValue.paths) -or $entry.CreationDate.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ') -ne $inputValue.createdAt) { throw 'mismatch' }; return $entry }; if(!(Check-Process)) { exit 0 }; $process=[Diagnostics.Process]::GetProcessById([int]$inputValue.processId); $null=$process.CloseMainWindow(); if(!$process.WaitForExit(5000)) { if(Check-Process) { Stop-Process -Id ([int]$inputValue.processId) -Force -ErrorAction Stop }; if(!$process.WaitForExit(5000)) { exit 1 } } } catch { exit 1 }`
const REPARSE_MANY_SCRIPT = `${PREAMBLE} try { $paths=ConvertFrom-Json ([Console]::In.ReadToEnd()); $flags=@(foreach($path in $paths) { $item=Get-Item -LiteralPath $path -Force; [int][bool]($item.Attributes -band [IO.FileAttributes]::ReparsePoint) }); [Console]::Out.Write((ConvertTo-Json -Compress -InputObject $flags)) } catch { exit 1 }`
const EDGE_PATH_SCRIPT = `${PREAMBLE}${EDGE_TEST} try { $inputValue=ConvertFrom-Json ([Console]::In.ReadToEnd()); foreach($path in $inputValue.paths) { if((Test-Path -LiteralPath $path -PathType Leaf) -and (Is-OfficialEdge $path $inputValue.paths)) { [Console]::Out.Write($path); exit 0 } }; exit 1 } catch { exit 1 }`

function edgePaths(): string[] {
  return [...new Set([process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA]
    .filter((value): value is string => Boolean(value)).map(value => resolve(value, 'Microsoft/Edge/Application/msedge.exe')))]
}
function powershell(script: string, input: string, limit = 2048): Promise<string> {
  if (process.platform !== 'win32') return Promise.reject(new BucklerManualBrowserError('unsupported-platform'))
  return new Promise((resolveOutput, reject) => {
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    const chunks: Buffer[] = []
    let size = 0; let finished = false
    const finish = (failed: boolean) => {
      if (finished) return
      finished = true; clearTimeout(timer)
      if (failed) reject(new BucklerManualBrowserError('identity-mismatch'))
      else resolveOutput(Buffer.concat(chunks).toString('utf8'))
    }
    const timer = setTimeout(() => { child.kill(); finish(true) }, 15_000)
    child.stdout.on('data', (chunk: Buffer) => { size += chunk.length; if (size > limit) { child.kill(); finish(true) } else chunks.push(chunk) })
    child.stderr.on('data', () => {})
    child.on('error', () => finish(true)); child.on('close', code => finish(code !== 0))
    child.stdin.on('error', () => finish(true)); child.stdin.end(input, 'utf8')
  })
}
async function inspectNative(paths: readonly string[]): Promise<(ManualBrowserFileInfo | null)[]> {
  const entries = await Promise.all(paths.map(async path => {
    try { return await lstat(path) } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null
      throw error
    }
  }))
  const checked = paths.filter((_, index) => entries[index] && !entries[index]!.isSymbolicLink())
  const flags: unknown = checked.length ? JSON.parse(await powershell(REPARSE_MANY_SCRIPT, JSON.stringify(checked))) : []
  if (!Array.isArray(flags) || flags.length !== checked.length || flags.some(flag => flag !== 0 && flag !== 1)) fail('unsafe-path')
  let flagIndex = 0
  return entries.map(stat => {
    if (!stat) return null
    const symbolicLink = stat.isSymbolicLink()
    return { kind: stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other', symbolicLink,
      reparsePoint: symbolicLink || flags[flagIndex++] === 1, size: stat.size }
  })
}
const defaultIo: ManualBrowserIo = {
  inspect: async path => (await inspectNative([path]))[0]!, inspectMany: inspectNative,
  mkdir: path => mkdir(path, { mode: 0o700 }).then(() => {}), readFile,
  writeFile: (path, bytes) => writeFile(path, bytes, { flag: 'wx', mode: 0o600 }), rename, unlink,
}
/** Checks only the public Edge executable and signature; never starts Edge or reads browser data. */
export async function findManualEdgeExecutable(): Promise<string> {
  let executable: string
  try { executable = await powershell(EDGE_PATH_SCRIPT, JSON.stringify({ paths: edgePaths() })) }
  catch { return fail('edge-unavailable') }
  if (!edgePaths().includes(executable)) fail('edge-unavailable')
  return executable
}
const defaultRuntime: ManualBrowserRuntime = {
  launch: async (_profile, args) => {
    const executable = await findManualEdgeExecutable()
    return new Promise((resolveProcess, reject) => {
      const child = spawn(executable, [...args], { shell: false, windowsHide: false, detached: true, stdio: 'ignore' })
      child.once('error', () => reject(new BucklerManualBrowserError('launch-failed')))
      child.once('spawn', () => { if (!child.pid) { reject(new BucklerManualBrowserError('launch-failed')); return }; child.unref(); resolveProcess(child.pid) })
    })
  },
  inspectProcess: async (processId, profile) => JSON.parse(await powershell(INSPECT_SCRIPT, JSON.stringify({ processId, profile, paths: edgePaths() }))),
  hasRunningProfile: async profile => { const result = await powershell(RUNNING_SCRIPT, profile, 8); if (result !== '0' && result !== '1') fail('identity-mismatch'); return result === '1' },
  ownsLoopbackListener: async (processId, port) => { const result = await powershell(LISTENER_SCRIPT, JSON.stringify({ processId, port }), 8); if (result !== '0' && result !== '1') fail('identity-mismatch'); return result === '1' },
  closeProcess: (processId, createdAt, profile) => powershell(CLOSE_SCRIPT, JSON.stringify({ processId, createdAt, profile, paths: edgePaths() })).then(() => {}),
  sleep: milliseconds => new Promise(resolveSleep => setTimeout(resolveSleep, milliseconds)),
}

export function createManualBrowserController(options: ManualBrowserOptions = {}): ManualBrowserController {
  if (Object.keys(options).some(key => !['io', 'runtime', 'platform'].includes(key))) fail('unsafe-path')
  const io = options.io ?? defaultIo; const runtime = options.runtime ?? defaultRuntime
  const platform = options.platform ?? process.platform
  function windows() { if (platform !== 'win32') fail('unsupported-platform') }
  async function inspect(path: string): Promise<ManualBrowserFileInfo | null> {
    const info = await io.inspect(path)
    if (info && (info.symbolicLink || info.reparsePoint || info.kind === 'other')) fail('unsafe-path')
    return info
  }
  async function directories(create: boolean) {
    const ancestors: string[] = []
    for (let path = REPO_ROOT; ; path = dirname(path)) { ancestors.unshift(path); if (path === dirname(path)) break }
    const inspected = io.inspectMany ? await io.inspectMany([...ancestors, LOCAL_ROOT, DIRECTORY, BUCKLER_MANUAL_PROFILE_PATH])
      : await Promise.all([...ancestors, LOCAL_ROOT, DIRECTORY, BUCKLER_MANUAL_PROFILE_PATH].map(path => io.inspect(path)))
    if (inspected.length !== ancestors.length + 3) fail('unsafe-path')
    for (const info of inspected) { if (info && (info.symbolicLink || info.reparsePoint || info.kind === 'other')) fail('unsafe-path') }
    if (inspected.slice(0, ancestors.length).some(info => info?.kind !== 'directory')) fail('unsafe-path')
    for (const [index, path] of [LOCAL_ROOT, DIRECTORY, BUCKLER_MANUAL_PROFILE_PATH].entries()) {
      let info = inspected[ancestors.length + index] ?? null
      if (!info && create) { await io.mkdir(path); info = await inspect(path) }
      if (info?.kind !== 'directory') fail(create ? 'unsafe-path' : 'missing-browser')
    }
  }
  async function boundedRead(path: string, limit: number): Promise<Uint8Array> {
    await directories(false)
    const before = await inspect(path)
    if (!before) fail('missing-browser')
    if (before.kind !== 'file' || !Number.isSafeInteger(before.size) || before.size < 1 || before.size > limit) fail('unsafe-path')
    const bytes = await io.readFile(path)
    const after = await inspect(path)
    if (after?.kind !== 'file' || after.size !== before.size || bytes.byteLength !== before.size || bytes.byteLength > limit) fail('unsafe-path')
    return bytes
  }
  async function readRecord(): Promise<LaunchRecord> {
    return parseRecord(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await boundedRead(BUCKLER_MANUAL_LAUNCH_PATH, 2048))))
  }
  async function readLoginRecord(): Promise<LoginRecord> {
    return parseLoginRecord(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await boundedRead(BUCKLER_MANUAL_LOGIN_PATH, 2048))))
  }
  function checkAbort(signal?: AbortSignal) { if (signal?.aborted) fail('cancelled') }
  async function processIdentity(processId: number, createdAt?: string): Promise<ManualBrowserProcessIdentity | null> {
    const identity = await runtime.inspectProcess(processId, BUCKLER_MANUAL_PROFILE_PATH)
    if (identity && (identity.processId !== processId || !iso(identity.createdAt) || !identity.officialEdge
      || !identity.dedicatedProfile || !identity.browserProcess || (createdAt && identity.createdAt !== createdAt))) fail('identity-mismatch')
    return identity
  }
  async function verifiedRecord(requireAlive = true): Promise<LaunchRecord> {
    if (await inspect(BUCKLER_MANUAL_LOGIN_PATH)) fail('already-open')
    const record = await readRecord()
    const identity = await processIdentity(record.processId, record.processCreatedAt)
    const debugInfo = await inspect(BUCKLER_MANUAL_DEBUG_PATH)
    if (debugInfo) {
      const debug = parseManualDevToolsPort(await boundedRead(BUCKLER_MANUAL_DEBUG_PATH, 256))
      if (debug.port !== record.port || debug.browserId !== record.browserId) fail('identity-mismatch')
    } else if (identity || requireAlive) fail('missing-browser')
    if (identity) { if (!await runtime.ownsLoopbackListener(record.processId, record.port)) fail('identity-mismatch') }
    else if (requireAlive) fail('missing-browser')
    return record
  }
  async function closeOwnedLoginProcess(identity: ManualBrowserProcessIdentity) {
    await directories(false)
    if (await processIdentity(identity.processId, identity.createdAt)) {
      await runtime.closeProcess(identity.processId, identity.createdAt, BUCKLER_MANUAL_PROFILE_PATH)
      if (await processIdentity(identity.processId, identity.createdAt)) fail('identity-mismatch')
    }
    if (await runtime.hasRunningProfile(BUCKLER_MANUAL_PROFILE_PATH)) fail('identity-mismatch')
  }
  async function removeLoginRecord(expected: LoginRecord) {
    if (JSON.stringify(await readLoginRecord()) !== JSON.stringify(expected)) fail('identity-mismatch')
    await io.unlink(BUCKLER_MANUAL_LOGIN_PATH)
  }
  async function closeFailedLaunch(identity: ManualBrowserProcessIdentity, observedDebug?: { port: number; browserId: string }) {
    await directories(false)
    if (await processIdentity(identity.processId, identity.createdAt)) {
      // This value authorizes metadata cleanup only, never a CDP connection.
      if (!observedDebug && await inspect(BUCKLER_MANUAL_DEBUG_PATH)) {
        try {
          const candidate = parseManualDevToolsPort(await boundedRead(BUCKLER_MANUAL_DEBUG_PATH, 256))
          observedDebug = candidate
        } catch { /* A malformed debug file does not authorize deleting it; the owned PID can still be closed. */ }
      }
      await runtime.closeProcess(identity.processId, identity.createdAt, BUCKLER_MANUAL_PROFILE_PATH)
      if (await processIdentity(identity.processId, identity.createdAt)) fail('identity-mismatch')
    }
    if (await runtime.hasRunningProfile(BUCKLER_MANUAL_PROFILE_PATH)) fail('identity-mismatch')
    if (observedDebug && await inspect(BUCKLER_MANUAL_DEBUG_PATH)) {
      const current = parseManualDevToolsPort(await boundedRead(BUCKLER_MANUAL_DEBUG_PATH, 256))
      if (current.port !== observedDebug.port || current.browserId !== observedDebug.browserId) fail('identity-mismatch')
      await io.unlink(BUCKLER_MANUAL_DEBUG_PATH)
    }
  }
  const controller: ManualBrowserController = {
    async prepareManualLoginBrowser(signal) {
      let lockId: string | undefined; let staged: string | undefined
      let ownedProcess: ManualBrowserProcessIdentity | undefined
      let record: LoginRecord | undefined; let recorded = false; let prepared = false
      try {
        windows(); checkAbort(signal); await directories(true)
        const conflicts = [LOCK_PATH, BUCKLER_MANUAL_LAUNCH_PATH, BUCKLER_MANUAL_LOGIN_PATH, BUCKLER_MANUAL_DEBUG_PATH]
        for (const path of conflicts) { if (await inspect(path)) fail('already-open') }
        if (await runtime.hasRunningProfile(BUCKLER_MANUAL_PROFILE_PATH)) fail('already-open')
        checkAbort(signal)
        const launchId = randomUUID()
        await io.writeFile(LOCK_PATH, Buffer.from(launchId, 'utf8')); lockId = launchId
        await directories(false)
        for (const path of conflicts.slice(1)) { if (await inspect(path)) fail('already-open') }
        if (await runtime.hasRunningProfile(BUCKLER_MANUAL_PROFILE_PATH)) fail('already-open')
        checkAbort(signal)
        const startedAt = new Date().toISOString()
        const processId = await runtime.launch(BUCKLER_MANUAL_PROFILE_PATH, manualLoginEdgeArguments())
        if (!Number.isSafeInteger(processId) || processId < 1) fail('launch-failed')
        const identity = await processIdentity(processId)
        if (!identity) fail('launch-failed')
        ownedProcess = identity
        checkAbort(signal)
        record = parseLoginRecord({ schemaVersion: 1, launchId, processId, startedAt,
          processCreatedAt: identity.createdAt, profilePath: BUCKLER_MANUAL_PROFILE_RELATIVE_PATH })
        staged = `${BUCKLER_MANUAL_LOGIN_PATH}.tmp-${launchId}`
        if (await inspect(staged)) fail('already-open')
        await io.writeFile(staged, Buffer.from(JSON.stringify(record) + '\n', 'utf8'))
        await directories(false)
        if ((await inspect(staged))?.kind !== 'file') fail('unsafe-path')
        for (const path of conflicts.slice(1)) { if (await inspect(path)) fail('already-open') }
        if (!await processIdentity(processId, identity.createdAt)) fail('identity-mismatch')
        checkAbort(signal)
        await io.rename(staged, BUCKLER_MANUAL_LOGIN_PATH); staged = undefined; recorded = true
        checkAbort(signal); prepared = true
        return launchOnly(record)
      } catch (error) { throw safeError(error) } finally {
        if (ownedProcess && !prepared) {
          try { await closeOwnedLoginProcess(ownedProcess); if (recorded && record) await removeLoginRecord(record) } catch {}
        }
        if (staged) { try { await directories(false); if ((await inspect(staged))?.kind === 'file') await io.unlink(staged) } catch {} }
        if (lockId) { try { const value = new TextDecoder().decode(await boundedRead(LOCK_PATH, 64)); if (value === lockId) await io.unlink(LOCK_PATH) } catch {} }
      }
    },
    async closeManualLoginBrowser() {
      try {
        windows(); await directories(false)
        if (await inspect(BUCKLER_MANUAL_LAUNCH_PATH)) fail('already-open')
        const record = await readLoginRecord()
        const identity = await processIdentity(record.processId, record.processCreatedAt)
        if (identity) await closeOwnedLoginProcess(identity)
        else if (await runtime.hasRunningProfile(BUCKLER_MANUAL_PROFILE_PATH)) fail('identity-mismatch')
        await removeLoginRecord(record)
      } catch (error) { throw safeError(error) }
    },
    async restartManualBrowserForCapture(signal) {
      try {
        windows(); checkAbort(signal)
        await controller.closeManualLoginBrowser()
        checkAbort(signal)
        const launch = await controller.prepareManualBrowser()
        if (signal?.aborted) {
          try { await controller.closeManualBrowser() } catch {}
          fail('cancelled')
        }
        return launch
      } catch (error) { throw safeError(error) }
    },
    async prepareManualBrowser() {
      let lockId: string | undefined; let staged: string | undefined
      let ownedProcess: ManualBrowserProcessIdentity | undefined
      let observedDebug: { port: number; browserId: string } | undefined
      let prepared = false
      try {
        windows(); await directories(true)
        for (const path of [LOCK_PATH, BUCKLER_MANUAL_LAUNCH_PATH, BUCKLER_MANUAL_LOGIN_PATH, BUCKLER_MANUAL_DEBUG_PATH]) { if (await inspect(path)) fail('already-open') }
        if (await runtime.hasRunningProfile(BUCKLER_MANUAL_PROFILE_PATH)) fail('already-open')
        const launchId = randomUUID()
        await io.writeFile(LOCK_PATH, Buffer.from(launchId, 'utf8')); lockId = launchId
        await directories(false)
        if (await inspect(BUCKLER_MANUAL_DEBUG_PATH) || await inspect(BUCKLER_MANUAL_LAUNCH_PATH) || await inspect(BUCKLER_MANUAL_LOGIN_PATH)
          || await runtime.hasRunningProfile(BUCKLER_MANUAL_PROFILE_PATH)) fail('already-open')
        const startedAt = new Date().toISOString()
        const processId = await runtime.launch(BUCKLER_MANUAL_PROFILE_PATH, manualEdgeArguments())
        if (!Number.isSafeInteger(processId) || processId < 1) fail('launch-failed')
        const identity = await processIdentity(processId)
        if (!identity) fail('launch-failed')
        ownedProcess = identity
        let debug: { port: number; browserId: string } | undefined
        for (let attempt = 0; attempt < 60; attempt++) {
          await directories(false)
          if (await inspect(BUCKLER_MANUAL_DEBUG_PATH)) { debug = parseManualDevToolsPort(await boundedRead(BUCKLER_MANUAL_DEBUG_PATH, 256)); break }
          await runtime.sleep(250)
        }
        if (!debug) fail('launch-failed')
        observedDebug = debug
        if (!await processIdentity(processId, identity.createdAt)
          || !await runtime.ownsLoopbackListener(processId, debug.port)) fail('identity-mismatch')
        const record = parseRecord({ schemaVersion: 1, launchId, processId, startedAt, processCreatedAt: identity.createdAt,
          profilePath: BUCKLER_MANUAL_PROFILE_RELATIVE_PATH, ...debug })
        staged = `${BUCKLER_MANUAL_LAUNCH_PATH}.tmp-${launchId}`
        if (await inspect(staged)) fail('already-open')
        await io.writeFile(staged, Buffer.from(JSON.stringify(record) + '\n', 'utf8'))
        await directories(false)
        if ((await inspect(staged))?.kind !== 'file' || await inspect(BUCKLER_MANUAL_LAUNCH_PATH)) fail('unsafe-path')
        const rechecked = parseManualDevToolsPort(await boundedRead(BUCKLER_MANUAL_DEBUG_PATH, 256))
        if (rechecked.port !== debug.port || rechecked.browserId !== debug.browserId
          || !await processIdentity(processId, identity.createdAt) || !await runtime.ownsLoopbackListener(processId, debug.port)) fail('identity-mismatch')
        await io.rename(staged, BUCKLER_MANUAL_LAUNCH_PATH); staged = undefined; prepared = true
        return launchOnly(record)
      } catch (error) { throw safeError(error) } finally {
        if (ownedProcess && !prepared) { try { await closeFailedLaunch(ownedProcess, observedDebug) } catch {} }
        if (staged) { try { await directories(false); if ((await inspect(staged))?.kind === 'file') await io.unlink(staged) } catch {} }
        if (lockId) { try { const value = new TextDecoder().decode(await boundedRead(LOCK_PATH, 64)); if (value === lockId) await io.unlink(LOCK_PATH) } catch {} }
      }
    },
    async readManualBrowserEndpoint() {
      try { windows(); const record = await verifiedRecord(); return { endpointURL: `ws://127.0.0.1:${record.port}/devtools/browser/${record.browserId}`, launch: launchOnly(record) } }
      catch (error) { throw safeError(error) }
    },
    async closeManualBrowser() {
      try {
        windows(); const record = await verifiedRecord(false)
        if (await processIdentity(record.processId, record.processCreatedAt)) {
          await runtime.closeProcess(record.processId, record.processCreatedAt, BUCKLER_MANUAL_PROFILE_PATH)
          if (await processIdentity(record.processId, record.processCreatedAt)) fail('identity-mismatch')
        }
        // Remove only our debugging/launcher metadata. Browser-managed profile data is retained.
        const rechecked = await verifiedRecord(false)
        if (JSON.stringify(rechecked) !== JSON.stringify(record)) fail('identity-mismatch')
        if (await inspect(BUCKLER_MANUAL_DEBUG_PATH)) await io.unlink(BUCKLER_MANUAL_DEBUG_PATH)
        await directories(false)
        if (JSON.stringify(await readRecord()) !== JSON.stringify(record)) fail('identity-mismatch')
        await io.unlink(BUCKLER_MANUAL_LAUNCH_PATH)
      } catch (error) { throw safeError(error) }
    },
  }
  return controller
}
export const prepareManualBrowser = (): Promise<ManualBrowserLaunch> => createManualBrowserController().prepareManualBrowser()
export const readManualBrowserEndpoint = (): Promise<{ endpointURL: string; launch: ManualBrowserLaunch }> => createManualBrowserController().readManualBrowserEndpoint()
export const closeManualBrowser = (): Promise<void> => createManualBrowserController().closeManualBrowser()
export const prepareManualLoginBrowser = (signal?: AbortSignal): Promise<ManualBrowserLaunch> => createManualBrowserController().prepareManualLoginBrowser(signal)
export const restartManualBrowserForCapture = (signal?: AbortSignal): Promise<ManualBrowserLaunch> => createManualBrowserController().restartManualBrowserForCapture(signal)
export const closeManualLoginBrowser = (): Promise<void> => createManualBrowserController().closeManualLoginBrowser()
