import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const LOCAL_ROOT = resolve(REPO_ROOT, '.local')
const SESSION_DIRECTORY = resolve(LOCAL_ROOT, 'buckler-auth-probe')
export const BUCKLER_PRIVATE_SESSION_PATH = resolve(SESSION_DIRECTORY, 'private-session.dpapi')
export const BUCKLER_SESSION_CAPTURE_PATH = resolve(SESSION_DIRECTORY, 'session-capture.json')
export const BUCKLER_SESSION_SIZE_LIMIT = 10 * 1024 * 1024

export type BucklerSessionStoreErrorCode = 'unsupported-platform' | 'unsafe-path' | 'invalid-state'
  | 'size-limit' | 'missing-session' | 'crypto-failed' | 'io-failed' | 'cancelled'

const MESSAGES: Record<BucklerSessionStoreErrorCode, string> = {
  'unsupported-platform': '認証状態の保存・再利用はWindowsの同じユーザーで実行してください。',
  'unsafe-path': '認証状態の保存先にリンクまたは不正なファイルがあります。',
  'invalid-state': '再利用する認証状態の形式・対象サイトを確認できません。',
  'size-limit': '認証状態のサイズが上限を超えています。',
  'missing-session': '保存された認証状態がありません。先に手動ログインによるcaptureが必要です。',
  'crypto-failed': '認証状態を保護または復号できません。同じWindowsユーザーでcaptureし直してください。',
  'io-failed': '認証状態の保存・読み込みを完了できませんでした。',
  'cancelled': '認証状態の保存を中止しました。',
}

export class BucklerSessionStoreError extends Error {
  readonly code: BucklerSessionStoreErrorCode
  constructor(code: BucklerSessionStoreErrorCode) {
    super(MESSAGES[code] ?? MESSAGES['io-failed'])
    this.name = 'BucklerSessionStoreError'
    this.code = Object.hasOwn(MESSAGES, code) ? code : 'io-failed'
  }
}

export interface BucklerSessionFileInfo {
  kind: 'directory' | 'file' | 'other'
  symbolicLink: boolean
  reparsePoint: boolean
  size: number
}

/** Tests may inject virtual IO. All paths supplied to it are fixed by this module. */
export interface BucklerSessionStoreIo {
  inspect(path: string): Promise<BucklerSessionFileInfo | null>
  mkdir(path: string, mode: number): Promise<void>
  readFile(path: string): Promise<Uint8Array>
  writeFile(path: string, data: Uint8Array, options: { flag: 'wx'; mode: number }): Promise<void>
  rename(from: string, to: string): Promise<void>
  unlink(path: string): Promise<void>
}

export interface BucklerSessionCrypto {
  protect(plainJson: string): Promise<string>
  unprotect(ciphertextBase64: string): Promise<string>
}

export interface BucklerSessionStoreOptions {
  io?: BucklerSessionStoreIo
  crypto?: BucklerSessionCrypto
}

export interface BucklerSessionStore {
  save(stateJson: string, intent: 'capture', signal?: AbortSignal): Promise<void>
  load(): Promise<string>
  /** Identifies the fixed ciphertext without returning or decrypting authentication state. */
  identity(): Promise<string>
  /** Checks only the fixed capture record or its UUID-named staging file. */
  checkCapturePath(path: string): Promise<void>
  exists(): Promise<boolean>
}

function fail(code: BucklerSessionStoreErrorCode): never { throw new BucklerSessionStoreError(code) }

function sanitized(error: unknown, fallback: BucklerSessionStoreErrorCode): BucklerSessionStoreError {
  return new BucklerSessionStoreError(error instanceof BucklerSessionStoreError && Object.hasOwn(MESSAGES, error.code) ? error.code : fallback)
}

function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !keys.includes(key))) fail('invalid-state')
  return value as Record<string, unknown>
}

