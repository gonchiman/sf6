import { lstat, mkdir, open } from 'node:fs/promises'
import { dirname, parse, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseSampleSurveyCloudConfig } from './collect-sample-survey-cloud.ts'
import { createProductionGitHub, fetchSampleSurveyCheckpointArtifact } from './manage-sample-survey-production.ts'
import type { CloudGhCommand } from './lib/parallel-fetch-github.ts'
import { sampleSurveySourceSelection, parseSampleSurveyRecovery } from './lib/sample-survey-production-source.ts'
import type { SampleSurveyCheckpointManifest } from './lib/sample-survey-cloud-checkpoint.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const SAMPLE_SURVEY_CHECKPOINT_INPUT = resolve(ROOT, '.local/sample-survey-cloud/checkpoint-input')
const fail = (): never => { throw new Error('標本調査の途中記録を取得・確認できません。') }

async function writeBundle(directory: string, files: Map<string, Buffer>): Promise<void> {
  const absolute = resolve(directory), root = parse(absolute).root
  let current = root
  for (const part of absolute.slice(root.length).split(sep).filter(Boolean)) {
    current = resolve(current, part)
    const stat = await lstat(current).catch(error => { if (error.code === 'ENOENT') return null; throw error })
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) return fail()
    if (!stat) await mkdir(current)
  }
  for (const name of ['checkpoint.enc.json', 'manifest.json']) {
    const bytes = files.get(name)
    if (!bytes) return fail()
    // A fresh runner must not silently overwrite another acquisition's input.
    const handle = await open(resolve(absolute, name), 'wx', 0o600)
    try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
  }
}

export async function prepareSampleSurveyCheckpoint(options: {
  env?: Record<string, string | undefined>; command?: CloudGhCommand; now?: () => number
  metadataWait?: (ms: number) => Promise<void>
  write?: (directory: string, files: Map<string, Buffer>) => Promise<void>
} = {}): Promise<SampleSurveyCheckpointManifest | null> {
  try {
    const env = options.env ?? process.env, resumeRunId = env.SAMPLE_SURVEY_RESUME_RUN_ID?.trim()
    const source = sampleSurveySourceSelection(env)
    const recovery = parseSampleSurveyRecovery(env)
    if (env.GITHUB_RUN_ATTEMPT !== '1') return fail()
    if (!resumeRunId) return null
    if (!/^[1-9]\d{0,14}$/.test(resumeRunId) || resumeRunId === env.GITHUB_RUN_ID) return fail()
    const config = parseSampleSurveyCloudConfig(env), github = createProductionGitHub(options.command, options.metadataWait)
    const previousSource = recovery.resumeSourceSha ?? source.sourceSha
    const run = await github.run(resumeRunId, previousSource, true)
    const bundle = await fetchSampleSurveyCheckpointArtifact({ run, sourceSha: previousSource, config }, options.command)
    const now = (options.now ?? Date.now)(), saved = bundle.manifest
    const permitted = recovery.recoverAuthentication
      ? saved.stopReason === 'authentication-unconfirmed' && saved.state === 'error' && !config.includeMr && config.ranks.length > 0
      : saved.resumeAllowed && ['server-error', 'timeout', 'limit-reached', 'interrupted', 'cancelled'].includes(saved.stopReason ?? '')
    if (!permitted || !['stopped', 'error'].includes(saved.state) || saved.resumeDepth >= 6
      || Date.parse(saved.startedAt) < now - 72 * 60 * 60_000 || Date.parse(saved.checkpointAt) > now
      ) return fail()
    await (options.write ?? writeBundle)(SAMPLE_SURVEY_CHECKPOINT_INPUT, bundle.files)
    return saved
  } catch { return fail() }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.slice(2).length) { console.error('標本調査の途中記録の入力が不正です。'); process.exitCode = 1 }
  else prepareSampleSurveyCheckpoint().then(value => {
    if (value) console.log(JSON.stringify({ sampleSurveyCheckpointPrepared: { runId: value.runId, reportId: value.reportId, processed: value.processed, resumeDepth: value.resumeDepth } }))
  }).catch(() => { console.error('標本調査の途中記録を取得・確認できません。'); process.exitCode = 1 })
}
