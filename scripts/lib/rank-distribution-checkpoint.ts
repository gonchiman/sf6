import { randomUUID } from 'node:crypto'
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { RANK_BOUNDARY_SOURCE_URL } from './rank-distribution-boundaries.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const LOCAL = resolve(ROOT, '.local')
const DIRECTORY = resolve(LOCAL, 'rank-distribution')
export const RANK_DISTRIBUTION_CHECKPOINT_PATH = resolve(DIRECTORY, 'checkpoint.json')
export const RANK_DISTRIBUTION_CHECKPOINT_SIZE_LIMIT = 1024 * 1024
const LOCK_PATH = `${RANK_DISTRIBUTION_CHECKPOINT_PATH}.lock`

/** A previous position guides a new search; it is never proof of a current boundary. */
export interface RankDistributionCheckpointHint {
  rankId: number
  countAtOrAbove: number
  totalCount: number
  observedAt: string
}

export interface RankDistributionCheckpoint {
  schemaVersion: 1
  method: 'boundary-search-estimate'
  sourceUrl: typeof RANK_BOUNDARY_SOURCE_URL
  pageSize: number
  savedAt: string
  hints: RankDistributionCheckpointHint[]
}

export type RankDistributionCheckpointErrorCode = 'invalid-checkpoint' | 'unsafe-path' | 'size-limit'
  | 'future-checkpoint' | 'locked' | 'io-failed'

const MESSAGES: Record<RankDistributionCheckpointErrorCode, string> = {
  'invalid-checkpoint': 'ランク分布の途中保存の形式を確認できませんでした。',
  'unsafe-path': 'ランク分布の途中保存先を安全に確認できませんでした。',
  'size-limit': 'ランク分布の途中保存がサイズ上限を超えています。',
  'future-checkpoint': 'ランク分布の途中保存の日時が現在より後になっています。',
  locked: 'ランク分布の途中保存は別の処理が更新中です。',
  'io-failed': 'ランク分布の途中保存を読み書きできませんでした。',
}

/** Fixed messages only; filesystem paths, raw errors and private values are never included. */
export class RankDistributionCheckpointError extends Error {
  readonly code: RankDistributionCheckpointErrorCode
  constructor(code: RankDistributionCheckpointErrorCode) {
    super(MESSAGES[code])
    this.name = 'RankDistributionCheckpointError'
    this.code = code
  }
}

function fail(code: RankDistributionCheckpointErrorCode): never { throw new RankDistributionCheckpointError(code) }
function safeError(error: unknown): RankDistributionCheckpointError {
  return new RankDistributionCheckpointError(error instanceof RankDistributionCheckpointError
    && Object.hasOwn(MESSAGES, error.code) ? error.code : 'io-failed')
}
function hasCode(error: unknown, code: string): boolean {
  return error !== null && typeof error === 'object' && 'code' in error && error.code === code
}
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !keys.includes(key))) fail('invalid-checkpoint')
  return value as Record<string, unknown>
}
function integer(value: unknown, minimum = 0): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum
}
function timestamp(value: unknown): string {
  if (typeof value !== 'string') fail('invalid-checkpoint')
  const match = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.\d{1,3})?Z$/.exec(value)
  if (!match || !Number.isFinite(Date.parse(value))) fail('invalid-checkpoint')
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3])
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1]) fail('invalid-checkpoint')
  return value
}

/** A checkpoint can be partial and span runs; each hint still needs a fresh confirmation. */
export function parseRankDistributionCheckpoint(value: unknown): RankDistributionCheckpoint {
  try {
    const input = record(value, ['schemaVersion', 'method', 'sourceUrl', 'pageSize', 'savedAt', 'hints'])
    if (input.schemaVersion !== 1 || input.method !== 'boundary-search-estimate'
      || input.sourceUrl !== RANK_BOUNDARY_SOURCE_URL || !integer(input.pageSize, 1) || input.pageSize > 20
      || !Array.isArray(input.hints) || input.hints.length > 35) fail('invalid-checkpoint')
    const savedAt = timestamp(input.savedAt)
    const hints: RankDistributionCheckpointHint[] = input.hints.map(value => {
      const hint = record(value, ['rankId', 'countAtOrAbove', 'totalCount', 'observedAt'])
      if (!integer(hint.rankId, 2) || hint.rankId > 36 || !integer(hint.countAtOrAbove)
        || !integer(hint.totalCount) || hint.countAtOrAbove > hint.totalCount) fail('invalid-checkpoint')
      const observedAt = timestamp(hint.observedAt)
      if (Date.parse(observedAt) > Date.parse(savedAt)) fail('invalid-checkpoint')
      return { rankId: hint.rankId, countAtOrAbove: hint.countAtOrAbove, totalCount: hint.totalCount, observedAt }
    })
    if (new Set(hints.map(hint => hint.rankId)).size !== hints.length) fail('invalid-checkpoint')
    const result: RankDistributionCheckpoint = {
      schemaVersion: 1, method: 'boundary-search-estimate', sourceUrl: RANK_BOUNDARY_SOURCE_URL,
      pageSize: input.pageSize, savedAt, hints,
    }
    if (Buffer.byteLength(JSON.stringify(result), 'utf8') > RANK_DISTRIBUTION_CHECKPOINT_SIZE_LIMIT) fail('size-limit')
    return result
  } catch (error) {
    if (error instanceof RankDistributionCheckpointError) throw error
    return fail('invalid-checkpoint')
  }
}

