import { execFile } from 'node:child_process'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isAllowedSteamWorkflow } from './collect-steam-player-count.ts'
import { publishSteamPlayerCount, seedSteamPlayerCountHistory } from './publish-steam-player-count.ts'
import { checkSteamParents, steamPathWithin } from './lib/steam-player-count-files.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const STEAM_HISTORY_BRANCH = 'codex/steam-player-count-history'
export const STEAM_HISTORY_REMOTE = 'https://github.com/gonchiman/sf6.git'
type Environment = Record<string, string | undefined>
type GitResult = { code: number; stdout: string }
type Git = (args: string[], directory: string, env: Environment) => Promise<GitResult>

const runGit: Git = (args, cwd, env) => new Promise(resolveResult => {
  execFile('git', args, { cwd, env, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
    resolveResult({ code: error ? typeof error.code === 'number' ? error.code : 1 : 0, stdout: stdout ?? '' })
  })
})

/** The only network writer: fixed workflow, fixed remote/branch, fresh isolated checkout.
 * On a rejected push, replay the retained input onto the latest remote history instead
 * of rebasing generated JSON or overwriting the concurrent publisher's observations.
 */
export async function publishSteamPlayerCountHistory(options: {
  env?: Environment
  root?: string
  git?: Git
  publish?: typeof publishSteamPlayerCount
  seed?: typeof seedSteamPlayerCountHistory
} = {}): Promise<void> {
  const env = options.env ?? process.env
  if (!isAllowedSteamWorkflow(env) || !env.GH_TOKEN) throw new Error('固定mainのSteam履歴公開workflowが必要です。')
  const root = resolve(options.root ?? ROOT), workRoot = resolve(root, '.local/steam-player-count')
  if (!steamPathWithin(root, workRoot)) throw new Error('履歴公開の作業先が不正です。')
  await checkSteamParents(workRoot)
  await mkdir(workRoot, { recursive: true })
  const history = await mkdtemp(resolve(workRoot, 'history-'))
  const input = resolve(workRoot, 'incoming/observation.json')
  const git = options.git ?? runGit
  const gitEnv = { ...env }
  delete gitEnv.GH_TOKEN
  // A caller's inherited git options must not redirect the isolated repository.
  for (const name of Object.keys(gitEnv)) if (name.startsWith('GIT_')) delete gitEnv[name]
  const command = async (args: string[], environment = gitEnv) => {
    const result = await git(args, history, environment)
    if (result.code !== 0) throw new Error('Steam履歴のGit操作を完了できませんでした。')
    return result.stdout.trim()
  }
  await command(['init', `--initial-branch=${STEAM_HISTORY_BRANCH}`])
  await command(['remote', 'add', 'origin', STEAM_HISTORY_REMOTE])
  await command(['config', 'user.name', 'github-actions[bot]'])
  await command(['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com'])
  for (let attempt = 0; attempt < 3; attempt++) {
    await checkSteamParents(history)
    if (!steamPathWithin(workRoot, history)
      || resolve(await command(['rev-parse', '--show-toplevel'])) !== history
      || await command(['symbolic-ref', '--short', 'HEAD']) !== STEAM_HISTORY_BRANCH
      || await command(['remote', 'get-url', 'origin']) !== STEAM_HISTORY_REMOTE) throw new Error('履歴公開先が一致しません。')
    const existing = await command(['ls-remote', '--heads', 'origin', `refs/heads/${STEAM_HISTORY_BRANCH}`])
    if (existing) {
      if (!new RegExp(`^[0-9a-f]{40}\\s+refs/heads/${STEAM_HISTORY_BRANCH}$`).test(existing)) throw new Error('履歴ブランチを確認できません。')
      await command(['fetch', '--depth=1', 'origin', `refs/heads/${STEAM_HISTORY_BRANCH}`])
      // Only this freshly initialized and checked checkout is reset. The input artifact is outside it.
      await command(['reset', '--hard', 'FETCH_HEAD'])
    } else if (attempt === 0) {
      await (options.seed ?? seedSteamPlayerCountHistory)(resolve(root, 'public/data/steam-player-count'), resolve(history, 'public'))
    }
    await (options.publish ?? publishSteamPlayerCount)(input, resolve(history, 'public'))
    await command(['add', '--', 'public'])
    const diff = await git(['diff', '--cached', '--quiet'], history, gitEnv)
    if (diff.code !== 0 && diff.code !== 1) throw new Error('Steam履歴の差分を確認できません。')
    if (diff.code === 1) await command(['commit', '-m', 'Save Steam player count observation'])
    // An earlier push may have reached the remote despite a lost acknowledgement.
    if (diff.code === 0 && existing) return
    const credential = Buffer.from(`x-access-token:${env.GH_TOKEN}`).toString('base64')
    const pushEnv: Environment = { ...gitEnv, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader', GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${credential}` }
    const push = await git(['push', 'origin', `HEAD:refs/heads/${STEAM_HISTORY_BRANCH}`], history, pushEnv)
    delete pushEnv.GIT_CONFIG_VALUE_0
    if (push.code === 0) return
  }
  throw new Error('Steam履歴を公開できませんでした。検証済みartifactを保持して公開jobを再実行してください。')
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.slice(2).length) { console.error('引数は指定できません。'); process.exitCode = 1 }
  else publishSteamPlayerCountHistory().then(() => console.log('Steam同時接続数の履歴を保存しました。')).catch(() => {
    console.error('Steam履歴を公開できませんでした。検証済みartifactを保持して公開jobを再実行してください。')
    process.exitCode = 1
  })
}
