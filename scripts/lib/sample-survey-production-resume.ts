const REPO = 'gonchiman/sf6'
const PARENT_WORKFLOW = '.github/workflows/sample-survey-production.yml'
const CHILD_WORKFLOW = '.github/workflows/sample-survey.yml'
const fail = (): never => { throw new Error('完了済み第1回と未着手の後続を確認できないため、再開しません。') }
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail()
  return value as Record<string, unknown>
}
const id = (value: unknown): string => {
  const text = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value
  if (typeof text !== 'string' || !/^[1-9]\d{0,14}$/.test(text)) return fail()
  return text
}
const timestamp = (value: unknown): number => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return fail()
  const result = Date.parse(value)
  if (!Number.isFinite(result) || new Date(result).toISOString().slice(0, 19) !== value.slice(0, 19)) return fail()
  return result
}
const listing = (value: unknown, field: 'workflow_runs' | 'jobs'): Record<string, unknown>[] => {
  const input = object(value), rows = input[field]
  if (!Number.isSafeInteger(input.total_count) || Number(input.total_count) < 0 || Number(input.total_count) > 100
    || !Array.isArray(rows) || rows.length !== input.total_count) return fail()
  const result = rows.map(object), ids = result.map(row => id(row.id))
  if (new Set(ids).size !== result.length) return fail()
  return result
}
function workflowRun(value: Record<string, unknown>, path: string): void {
  id(value.id)
  if (value.event !== 'workflow_dispatch' || value.head_branch !== 'main'
    || object(value.repository).full_name !== REPO || object(value.head_repository).full_name !== REPO
    || ![path, `${path}@refs/heads/main`].includes(String(value.path))
    || typeof value.head_sha !== 'string' || !/^[a-f0-9]{40}$/.test(value.head_sha)) return fail()
  timestamp(value.created_at)
}
function stoppedParentJobs(value: unknown, parent: Record<string, unknown>): void {
  const jobs = listing(value, 'jobs'), parentId = id(parent.id), start = timestamp(parent.created_at), end = timestamp(parent.updated_at)
  const expected = [
    ['ROOKIE and IRON', 'success', 'Wait for the existing collection'],
    ['BRONZE and SILVER', 'failure', 'Start and verify this collection'],
    ['GOLD and PLATINUM', 'skipped', null], ['DIAMOND and MASTER', 'skipped', null], ['Six MR bands', 'skipped', null],
  ] as const
  if (jobs.length !== expected.length) return fail()
  for (const [name, conclusion, stepName] of expected) {
    const matching = jobs.filter(job => job.name === name)
    if (matching.length !== 1) return fail()
    const job = matching[0]!
    if (id(job.run_id) !== parentId || job.status !== 'completed' || job.conclusion !== conclusion) return fail()
    if (stepName !== null) {
      const from = timestamp(job.started_at), to = timestamp(job.completed_at)
      if (from < start || to < from || to > end || !Array.isArray(job.steps)) return fail()
      const steps = job.steps.map(object).filter(step => step.name === stepName)
      if (steps.length !== 1 || steps[0]!.status !== 'completed' || steps[0]!.conclusion !== conclusion) return fail()
    } else if (job.steps !== null && (!Array.isArray(job.steps) || job.steps.length !== 0)) return fail()
  }
}

/** One explicitly reviewed recovery of stage 3. Earlier successful collections are
 * adopted, never dispatched again. The caller must verify their published reports
 * and the failed child's authenticated checkpoint before dispatching any new work.
 */