function allowedHost(host: string): boolean {
  const canonical = host.toLowerCase()
  if (!canonical || canonical.length > 253 || canonical.split('.').some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return false
  return canonical === 'streetfighter.com' || canonical.endsWith('.streetfighter.com')
}

/** Returns normalized JSON only. Never returns validation errors containing input data. */
export function validateBucklerSessionState(stateJson: string): string {
  if (typeof stateJson !== 'string') fail('invalid-state')
  if (Buffer.byteLength(stateJson, 'utf8') > BUCKLER_SESSION_SIZE_LIMIT) fail('size-limit')
  let value: unknown
  try { value = JSON.parse(stateJson) } catch { return fail('invalid-state') }
  const input = object(value, ['cookies', 'origins'])
  if (!Array.isArray(input.cookies) || !Array.isArray(input.origins)) fail('invalid-state')
  const cookieKeys = new Set<string>()
  const cookies = input.cookies.map((value) => {
    const item = object(value, ['name', 'value', 'domain', 'path', 'expires', 'httpOnly', 'secure', 'sameSite', 'partitionKey'])
    if (typeof item.name !== 'string' || !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(item.name)
      || typeof item.value !== 'string' || /[\u0000-\u001f\u007f]/.test(item.value)
      || typeof item.domain !== 'string' || !allowedHost(item.domain.startsWith('.') ? item.domain.slice(1) : item.domain)
      || typeof item.path !== 'string' || !item.path.startsWith('/') || /[\u0000-\u001f\u007f]/.test(item.path)
      || typeof item.expires !== 'number' || !Number.isFinite(item.expires)
      || (item.expires !== -1 && (item.expires < 0 || item.expires > Number.MAX_SAFE_INTEGER))
      || typeof item.httpOnly !== 'boolean' || typeof item.secure !== 'boolean'
      || !['Strict', 'Lax', 'None'].includes(item.sameSite as string)
      || (item.partitionKey !== undefined && typeof item.partitionKey !== 'string')) fail('invalid-state')
    const key = JSON.stringify([item.domain.toLowerCase(), item.path, item.name, item.partitionKey ?? null])
    if (cookieKeys.has(key)) fail('invalid-state')
    cookieKeys.add(key)
    return {
      name: item.name, value: item.value, domain: item.domain, path: item.path, expires: item.expires,
      httpOnly: item.httpOnly, secure: item.secure, sameSite: item.sameSite,
      ...(item.partitionKey === undefined ? {} : { partitionKey: item.partitionKey }),
    }
  })
  const seenOrigins = new Set<string>()
  const origins = input.origins.map((value) => {
    const item = object(value, ['origin', 'localStorage'])
    if (typeof item.origin !== 'string' || !Array.isArray(item.localStorage)) fail('invalid-state')
    let origin: URL
    try { origin = new URL(item.origin) } catch { return fail('invalid-state') }
    if (origin.protocol !== 'https:' || !allowedHost(origin.hostname) || origin.username || origin.password
      || origin.port || origin.origin !== item.origin || origin.pathname !== '/' || origin.search || origin.hash
      || seenOrigins.has(item.origin)) fail('invalid-state')
    seenOrigins.add(item.origin)
    const names = new Set<string>()
    const localStorage = item.localStorage.map((value) => {
      const entry = object(value, ['name', 'value'])
      if (typeof entry.name !== 'string' || typeof entry.value !== 'string' || names.has(entry.name)) fail('invalid-state')
      names.add(entry.name)
      return { name: entry.name, value: entry.value }
    })
    return { origin: item.origin, localStorage }
  })
  const normalized = JSON.stringify({ cookies, origins })
  if (Buffer.byteLength(normalized, 'utf8') > BUCKLER_SESSION_SIZE_LIMIT) fail('size-limit')
  return normalized
}

// Constant scripts receive data only on stdin. No cookie, plaintext, file path or error is a command argument.
const POWERSHELL_PREAMBLE = `$ErrorActionPreference='Stop'; [Console]::InputEncoding=[Text.UTF8Encoding]::new($false); [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);`
const PROTECT_SCRIPT = `${POWERSHELL_PREAMBLE} try { Add-Type -AssemblyName System.Security; $inputValue=[Console]::In.ReadToEnd(); $bytes=[Text.Encoding]::UTF8.GetBytes($inputValue); $protected=[Security.Cryptography.ProtectedData]::Protect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($protected)); } catch { exit 1 }`
const UNPROTECT_SCRIPT = `${POWERSHELL_PREAMBLE} try { Add-Type -AssemblyName System.Security; $inputValue=[Console]::In.ReadToEnd(); $bytes=[Convert]::FromBase64String($inputValue); $plain=[Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Text.UTF8Encoding]::new($false,$true).GetString($plain)); } catch { exit 1 }`
const REPARSE_SCRIPT = `${POWERSHELL_PREAMBLE} try { $inputValue=[Console]::In.ReadToEnd(); $item=Get-Item -LiteralPath $inputValue -Force; [Console]::Out.Write([int][bool]($item.Attributes -band [IO.FileAttributes]::ReparsePoint)); } catch { exit 1 }`

function powershell(script: string, input: string, maxOutput: number, failureCode: BucklerSessionStoreErrorCode = 'crypto-failed'): Promise<string> {
  if (process.platform !== 'win32') return Promise.reject(new BucklerSessionStoreError('unsupported-platform'))
  return new Promise((resolveOutput, reject) => {
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    })
    const chunks: Buffer[] = []
    let size = 0
    let settled = false
    const finish = (failed: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (failed) reject(new BucklerSessionStoreError(failureCode))
      else resolveOutput(Buffer.concat(chunks).toString('utf8'))
    }
    const timer = setTimeout(() => { child.kill(); finish(true) }, 15_000)
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > maxOutput) { child.kill(); finish(true) } else chunks.push(chunk)
    })
    // Consume and discard stderr. Never include process messages or auth data in errors.
    child.stderr.on('data', () => {})
    child.on('error', () => finish(true))
    child.on('close', (code) => finish(code !== 0))
    child.stdin.on('error', () => finish(true))
    child.stdin.end(input, 'utf8')
  })
}

