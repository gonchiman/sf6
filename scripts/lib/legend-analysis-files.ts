import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'

export const LEGEND_ANALYSIS_JSON_LIMIT = 1024 * 1024

export function legendAnalysisPathWithin(directory: string, path: string): boolean {
  const value = relative(resolve(directory), resolve(path))
  return value !== '' && !isAbsolute(value) && value !== '..' && !value.startsWith(`..${sep}`)
}

export async function legendAnalysisFileInfo(path: string) {
  try { return await lstat(path) } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null
    throw new Error('レジェンド分析のファイルを確認できません。')
  }
}

/** Follow the existing weekly-history pattern: reject links and special parents before IO. */
export async function checkLegendAnalysisParents(path: string): Promise<void> {
  for (let current = resolve(path); ; current = dirname(current)) {
    const value = await legendAnalysisFileInfo(current)
    if (value && (!value.isDirectory() || value.isSymbolicLink())) throw new Error('レジェンド分析の保存先が不正です。')
    if (current === dirname(current)) return
  }
}

/** Bounded UTF-8 JSON, with identity checks before and after reading; no links or hard links. */
export async function readLegendAnalysisJson(path: string): Promise<unknown> {
  await checkLegendAnalysisParents(dirname(path))
  const before = await legendAnalysisFileInfo(path)
  if (!before?.isFile() || before.isSymbolicLink() || before.nlink > 1 || before.size < 1
    || before.size > LEGEND_ANALYSIS_JSON_LIMIT) throw new Error('レジェンド分析JSONの形式またはサイズが不正です。')
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const opened = await handle.stat()
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size || opened.nlink > 1) throw new Error()
    const bytes = Buffer.alloc(before.size + 1)
    let length = 0
    while (length < bytes.length) {
      const part = await handle.read(bytes, length, bytes.length - length, null)
      if (!part.bytesRead) break
      length += part.bytesRead
    }
    const after = await handle.stat()
    await checkLegendAnalysisParents(dirname(path))
    const linked = await legendAnalysisFileInfo(path)
    if (length !== before.size || after.size !== before.size || after.nlink > 1 || !linked?.isFile()
      || linked.isSymbolicLink() || linked.dev !== before.dev || linked.ino !== before.ino || linked.size !== before.size) throw new Error()
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)))
  } catch { throw new Error('レジェンド分析JSONを安全に読み取れません。') }
  finally { await handle.close() }
}