export function validateProductionRecovery(options: {
  parents: unknown; previousParent: unknown; previousJobs: unknown; childRuns: unknown
  completedSecond: unknown; failedChild: unknown
  parentRunId: string; firstRunId: string; previousParentRunId: string
  completedSecondRunId: string; checkpointRunId: string; checkpointSourceSha: string
}): void {
  try {
    const currentId = id(options.parentRunId), firstId = id(options.firstRunId), previousId = id(options.previousParentRunId)
    const secondId = id(options.completedSecondRunId), failedId = id(options.checkpointRunId)
    if (new Set([currentId, firstId, previousId, secondId, failedId]).size !== 5
      || !/^[a-f0-9]{40}$/.test(options.checkpointSourceSha)) return fail()
    const previous = object(options.previousParent), parents = listing(options.parents, 'workflow_runs')
    const base = `Sample survey production ${firstId}`
    const current = parents.find(row => id(row.id) === currentId), listedPrevious = parents.find(row => id(row.id) === previousId)
    if (!current || !listedPrevious || id(previous.id) !== previousId) return fail()
    for (const parent of [current, previous, listedPrevious]) {
      workflowRun(parent, PARENT_WORKFLOW)
      if (parent.run_attempt !== 1) return fail()
    }
    if (current.display_title !== `${base} recover ${previousId} checkpoint ${failedId}`
      || !['queued', 'in_progress'].includes(String(current.status)) || current.conclusion !== null
      || typeof previous.display_title !== 'string' || !previous.display_title.startsWith(`${base} `)
      || previous.status !== 'completed' || previous.conclusion !== 'failure'
      || previous.head_sha !== options.checkpointSourceSha) return fail()
    for (const key of ['head_sha', 'created_at', 'updated_at', 'display_title', 'status', 'conclusion', 'run_attempt']) {
      if (previous[key] !== listedPrevious[key]) return fail()
    }
    const start = timestamp(previous.created_at), end = timestamp(previous.updated_at), cutoff = timestamp(current.created_at)
    if (end < start || cutoff <= end) return fail()
    // Earlier ancestors are allowed. Another attempt after this source parent
    // would make it unsafe to claim that the later stages remain undispatched.
    for (const parent of parents) {
      if (typeof parent.display_title !== 'string' || !(parent.display_title === base || parent.display_title.startsWith(`${base} `))) continue
      workflowRun(parent, PARENT_WORKFLOW)
      if (![currentId, previousId].includes(id(parent.id)) && timestamp(parent.created_at) >= start) return fail()
    }
    const jobs = listing(options.previousJobs, 'jobs')
    const expected = [
      ['ROOKIE and IRON', 'success', 'Wait for the existing collection'],
      ['BRONZE and SILVER', 'success', 'Start and verify this collection'],
      ['GOLD and PLATINUM', 'failure', 'Start and verify this collection'],
      ['DIAMOND and MASTER', 'skipped', null], ['Six MR bands', 'skipped', null],
    ] as const
    if (jobs.length !== expected.length) return fail()
    const windows: [number, number][] = []
    for (const [name, conclusion, stepName] of expected) {
      const matches = jobs.filter(job => job.name === name)
      if (matches.length !== 1) return fail()
      const job = matches[0]!
      if (id(job.run_id) !== previousId || job.status !== 'completed' || job.conclusion !== conclusion) return fail()
      if (stepName === null) {
        if (job.steps !== null && (!Array.isArray(job.steps) || job.steps.length !== 0)) return fail()
        continue
      }
      const from = timestamp(job.started_at), to = timestamp(job.completed_at)
      if (from < start || to < from || to > end || windows.length && from < windows.at(-1)![1] || !Array.isArray(job.steps)) return fail()
      const steps = job.steps.map(object).filter(step => step.name === stepName)
      if (steps.length !== 1 || steps[0]!.status !== 'completed' || steps[0]!.conclusion !== conclusion) return fail()
      windows.push([from, to])
    }
    const second = object(options.completedSecond), failed = object(options.failedChild)
    const known = new Map([[secondId, second], [failedId, failed]])
    const within = (run: Record<string, unknown>, window: [number, number]): boolean => {
      const from = timestamp(run.created_at), to = timestamp(run.updated_at)
      return from >= window[0] && to >= from && to <= window[1]
    }
    for (const [runId, run, conclusion, window] of [
      [secondId, second, 'success', windows[1]!], [failedId, failed, 'failure', windows[2]!],
    ] as const) {
      workflowRun(run, CHILD_WORKFLOW)
      if (id(run.id) !== runId || run.run_attempt !== 1 || run.status !== 'completed' || run.conclusion !== conclusion
        || run.display_title !== `Sample survey source ${options.checkpointSourceSha}` || !within(run, window)) return fail()
    }
    const found = new Set<string>()
    for (const run of listing(options.childRuns, 'workflow_runs')) {
      workflowRun(run, CHILD_WORKFLOW)
      const runId = id(run.id), created = timestamp(run.created_at), reference = known.get(runId)
      if (reference) {
        for (const key of ['head_sha', 'created_at', 'updated_at', 'display_title', 'status', 'conclusion', 'run_attempt']) if (run[key] !== reference[key]) return fail()
        found.add(runId)
      }
      // New children of the current parent are intentionally outside this fixed cutoff.
      if (runId === firstId || created < start || created > cutoff || reference) continue
      if (run.run_attempt !== 1 || run.status !== 'completed' || run.conclusion !== 'failure'
        || run.display_title !== `Sample survey source ${options.checkpointSourceSha}`
        || !(within(run, windows[1]!) && timestamp(run.updated_at) < timestamp(second.created_at)
          || within(run, windows[2]!) && timestamp(run.updated_at) < timestamp(failed.created_at))) return fail()
    }
    if (found.size !== 2) return fail()
  } catch { return fail() }
}