const defaultCrypto: BucklerSessionCrypto = {
  protect: (value) => powershell(PROTECT_SCRIPT, value, Math.ceil(BUCKLER_SESSION_SIZE_LIMIT / 3) * 4 + 65_536),
  unprotect: (value) => powershell(UNPROTECT_SCRIPT, value, BUCKLER_SESSION_SIZE_LIMIT),
}

const defaultIo: BucklerSessionStoreIo = {
  inspect: async (path) => {
    let stat
    try { stat = await lstat(path) } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null
      throw error
    }
    let reparsePoint = stat.isSymbolicLink()
    if (!reparsePoint) {
      const attributes = await powershell(REPARSE_SCRIPT, path, 8, 'io-failed')
      if (attributes !== '0' && attributes !== '1') fail('unsafe-path')
      reparsePoint = attributes === '1'
    }
    return { kind: stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other', symbolicLink: stat.isSymbolicLink(), reparsePoint, size: stat.size }
  },
  mkdir: (path, mode) => mkdir(path, { mode }).then(() => {}),
  readFile,
  writeFile: (path, data, options) => writeFile(path, data, options),
  rename,
  unlink,
}

function cipherBytes(value: string): Buffer {
  if (typeof value !== 'string' || !value || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) fail('crypto-failed')
  const bytes = Buffer.from(value, 'base64')
  if (bytes.toString('base64') !== value || bytes.length < 16) fail('crypto-failed')
  if (bytes.length > BUCKLER_SESSION_SIZE_LIMIT) fail('size-limit')
  return bytes
}

