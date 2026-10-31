import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'
import { createHash } from 'node:crypto'

export const STEAM_JSON_LIMIT = 4 * 1024 * 1024

export function steamPathWithin(parent: string, path: string): boolean {
  const part = relative(resolve(parent), resolve(path))
  return !!part && part !== '..' && !part.startsWith(`..${sep}`) && !part.startsWith(sep) && !/^[A-Za-z]:/.test(part)
}

export async function steamFileInfo(path: string) {
  try { return await lstat(path) }
  catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null
    throw new Error('Steam履歴のファイルを確認できません。')
  }
}

/** Refuse symlinks/junctions anywhere on a path used for reading or writing. */
export async function checkSteamParents(path: string): Promise<void> {
  let current = resolve(path)
  for (;;) {
    const info = await steamFileInfo(current)
    if (info && (!info.isDirectory() || info.isSymbolicLink())) throw new Error('Steam履歴の保存先が不正です。')
    const parent = dirname(current)
    if (parent === current) return
    current = parent
  }
}

export async function readSteamBytes(path: string): Promise<Buffer> {
  await checkSteamParents(dirname(path))
  const before = await steamFileInfo(path)
  if (!before || before.isSymbolicLink() || !before.isFile() || before.size < 1 || before.size > STEAM_JSON_LIMIT) {
    throw new Error('Steam履歴のファイル形式またはサイズが不正です。')
  }
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const after = await file.stat()
    if (!after.isFile() || after.size !== before.size || after.ino !== before.ino || after.dev !== before.dev) {
      throw new Error('Steam履歴のファイルが変更されました。')
    }
    const bytes = await file.readFile()
    if (bytes.length !== before.size) throw new Error('Steam履歴のサイズが一致しません。')
    return bytes
  } finally { await file.close() }
}

export function parseSteamJson(bytes: Uint8Array): unknown {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) }
  catch { throw new Error('Steam履歴のJSONが不正です。') }
}

export function steamJson(value: unknown): string {
  const text = `${JSON.stringify(value, null, 2)}\n`
  if (Buffer.byteLength(text) > STEAM_JSON_LIMIT) throw new Error('Steam履歴のサイズが上限を超えています。')
  return text
}

export const steamSha256 = (bytes: string | Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