/** Explicit migration for an old failed child which has no saved checkpoint or published artifact.
 * The previous two parents must both have preserved stage 1 and never reached stage 3.
 */
export function validateProductionRestart(options: {
  parents: unknown; previousParent: unknown; previousJobs: unknown; ancestorParent: unknown; ancestorJobs: unknown
  failedChild: unknown; failedChildJobs: unknown; failedChildArtifacts: unknown; childRuns: unknown
  parentRunId: string; firstRunId: string; previousParentRunId: string; restartFailedRunId: string
}): void {
  try {
    const currentId = id(options.parentRunId), firstId = id(options.firstRunId), previousId = id(options.previousParentRunId), failedId = id(options.restartFailedRunId)
    const previous = object(options.previousParent), ancestor = object(options.ancestorParent), ancestorId = id(ancestor.id)
    if (new Set([currentId, firstId, previousId, failedId, ancestorId]).size !== 5 || id(previous.id) !== previousId) return fail()
    const base = `Sample survey production ${firstId}`, parents = listing(options.parents, 'workflow_runs')
    const matches = parents.filter(row => row.display_title === base || typeof row.display_title === 'string' && row.display_title.startsWith(`${base} `))
    if (matches.length !== 3) return fail()
    const current = matches.find(row => id(row.id) === currentId)
    if (!current || current.display_title !== `${base} resume ${previousId} restart ${failedId}`
      || !['queued', 'in_progress'].includes(String(current.status)) || current.conclusion !== null) return fail()
    workflowRun(current, PARENT_WORKFLOW)
    if (current.run_attempt !== 1 || previous.display_title !== `${base} resume ${ancestorId}` || ancestor.display_title !== base) return fail()
    for (const parent of [ancestor, previous]) {
      workflowRun(parent, PARENT_WORKFLOW)
      if (parent.run_attempt !== 1 || parent.status !== 'completed' || parent.conclusion !== 'failure') return fail()
      const listed = matches.find(row => id(row.id) === id(parent.id))
      if (!listed) return fail()
      workflowRun(listed, PARENT_WORKFLOW)
      for (const key of ['head_sha', 'created_at', 'updated_at', 'display_title', 'status', 'conclusion', 'run_attempt']) if (listed[key] !== parent[key]) return fail()
    }
    const ancestorStart = timestamp(ancestor.created_at), ancestorEnd = timestamp(ancestor.updated_at)
    const previousStart = timestamp(previous.created_at), previousEnd = timestamp(previous.updated_at), cutoff = timestamp(current.created_at)
    if (ancestorEnd < ancestorStart || previousStart <= ancestorEnd || previousEnd < previousStart || cutoff <= previousEnd) return fail()
    stoppedParentJobs(options.ancestorJobs, ancestor); stoppedParentJobs(options.previousJobs, previous)
    const failed = object(options.failedChild)
    workflowRun(failed, CHILD_WORKFLOW)
    if (id(failed.id) !== failedId || failed.run_attempt !== 1 || failed.status !== 'completed' || failed.conclusion !== 'failure'
      || failed.display_title !== `Sample survey source ${previous.head_sha}` || failed.head_sha !== previous.head_sha
      || timestamp(failed.created_at) < previousStart || timestamp(failed.created_at) > previousEnd || timestamp(failed.updated_at) >= cutoff
      || timestamp(failed.updated_at) < timestamp(failed.created_at)) return fail()
    const artifacts = object(options.failedChildArtifacts)
    if (artifacts.total_count !== 0 || !Array.isArray(artifacts.artifacts) || artifacts.artifacts.length !== 0) return fail()
    const childJobs = listing(options.failedChildJobs, 'jobs')
    if (childJobs.length !== 2) return fail()
    const collect = childJobs.find(job => job.name === 'collect'), save = childJobs.find(job => job.name === 'save-history')
    if (!collect || !save || id(collect.run_id) !== failedId || id(save.run_id) !== failedId
      || collect.status !== 'completed' || collect.conclusion !== 'failure' || save.status !== 'completed' || save.conclusion !== 'skipped'
      || !Array.isArray(collect.steps) || save.steps !== null && (!Array.isArray(save.steps) || save.steps.length)) return fail()
    const stops = collect.steps.map(object).filter(step => step.name === 'Collect serial sample with saved session')
    if (stops.length !== 1 || stops[0]!.status !== 'completed' || stops[0]!.conclusion !== 'failure') return fail()
    let listedFailure = false
    for (const run of listing(options.childRuns, 'workflow_runs')) {
      workflowRun(run, CHILD_WORKFLOW)
      const created = timestamp(run.created_at)
      if (id(run.id) === failedId) {
        listedFailure = true
        for (const key of ['head_sha', 'created_at', 'updated_at', 'display_title', 'status', 'conclusion', 'run_attempt']) if (run[key] !== failed[key]) return fail()
      }
      if (![firstId, failedId].includes(id(run.id)) && created >= ancestorStart && created <= cutoff) return fail()
    }
    if (!listedFailure) return fail()
  } catch { return fail() }
}