export function createBucklerSessionStore(options: BucklerSessionStoreOptions = {}): BucklerSessionStore {
  if (Object.keys(options).some((key) => !['io', 'crypto'].includes(key))) fail('unsafe-path')
  const io = options.io ?? defaultIo
  const crypto = options.crypto ?? defaultCrypto
  async function safeInfo(path: string): Promise<BucklerSessionFileInfo | null> {
    const info = await io.inspect(path)
    if (info?.symbolicLink || info?.reparsePoint || (info && info.kind === 'other')) fail('unsafe-path')
    return info
  }
  async function directories(create: boolean): Promise<boolean> {
    const ancestors: string[] = []
    for (let path = REPO_ROOT; ; path = dirname(path)) {
      ancestors.unshift(path)
      if (path === dirname(path)) break
    }
    for (const path of ancestors) {
      if ((await safeInfo(path))?.kind !== 'directory') fail('unsafe-path')
    }
    for (const path of [LOCAL_ROOT, SESSION_DIRECTORY]) {
      let info = await safeInfo(path)
      if (!info && create) { await io.mkdir(path, 0o700); info = await safeInfo(path) }
      if (!info) return false
      if (info.kind !== 'directory') fail('unsafe-path')
    }
    return true
  }
  async function readCiphertext(): Promise<Buffer> {
    if (!await directories(false)) fail('missing-session')
    const info = await safeInfo(BUCKLER_PRIVATE_SESSION_PATH)
    if (!info) fail('missing-session')
    if (info.kind !== 'file') fail('unsafe-path')
    if (!Number.isSafeInteger(info.size) || info.size > BUCKLER_SESSION_SIZE_LIMIT) fail('size-limit')
    if (info.size < 16) fail('crypto-failed')
    const bytes = Buffer.from(await io.readFile(BUCKLER_PRIVATE_SESSION_PATH))
    if (bytes.length !== info.size || bytes.length > BUCKLER_SESSION_SIZE_LIMIT) fail('crypto-failed')
    return bytes
  }
  return {
    async save(stateJson, intent, signal) {
      let temporary: string | null = null
      try {
        if (intent !== 'capture') fail('invalid-state')
        if (signal?.aborted) fail('cancelled')
        const normalized = validateBucklerSessionState(stateJson)
        let protectedValue: string
        try { protectedValue = await crypto.protect(normalized) } catch (error) { throw sanitized(error, 'crypto-failed') }
        if (signal?.aborted) fail('cancelled')
        const encrypted = cipherBytes(protectedValue)
        await directories(true)
        const previous = await safeInfo(BUCKLER_PRIVATE_SESSION_PATH)
        if (previous && previous.kind !== 'file') fail('unsafe-path')
        temporary = `${BUCKLER_PRIVATE_SESSION_PATH}.tmp-${randomUUID()}`
        if (signal?.aborted) fail('cancelled')
        await io.writeFile(temporary, encrypted, { flag: 'wx', mode: 0o600 })
        // Recheck directory and destination immediately before replacing this fixed file.
        if (!await directories(false)) fail('unsafe-path')
        const staged = await safeInfo(temporary)
        if (staged?.kind !== 'file' || staged.size !== encrypted.length) fail('unsafe-path')
        const destination = await safeInfo(BUCKLER_PRIVATE_SESSION_PATH)
        if (destination && destination.kind !== 'file') fail('unsafe-path')
        if (signal?.aborted) fail('cancelled')
        await io.rename(temporary, BUCKLER_PRIVATE_SESSION_PATH)
        temporary = null
      } catch (error) { throw sanitized(error, 'io-failed') } finally {
        if (temporary) { try { await io.unlink(temporary) } catch { /* Preserve fixed errors; leftovers contain ciphertext only. */ } }
      }
    },
    async load() {
      try {
        const bytes = await readCiphertext()
        let plainJson: string
        try { plainJson = await crypto.unprotect(bytes.toString('base64')) } catch (error) { throw sanitized(error, 'crypto-failed') }
        return validateBucklerSessionState(plainJson)
      } catch (error) { throw sanitized(error, 'io-failed') }
    },
    async identity() {
      try { return createHash('sha256').update(await readCiphertext()).digest('hex') }
      catch (error) { throw sanitized(error, 'io-failed') }
    },
    async checkCapturePath(path) {
      try {
        const stagingPrefix = `${BUCKLER_SESSION_CAPTURE_PATH}.tmp-`
        if (typeof path !== 'string' || (path !== BUCKLER_SESSION_CAPTURE_PATH
          && !(path.startsWith(stagingPrefix)
            && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(path.slice(stagingPrefix.length))))) fail('unsafe-path')
        if (!await directories(false)) fail('missing-session')
        const info = await safeInfo(path)
        if (info && info.kind !== 'file') fail('unsafe-path')
        if (info && (!Number.isSafeInteger(info.size) || info.size < 0 || info.size > 1024)) fail('size-limit')
      } catch (error) { throw sanitized(error, 'io-failed') }
    },
    async exists() {
      try {
        if (!await directories(false)) return false
        const info = await safeInfo(BUCKLER_PRIVATE_SESSION_PATH)
        if (info && info.kind !== 'file') fail('unsafe-path')
        return info !== null
      } catch (error) { throw sanitized(error, 'io-failed') }
    },
  }
}
