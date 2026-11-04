import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const REPOSITORY = 'gonchiman/sf6'
const REPOSITORY_URL = `https://github.com/${REPOSITORY}.git`
const WORKFLOW = '.github/workflows/sample-survey.yml'
const OUTPUT_LIMIT = 64 * 1024
const COMMAND_TIMEOUT_MS = 120_000
export type SampleSurveySourceCode = 'environment' | 'source' | 'checkout' | 'ancestry' | 'workflow' | 'command'
export class SampleSurveySourceError extends Error {
  readonly code: SampleSurveySourceCode
  constructor(code: SampleSurveySourceCode) {
    super(`標本取得の固定コードを検証できませんでした (${code})。`)
    this.code = code
  }
}
const sha = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[a-f0-9]{40}$/.test(value)) throw new SampleSurveySourceError('source')
  return value
}

export function sampleSurveySourceSelection(env: Record<string, string | undefined>): { sourceSha: string; runSha: string } {
  if (env.GITHUB_ACTIONS !== 'true' || env.RUNNER_ENVIRONMENT !== 'github-hosted' || env.RUNNER_OS !== 'Windows'
    || env.GITHUB_REPOSITORY !== REPOSITORY || env.GITHUB_REF !== 'refs/heads/main'
    || env.GITHUB_EVENT_NAME !== 'workflow_dispatch'
    || env.GITHUB_WORKFLOW_REF !== `${REPOSITORY}/${WORKFLOW}@refs/heads/main`) throw new SampleSurveySourceError('environment')
  const runSha = sha(env.GITHUB_SHA)
  return { sourceSha: sha(env.SAMPLE_SURVEY_SOURCE_SHA || runSha), runSha }
}

/** Manual recovery is explicit; an old encrypted record never grants permission by itself. */
export function parseSampleSurveyRecovery(env: Record<string, string | undefined>): { recoverAuthentication: boolean; resumeSourceSha?: string } {
  const requested = env.SAMPLE_SURVEY_RECOVER_AUTHENTICATION || 'false'
  const previous = env.SAMPLE_SURVEY_RESUME_SOURCE_SHA || ''
  if (!['true', 'false'].includes(requested)) throw new SampleSurveySourceError('source')
  if (requested === 'false') {
    if (previous) throw new SampleSurveySourceError('source')
    return { recoverAuthentication: false }
  }
  if (!/^[1-9]\d{0,14}$/.test(env.SAMPLE_SURVEY_RESUME_RUN_ID || '')) throw new SampleSurveySourceError('source')
  return { recoverAuthentication: true, resumeSourceSha: sha(previous) }
}

export type SampleSurveySourceGit = (args: string[]) => Promise<string>

/** Public Git reads only. No shell, credentials, raw command errors, or unbounded output. */
const sourceGit: SampleSurveySourceGit = args => new Promise((resolveResult, reject) => {
  const env: Record<string, string | undefined> = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' }
  for (const key of Object.keys(env)) if (/token|secret|password|^BUCKLER_/i.test(key)) delete env[key]
  const child = spawn('git', ['-c', 'credential.helper=', '-c', 'core.askPass=', ...args], {
    shell: false, windowsHide: true, env, stdio: ['ignore', 'pipe', 'ignore'],
  })
  let settled = false, size = 0
  const chunks: Buffer[] = []
  const finish = (failed: boolean) => {
    if (settled) return
    settled = true; clearTimeout(timer)
    if (failed) { child.kill(); reject(new SampleSurveySourceError('command')) }
    else resolveResult(Buffer.concat(chunks).toString('utf8').trim())
  }
  const timer = setTimeout(() => finish(true), COMMAND_TIMEOUT_MS)
  timer.unref()
  child.on('error', () => finish(true))
  child.on('close', code => finish(code !== 0))
  child.stdout.on('data', (chunk: Buffer) => {
    size += chunk.length
    if (size > OUTPUT_LIMIT) finish(true)
    else chunks.push(chunk)
  })
})

/** Run from the pinned checkout before any Buckler secret or history-write token is supplied. */
export async function verifySampleSurveySource(options: {
  env?: Record<string, string | undefined>; git?: SampleSurveySourceGit
} = {}): Promise<{ sourceSha: string; runSha: string }> {
  const env = options.env ?? process.env
  const selected = sampleSurveySourceSelection(env), recovery = parseSampleSurveyRecovery(env), git = options.git ?? sourceGit
  const command = async (args: string[], code: SampleSurveySourceCode): Promise<string> => {
    try { return (await git(args)).trim() } catch { throw new SampleSurveySourceError(code) }
  }
  if (await command(['rev-parse', '--verify', 'HEAD'], 'checkout') !== selected.sourceSha) throw new SampleSurveySourceError('checkout')
  // Git object IDs avoid Windows checkout newline conversion affecting the comparison.
  const sourceBlob = sha(await command(['rev-parse', '--verify', `${selected.sourceSha}:${WORKFLOW}`], 'workflow'))
  if (recovery.resumeSourceSha && recovery.resumeSourceSha !== selected.sourceSha) {
    // Migration changes code, not sample identity. Both revisions must belong to main's history.
    await command(['fetch', '--no-tags', '--filter=blob:none', '--depth=1000', REPOSITORY_URL, selected.sourceSha], 'ancestry')
    await command(['merge-base', '--is-ancestor', recovery.resumeSourceSha, selected.sourceSha], 'ancestry')
  }
  if (selected.sourceSha === selected.runSha) return selected
  let runPresent = false
  try { runPresent = await git(['cat-file', '-t', selected.runSha]) === 'commit' } catch { /* Fetch only missing execution history. */ }
  if (!runPresent) await command(['fetch', '--no-tags', '--filter=blob:none', '--depth=1000', REPOSITORY_URL, selected.runSha], 'ancestry')
  // A missing/deeper-than-budget ancestor fails closed; never use an arbitrary unrelated commit.
  await command(['merge-base', '--is-ancestor', selected.sourceSha, selected.runSha], 'ancestry')
  const runBlob = sha(await command(['rev-parse', '--verify', `${selected.runSha}:${WORKFLOW}`], 'workflow'))
  if (sourceBlob !== runBlob) throw new SampleSurveySourceError('workflow')
  return selected
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.slice(2).length) { console.error(new SampleSurveySourceError('source').message); process.exitCode = 1 }
  else verifySampleSurveySource().then(value => console.log(JSON.stringify({ sampleSurveySource: value }))).catch(error => {
    console.error(error instanceof SampleSurveySourceError ? error.message : new SampleSurveySourceError('command').message)
    process.exitCode = 1
  })
}