/** Retain every rank's newest hint, including ranks not reached in a later failed run. */
export function mergeRankDistributionCheckpoints(previous: RankDistributionCheckpoint | null, incoming: RankDistributionCheckpoint): RankDistributionCheckpoint {
  const next = parseRankDistributionCheckpoint(incoming)
  if (!previous) return next
  const old = parseRankDistributionCheckpoint(previous)
  if (old.pageSize !== next.pageSize) fail('invalid-checkpoint')
  const hints = new Map(old.hints.map(hint => [hint.rankId, hint]))
  for (const hint of next.hints) {
    const current = hints.get(hint.rankId)
    const delta = current ? Date.parse(hint.observedAt) - Date.parse(current.observedAt) : 1
    if (current && delta === 0 && (current.countAtOrAbove !== hint.countAtOrAbove || current.totalCount !== hint.totalCount)) {
      fail('invalid-checkpoint')
    }
    if (!current || delta > 0) hints.set(hint.rankId, hint)
  }
  return parseRankDistributionCheckpoint({ ...next,
    savedAt: Date.parse(old.savedAt) > Date.parse(next.savedAt) ? old.savedAt : next.savedAt,
    hints: [...hints.values()].sort((a, b) => a.rankId - b.rankId),
  })
}

export interface RankDistributionCheckpointFileInfo {
  kind: 'directory' | 'file' | 'other'
  symbolicLink: boolean
  reparsePoint?: boolean
  size: number
}
/** All paths are fixed by this module. Tests inject virtual IO without touching actual records. */
export interface RankDistributionCheckpointIo {
  inspect(path: string): Promise<RankDistributionCheckpointFileInfo | null>
  mkdir(path: string, mode: number): Promise<void>
  readBounded(path: string, maximumBytes: number): Promise<Uint8Array>
  writeFile(path: string, bytes: Uint8Array, options: { flag: 'wx'; mode: number }): Promise<void>
  rename(from: string, to: string): Promise<void>
  unlink(path: string): Promise<void>
}
export interface RankDistributionCheckpointStoreOptions {
  io?: RankDistributionCheckpointIo
  now?: () => Date
  randomId?: () => string
}
export interface RankDistributionCheckpointStore {
  load(): Promise<RankDistributionCheckpoint | null>
  save(value: unknown): Promise<RankDistributionCheckpoint>
}

const defaultIo: RankDistributionCheckpointIo = {
  async inspect(path) {
    try {
      const info = await lstat(path)
      return { kind: info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other',
        symbolicLink: info.isSymbolicLink(), size: info.size }
    } catch (error) { if (hasCode(error, 'ENOENT')) return null; throw error }
  },
  async mkdir(path, mode) { await mkdir(path, { mode }) },
  async readBounded(path, maximumBytes) {
    const handle = await open(path, 'r')
    try {
      const info = await handle.stat()
      if (!info.isFile()) fail('unsafe-path')
      if (!integer(info.size) || info.size > maximumBytes) fail('size-limit')
      const bytes = Buffer.alloc(maximumBytes + 1)
      let length = 0
      while (length < bytes.length) {
        const result = await handle.read(bytes, length, bytes.length - length, null)
        if (result.bytesRead === 0) break
        length += result.bytesRead
      }
      if (length > maximumBytes) fail('size-limit')
      return bytes.subarray(0, length)
    } finally { await handle.close() }
  },
  async writeFile(path, bytes, options) {
    const handle = await open(path, options.flag, options.mode)
    try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
  },
  async rename(from, to) {
    for (let attempt = 0; ; attempt++) {
      try { await rename(from, to); return } catch (error) {
        if (attempt >= 3 || !(hasCode(error, 'EPERM') || hasCode(error, 'EBUSY'))) throw error
        await delay(40 * 2 ** attempt)
      }
    }
  },
  unlink,
}

