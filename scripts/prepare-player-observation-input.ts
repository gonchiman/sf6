import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parsePlayerObservationInput } from './lib/player-observation-collector.ts'

/** Assemble exported DOM page records without fetching Buckler or handling credentials. */
export async function preparePlayerObservationInput(directory: string, runId: string, scope: 'probe' | 'population' = 'probe') {
  if (!/^[a-z0-9][a-z0-9-]{0,95}$/.test(runId)) throw new Error('観測回IDは小文字の英数字とハイフンで96文字以内にしてください。')
  if (!['probe', 'population'].includes(scope)) throw new Error('取得範囲はprobeまたはpopulationです。')
  const inputDirectory = resolve(directory)
  const stat = await lstat(inputDirectory)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('取得記録のフォルダーを指定してください。')
  const entries = await readdir(inputDirectory, { withFileTypes: true })
  if (!entries.length || entries.some(entry => !entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith('.json'))) {
    throw new Error('取得記録のフォルダーにはページ記録JSONだけを配置してください。')
  }
  const captures: unknown[] = []
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const value: unknown = JSON.parse(await readFile(resolve(inputDirectory, entry.name), 'utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join(',') !== 'capture,schemaVersion'
      || !('schemaVersion' in value) || value.schemaVersion !== 1 || !('capture' in value)) {
      throw new Error('schemaVersion 1のページ取得記録が必要です。')
    }
    captures.push(value.capture)
  }
  const timestamps = captures.map(value => {
    if (!value || typeof value !== 'object' || !('capturedAt' in value) || typeof value.capturedAt !== 'string'
      || !Number.isFinite(Date.parse(value.capturedAt))) throw new Error('取得日時が不正です。')
    return value.capturedAt
  }).sort((a, b) => Date.parse(a) - Date.parse(b))
  const input = parsePlayerObservationInput({
    schemaVersion: 1, definitionVersion: 1, seriesId: 'buckler-max-lp-v1',
    run: { id: runId, scope, scheduledAt: timestamps[0], startedAt: timestamps[0], endedAt: timestamps.at(-1) },
    captures, failures: [],
  })
  return input
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [, , directory, runId, scope = 'probe'] = process.argv
    if (!directory || !runId) throw new Error('取得記録フォルダーと観測回IDを指定してください。')
    const input = await preparePlayerObservationInput(directory, runId, scope as 'probe' | 'population')
    const outputDirectory = fileURLToPath(new URL('../.local/player-observations/inbox/', import.meta.url))
    await mkdir(outputDirectory, { recursive: true })
    const output = resolve(outputDirectory, runId + '.json')
    await writeFile(output, JSON.stringify(input, null, 2) + '\n', { flag: 'wx' })
    console.log(output)
  } catch (error) {
    console.error(error instanceof Error ? error.message : '取得記録の準備に失敗しました。')
    process.exitCode = 1
  }
}
