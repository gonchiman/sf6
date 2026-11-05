import { appendFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { STEAM_COLLECTION_VERSION } from '../../src/lib/steamCollectionVersion.ts'

export { STEAM_COLLECTION_VERSION } from '../../src/lib/steamCollectionVersion.ts'
export type SteamCollectionComponent = 'dispatcher' | 'collector' | 'publisher'
type Environment = Record<string, string | undefined>
const labels: Record<SteamCollectionComponent, string> = {
  dispatcher: '起動役', collector: '取得', publisher: '履歴保存',
}

export function steamCollectionVersion(component: SteamCollectionComponent, env: Environment = process.env) {
  if (!Object.hasOwn(labels, component)) throw new Error('Steam取得処理の種類が不正です。')
  // A local checkout may be dirty. Do not label it with an inherited Actions SHA.
  const codeSha = env.GITHUB_ACTIONS === 'true' && env.GITHUB_SHA?.length === 40 && /^[0-9a-f]{40}$/.test(env.GITHUB_SHA)
    ? env.GITHUB_SHA! : null
  return { component, processVersion: STEAM_COLLECTION_VERSION, codeSha }
}

/** Report the code checked out for this job before tests or external requests begin. */
export async function reportSteamCollectionVersion(component: SteamCollectionComponent, options: {
  env?: Environment; write?: (message: string) => void
} = {}): Promise<void> {
  const env = options.env ?? process.env, identity = steamCollectionVersion(component, env)
  const write = options.write ?? console.log
  write(JSON.stringify({ event: 'steam-collection-version', ...identity }))
  if (env.GITHUB_ACTIONS === 'true' && env.GITHUB_STEP_SUMMARY) {
    const code = identity.codeSha ? `\`${identity.codeSha}\`` : '未確認'
    await appendFile(env.GITHUB_STEP_SUMMARY,
      `\n### Steam取得処理\n\n| 処理 | 版 | コード |\n| --- | --- | --- |\n| ${labels[component]} | ${identity.processVersion} | ${code} |\n`)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2)
  if (args.length === 1 && args[0] === '--version') console.log(STEAM_COLLECTION_VERSION)
  else if (args.length === 1 && Object.hasOwn(labels, args[0])) {
    reportSteamCollectionVersion(args[0] as SteamCollectionComponent).catch(() => {
      console.error('Steam取得処理の版を記録できませんでした。'); process.exitCode = 1
    })
  } else {
    console.error('指定: --version または dispatcher / collector / publisher'); process.exitCode = 1
  }
}