export function createRankDistributionCheckpointStore(options: RankDistributionCheckpointStoreOptions = {}): RankDistributionCheckpointStore {
  if (!options || typeof options !== 'object' || Array.isArray(options)
    || Object.keys(options).some(key => !['io', 'now', 'randomId'].includes(key))
    || options.now !== undefined && typeof options.now !== 'function'
    || options.randomId !== undefined && typeof options.randomId !== 'function') fail('invalid-checkpoint')
  const io = options.io ?? defaultIo
  const now = options.now ?? (() => new Date())
  const randomId = options.randomId ?? randomUUID
  function notFuture(value: RankDistributionCheckpoint): void {
    let current: number
    try { current = Date.prototype.getTime.call(now()) } catch { return fail('invalid-checkpoint') }
    if (!Number.isFinite(current)) fail('invalid-checkpoint')
    if (Date.parse(value.savedAt) > current) fail('future-checkpoint')
  }
  async function safeInfo(path: string): Promise<RankDistributionCheckpointFileInfo | null> {
    const info = await io.inspect(path)
    if (info && (info.symbolicLink || info.reparsePoint || info.kind === 'other')) fail('unsafe-path')
    return info
  }
  async function directories(create: boolean): Promise<boolean> {
    const ancestors: string[] = []
    for (let path = ROOT; ; path = dirname(path)) {
      ancestors.unshift(path)
      if (path === dirname(path)) break
    }
    for (const path of ancestors) if ((await safeInfo(path))?.kind !== 'directory') fail('unsafe-path')
    for (const path of [LOCAL, DIRECTORY]) {
      let info = await safeInfo(path)
      if (!info && create) { await io.mkdir(path, 0o700); info = await safeInfo(path) }
      if (!info) return false
      if (info.kind !== 'directory') fail('unsafe-path')
    }
    return true
  }
  async function readCurrent(): Promise<RankDistributionCheckpoint | null> {
    if (!await directories(false)) return null
    const info = await safeInfo(RANK_DISTRIBUTION_CHECKPOINT_PATH)
    if (!info) return null
    if (info.kind !== 'file') fail('unsafe-path')
    if (!integer(info.size) || info.size > RANK_DISTRIBUTION_CHECKPOINT_SIZE_LIMIT) fail('size-limit')
    if (info.size === 0) fail('invalid-checkpoint')
    const bytes = Buffer.from(await io.readBounded(RANK_DISTRIBUTION_CHECKPOINT_PATH, RANK_DISTRIBUTION_CHECKPOINT_SIZE_LIMIT))
    if (bytes.length > RANK_DISTRIBUTION_CHECKPOINT_SIZE_LIMIT) fail('size-limit')
    if (bytes.length !== info.size) fail('invalid-checkpoint')
    if (!await directories(false)) fail('unsafe-path')
    const after = await safeInfo(RANK_DISTRIBUTION_CHECKPOINT_PATH)
    if (after?.kind !== 'file' || after.size !== info.size) fail('unsafe-path')
    let value: unknown
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch { return fail('invalid-checkpoint') }
    const result = parseRankDistributionCheckpoint(value)
    notFuture(result)
    return result
  }
  return {
    async load() {
      try { return await readCurrent() } catch (error) { throw safeError(error) }
    },
    async save(value) {
      let ownsLock = false
      let temporary: string | null = null
      let ownsTemporary = false
      try {
        const incoming = parseRankDistributionCheckpoint(value)
        notFuture(incoming)
        await directories(true)
        const lockInfo = await safeInfo(LOCK_PATH)
        if (lockInfo) {
          if (lockInfo.kind !== 'file') fail('unsafe-path')
          fail('locked')
        }
        try { await io.writeFile(LOCK_PATH, new Uint8Array(), { flag: 'wx', mode: 0o600 }); ownsLock = true }
        catch (error) { if (hasCode(error, 'EEXIST')) fail('locked'); throw error }
        const previous = await readCurrent()
        const next = mergeRankDistributionCheckpoints(previous, incoming)
        notFuture(next)
        const nonce = randomId()
        if (typeof nonce !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(nonce)) fail('unsafe-path')
        temporary = `${RANK_DISTRIBUTION_CHECKPOINT_PATH}.tmp-${nonce}`
        if (await safeInfo(temporary)) fail('unsafe-path')
        const bytes = Buffer.from(`${JSON.stringify(next, null, 2)}\n`, 'utf8')
        if (bytes.length > RANK_DISTRIBUTION_CHECKPOINT_SIZE_LIMIT) fail('size-limit')
        await io.writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 })
        ownsTemporary = true
        if (!await directories(false)) fail('unsafe-path')
        const staged = await safeInfo(temporary)
        if (staged?.kind !== 'file' || staged.size !== bytes.length) fail('unsafe-path')
        const current = await readCurrent()
        if (JSON.stringify(current) !== JSON.stringify(previous)) fail('io-failed')
        await io.rename(temporary, RANK_DISTRIBUTION_CHECKPOINT_PATH)
        ownsTemporary = false
        return next
      } catch (error) { throw safeError(error) } finally {
        // Never follow a parent link introduced after staging, including during cleanup.
        let cleanupSafe = false
        try { cleanupSafe = await directories(false) } catch { /* Keep fixed errors and leave owned files in place. */ }
        if (cleanupSafe && temporary && ownsTemporary) { try { await io.unlink(temporary) } catch { /* Preserve the original fixed error. */ } }
        if (cleanupSafe && ownsLock) { try { await io.unlink(LOCK_PATH) } catch { /* A stale lock refuses a later concurrent write. */ } }
      }
    },
  }
}