/** Resume only the proven pre-dispatch stop after the completed first 400 slots.
 * No child is re-dispatched based merely on a failed parent job or missing log line.
 * The first run's successful artifact and immutable history must still be checked by the caller.
 */
export function validateProductionResume(options: {
  parents: unknown; previousParent: unknown; previousJobs: unknown; childRuns: unknown
  parentRunId: string; firstRunId: string; previousParentRunId: string
}): void {
  try {
    const currentId = id(options.parentRunId), firstId = id(options.firstRunId), previousId = id(options.previousParentRunId)
    if (currentId === previousId || currentId === firstId || previousId === firstId) return fail()
    const parents = listing(options.parents, 'workflow_runs'), previous = object(options.previousParent)
    const baseTitle = `Sample survey production ${firstId}`
    const matches = parents.filter(row => typeof row.display_title === 'string'
      && (row.display_title === baseTitle || row.display_title.startsWith(`${baseTitle} `)))
    if (matches.length !== 2) return fail()
    const current = matches.find(row => id(row.id) === currentId), listedPrevious = matches.find(row => id(row.id) === previousId)
    if (!current || !listedPrevious || id(previous.id) !== previousId) return fail()
    for (const run of [current, listedPrevious, previous]) {
      workflowRun(run, PARENT_WORKFLOW)
      if (run.run_attempt !== 1) return fail()
    }
    if (current.display_title !== `${baseTitle} resume ${previousId}` || !['queued', 'in_progress'].includes(String(current.status))
      || current.conclusion !== null || previous.display_title !== baseTitle
      || previous.status !== 'completed' || previous.conclusion !== 'failure') return fail()
    for (const key of ['head_sha', 'created_at', 'display_title', 'status', 'conclusion', 'updated_at']) {
      if (previous[key] !== listedPrevious[key]) return fail()
    }
    const previousStart = timestamp(previous.created_at), previousEnd = timestamp(previous.updated_at), cutoff = timestamp(current.created_at)
    if (previousEnd < previousStart || previousStart >= cutoff || previousEnd >= cutoff) return fail()

    const jobs = listing(options.previousJobs, 'jobs')
    const expected = [
      ['ROOKIE and IRON', 'success', 'Wait for the existing collection'],
      ['BRONZE and SILVER', 'failure', 'Start and verify this collection'],
      ['GOLD and PLATINUM', 'skipped', null],
      ['DIAMOND and MASTER', 'skipped', null],
      ['Six MR bands', 'skipped', null],
    ] as const
    if (jobs.length !== expected.length) return fail()
    for (const [name, conclusion, stepName] of expected) {
      const matching = jobs.filter(job => job.name === name)
      if (matching.length !== 1) return fail()
      const job = matching[0]!
      if (id(job.run_id) !== previousId || job.status !== 'completed' || job.conclusion !== conclusion) return fail()
      if (stepName !== null) {
        const start = timestamp(job.started_at), end = timestamp(job.completed_at)
        if (start < previousStart || end < start || end > previousEnd || !Array.isArray(job.steps)) return fail()
        const steps = job.steps.map(object), matchingSteps = steps.filter(step => step.name === stepName)
        if (matchingSteps.length !== 1 || matchingSteps[0]!.status !== 'completed' || matchingSteps[0]!.conclusion !== conclusion) return fail()
      } else if (job.steps !== null && (!Array.isArray(job.steps) || job.steps.length !== 0)) return fail()
    }

    // Use the new parent's creation time, not wall time: later stages must not
    // reject the children that this same resumed chain has legitimately started.
    for (const run of listing(options.childRuns, 'workflow_runs')) {
      workflowRun(run, CHILD_WORKFLOW)
      const created = timestamp(run.created_at)
      if (id(run.id) !== firstId && created >= previousStart && created <= cutoff) return fail()
    }
  } catch { return fail() }
}
