import { execFile } from 'node:child_process'
import { isSteamCollectionScheduledAt, STEAM_COLLECTION_ERROR_CODES } from '../../src/lib/steamCollectionHistory.ts'
import { STEAM_PLAYER_COUNT_GAMES } from '../../src/lib/steamPlayerCountGames.ts'

const REPOSITORY = 'gonchiman/sf6'
const REPOSITORY_URL = `github.com/${REPOSITORY}`
const DISPATCH_WORKFLOW = 'steam-player-count-dispatch.yml'
const COLLECTION_WORKFLOW = 'steam-player-count.yml'
const SCHEDULED_TITLE_PREFIX = 'Steam observation '
const LEGACY_COLLECTION_TITLE = 'Collect Steam player count'
const RUN_LIMIT = 200
const DAY_MS = 86_400_000
const QUERY_PARALLELISM = 4
const GAME_IDS = new Set<number>(STEAM_PLAYER_COUNT_GAMES.map(game => game.appId))
const GAME_ERRORS = new Set<string>(STEAM_COLLECTION_ERROR_CODES)
const FAILED_JOB_CONCLUSIONS = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure', 'stale'])

export type SteamDispatchEvidence = {
  scheduledAt: string
  runId: string
  attempt: number
  reason: 'failed' | 'skipped'
  httpStatus?: number
}

type GameEvidence = {
  appId: number
  status: 'succeeded' | 'failed'
  errorCode?: string
  observedAt?: string
}

export type SteamCollectorEvidence = {
  runId: string
  attempt: number
  scheduledAt?: string
  createdAt: string
  completed: boolean
  saveFailed: boolean
  collectFailed: boolean
  games: GameEvidence[]
}

type Run = {
  id: string
  attempt: number
  title: string
  scheduledAt?: string
  createdAt: string
  updatedAt: string
  status: string
  conclusion: string
}

type GitHubCli = (args: string[]) => Promise<string>
const gh: GitHubCli = args => new Promise((resolve, reject) => {
  execFile('gh', args, {
    encoding: 'utf8', timeout: 45_000, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' },
  }, (error, stdout) => {
    if (error) reject(new Error('Steam取得履歴のGitHub照会に失敗しました。'))
    else resolve(stdout)
  })
})

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function utcTimestamp(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return
  const ms = Date.parse(value)
  if (!Number.isFinite(ms)) return
  const iso = new Date(ms).toISOString()
  return iso === value || iso.replace('.000Z', 'Z') === value ? iso : undefined
}

async function listRuns(workflow: string, cutoff: number, query: GitHubCli): Promise<Run[]> {
  const fields = 'databaseId,attempt,displayTitle,headBranch,createdAt,updatedAt,status,conclusion'
  const args = ['run', 'list', '--repo', REPOSITORY_URL, '--workflow', workflow,
    '--branch', 'main', '--limit', String(RUN_LIMIT), '--json', fields]
  // Dispatcher runs may have waited before starting. List their recent history without a creation-time filter.
  if (workflow === COLLECTION_WORKFLOW) args.push('--created', `>=${new Date(cutoff).toISOString().replace(/\.\d{3}Z$/, 'Z')}`)
  const payload: unknown = JSON.parse(await query(args))
  if (!Array.isArray(payload)) throw new Error('Steam取得履歴のrun一覧の形式が不正です。')
  const runs = payload.map((value: unknown): Run => {
    const createdAt = record(value) ? utcTimestamp(value.createdAt) : undefined
    const updatedAt = record(value) ? utcTimestamp(value.updatedAt) : undefined
    if (!record(value) || value.headBranch !== 'main' || !positive(value.databaseId) || !positive(value.attempt)
      || typeof value.displayTitle !== 'string' || typeof value.status !== 'string'
      || typeof value.conclusion !== 'string' || !createdAt || !updatedAt) {
      throw new Error('Steam取得履歴のrunの形式が不正です。')
    }
    const title = value.displayTitle
    const slot = title.startsWith(SCHEDULED_TITLE_PREFIX) ? title.slice(SCHEDULED_TITLE_PREFIX.length) : undefined
    return { id: String(value.databaseId), attempt: value.attempt, title,
      ...(isSteamCollectionScheduledAt(slot) ? { scheduledAt: slot } : {}), createdAt, updatedAt,
      status: value.status, conclusion: value.conclusion }
  })
  if (runs.length >= RUN_LIMIT
    && (workflow === COLLECTION_WORKFLOW || runs.every(run => Date.parse(run.createdAt) >= cutoff))) {
    throw new Error('Steam取得履歴のrun一覧が上限を超えました。')
  }
  return runs
}

// The CLI prefixes log lines with the job, step and GitHub's line timestamp.
// Only structured output from the relevant job and step is eligible as evidence.
function logRecords(log: string, job: string, step: string): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = []
  for (const line of log.split(/\r?\n/)) {
    const [jobName, stepName, message] = line.split('\t', 3)
    if (jobName !== job || (stepName !== step && stepName !== 'UNKNOWN STEP') || !message) continue
    const json = message.slice(message.indexOf(' ') + 1)
    if (!json.startsWith('{') || json.length > 4096) continue
    try {
      const value: unknown = JSON.parse(json)
      if (record(value)) rows.push(value)
    } catch { /* The logger can truncate the final line when a job is cancelled. */ }
  }
  return rows
}

