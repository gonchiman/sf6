import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { normalizeUsageRateSnapshots } from './lib/usage-rate-snapshot.ts'

/** The raw acquisition bundle stays separate from public files until its full coverage is verified. */
export async function normalizeUsageRateSnapshotFile(input: string | string[], output: string, generatedAt = new Date().toISOString()) {
  const characterPath = fileURLToPath(new URL('../public/data/characters/index.json', import.meta.url))
  const inputs = typeof input === 'string' ? [input] : input
  if (inputs.length === 0) throw new Error('入力スナップショットJSONを指定してください。')
  const [raws, characters] = await Promise.all([Promise.all(inputs.map((path) => readFile(resolve(path), 'utf8'))), readFile(characterPath, 'utf8')])
  const parsed = raws.map((raw): Record<string, unknown> => {
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== 'object' || Array.isArray(value) || !('schemaVersion' in value) || value.schemaVersion !== 1
      || !('kind' in value) || value.kind !== 'buckler-usage-rate-snapshots'
      || !('editions' in value) || !Array.isArray(value.editions) || !('snapshots' in value) || !Array.isArray(value.snapshots)) {
      throw new Error('使用率の入力スナップショットbundleが不正です。')
    }
    return value as Record<string, unknown>
  })
  const merged = { schemaVersion: 1, kind: 'buckler-usage-rate-snapshots',
    editions: parsed.flatMap((item) => item.editions as unknown[]), snapshots: parsed.flatMap((item) => item.snapshots as unknown[]) }
  const bundle = normalizeUsageRateSnapshots(merged, JSON.parse(characters), generatedAt)
  await writeFile(resolve(output), `${JSON.stringify(bundle, null, 2)}\n`, { flag: 'wx' })
  return {
    datasets: bundle.datasets.length,
    distributions: bundle.datasets.reduce((sum, item) => sum + item.distributions.length, 0),
    entries: bundle.datasets.reduce((sum, item) => sum + item.distributions.reduce((count, item) => count + item.entries.length, 0), 0),
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2)
    if (args.length === 1 && args[0] === '--help') {
      console.log('node scripts/normalize-usage-rate-snapshots.ts <input.json> [input-master.json ...] <new-output.json>\n総合版・マスター版のraw JSONをまとめて検証・正規化します。出力先には新しいファイルを指定してください。')
      process.exit(0)
    }
    if (args.length < 2) throw new Error('入力スナップショットJSON（複数可）と出力bundleのパスを指定してください。')
    const result = await normalizeUsageRateSnapshotFile(args.slice(0, -1), args.at(-1)!)
    console.log(`使用率正規化完了: ${result.datasets}データセット / ${result.distributions}分布 / ${result.entries}項目`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