function dispatcherLog(log: string, run: Run, cutoff: number, now: number): SteamDispatchEvidence[] {
  const results: SteamDispatchEvidence[] = []
  for (const row of logRecords(log, 'dispatch', 'Dispatch current observations and reserve the successor')) {
    if (row.event !== 'slot-failed' && row.event !== 'slot-skipped') continue
    // current-slot is the positive evidence of deduplication, not a missing dispatch.
    if (row.event === 'slot-skipped' && row.reason === 'current-slot') continue
    const scheduledAt = row.scheduledAt
    if (!isSteamCollectionScheduledAt(scheduledAt) || Date.parse(scheduledAt) < cutoff || Date.parse(scheduledAt) > now) continue
    results.push({
      scheduledAt, runId: run.id, attempt: run.attempt,
      reason: row.event === 'slot-failed' ? 'failed' : 'skipped',
      ...(row.event === 'slot-failed' && row.stage === 'collection-dispatch' && typeof row.httpStatus === 'number'
        && Number.isInteger(row.httpStatus) && row.httpStatus >= 400 && row.httpStatus <= 599 ? { httpStatus: row.httpStatus } : {}),
    })
  }
  return results
}

function collectorLog(log: string): GameEvidence[] {
  const rows = logRecords(log, 'collect', 'Collect all five current Steam player counts sequentially')
  for (const row of rows.reverse()) {
    if (!Array.isArray(row.results) || row.results.length !== GAME_IDS.size) continue
    const games: GameEvidence[] = []
    for (const item of row.results as unknown[]) {
      if (!record(item) || typeof item.appId !== 'number' || !GAME_IDS.has(item.appId)) break
      if (item.status === 'failed' && typeof item.errorCode === 'string' && GAME_ERRORS.has(item.errorCode)) {
        games.push({ appId: item.appId, status: item.status, errorCode: item.errorCode })
      } else if (item.status === 'succeeded') {
        const observedAt = utcTimestamp(item.observedAt)
        if (!observedAt) break
        games.push({ appId: item.appId, status: item.status, observedAt })
      } else break
    }
    if (new Set(games.map(game => game.appId)).size === GAME_IDS.size
      && games.filter(game => game.status === 'succeeded').length === row.successfulGames) return games
  }
  return []
}

type Job = { id: string; conclusion: string }

async function collectorJobs(run: Run, query: GitHubCli): Promise<Map<string, Job>> {
  const endpoint = `repos/${REPOSITORY}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`
  const payload: unknown = JSON.parse(await query(['api', '--hostname', 'github.com', endpoint]))
  if (!record(payload) || !Array.isArray(payload.jobs) || payload.total_count !== payload.jobs.length) {
    throw new Error('Steam取得履歴のjob一覧の形式が不正です。')
  }
  const jobs = new Map<string, Job>()
  for (const job of payload.jobs as unknown[]) {
    if (!record(job) || (job.name !== 'collect' && job.name !== 'save-history')) continue
    if (!positive(job.id) || String(job.run_id) !== run.id || jobs.has(job.name)) {
      throw new Error('Steam取得履歴のjobの形式が不正です。')
    }
    if (typeof job.conclusion === 'string') jobs.set(job.name, { id: String(job.id), conclusion: job.conclusion })
  }
  return jobs
}

async function collection(run: Run, query: GitHubCli): Promise<SteamCollectorEvidence> {
  const { scheduledAt } = run
  const result: SteamCollectorEvidence = { runId: run.id, attempt: run.attempt,
    ...(scheduledAt ? { scheduledAt } : {}), createdAt: run.createdAt,
    completed: run.status === 'completed', saveFailed: false, collectFailed: false, games: [] }
  if (!result.completed || run.conclusion === 'success') return result

  // A completed run may have lost its logs or failed before either job ran.
  const jobs = await collectorJobs(run, query).catch(() => null)
  if (!jobs) return result
  const collect = jobs.get('collect')
  const save = jobs.get('save-history')
  result.saveFailed = !!save && FAILED_JOB_CONCLUSIONS.has(save.conclusion)
  result.collectFailed = !!collect && FAILED_JOB_CONCLUSIONS.has(collect.conclusion)
  if (collect && (result.collectFailed || result.saveFailed)) {
    const log = await query(['run', 'view', '--repo', REPOSITORY_URL, '--job', collect.id, '--log']).catch(() => '')
    result.games = collectorLog(log)
  }
  return result
}

async function boundedMap<Input, Output>(items: Input[], map: (item: Input) => Promise<Output>): Promise<Output[]> {
  const results: Output[] = []
  for (let i = 0; i < items.length; i += QUERY_PARALLELISM) {
    results.push(...await Promise.all(items.slice(i, i + QUERY_PARALLELISM).map(map)))
  }
  return results
}

export async function readSteamCollectionEvidence(now: Date, query: GitHubCli = gh): Promise<{
  dispatch: SteamDispatchEvidence[]
  collections: SteamCollectorEvidence[]
}> {
  const cutoff = now.getTime() - DAY_MS
  const [dispatchRuns, collectionRuns] = await Promise.all([
    listRuns(DISPATCH_WORKFLOW, cutoff, query), listRuns(COLLECTION_WORKFLOW, cutoff, query),
  ])
  const dispatch = await boundedMap(dispatchRuns.filter(run =>
    run.status === 'completed' && Date.parse(run.updatedAt) >= cutoff && Date.parse(run.createdAt) <= now.getTime()), async run => {
    const log = await query(['run', 'view', run.id, '--repo', REPOSITORY_URL, '--attempt', String(run.attempt), '--log']).catch(() => '')
    return dispatcherLog(log, run, cutoff, now.getTime())
  })
  const eligible = collectionRuns.filter(run => Date.parse(run.createdAt) <= now.getTime()
    && (run.scheduledAt !== undefined || run.title === LEGACY_COLLECTION_TITLE))
  const collections = await boundedMap(eligible, run => collection(run, query))
  return { dispatch: dispatch.flat(), collections }
}
