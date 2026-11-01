import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { validateProductionResume } from './sample-survey-production-resume.ts'

const OLD_START = '2026-10-31T09:19:05Z', OLD_END = '2026-10-31T10:39:55Z', NEW_START = '2026-11-02T01:00:00Z'
const PRIVATE = 'synthetic-secret-never-log'
function run(id: number, created: string, path = '.github/workflows/sample-survey-production.yml') {
  return { id, created_at: created, updated_at: OLD_END, head_sha: 'a'.repeat(40), run_attempt: 1,
    event: 'workflow_dispatch', head_branch: 'main', path,
    repository: { full_name: 'gonchiman/sf6' }, head_repository: { full_name: 'gonchiman/sf6' },
    display_title: 'Sample survey production 111', status: 'completed', conclusion: 'failure' as string | null }
}
function fixture() {
  const previous = run(222, OLD_START)
  const current = { ...run(333, NEW_START), updated_at: NEW_START, head_sha: 'b'.repeat(40),
    display_title: 'Sample survey production 111 resume 222', status: 'in_progress', conclusion: null }
  const names = ['ROOKIE and IRON', 'BRONZE and SILVER', 'GOLD and PLATINUM', 'DIAMOND and MASTER', 'Six MR bands']
  const jobs = names.map((name, index) => ({ id: 444 + index, run_id: 222, name, status: 'completed',
    conclusion: index === 0 ? 'success' : index === 1 ? 'failure' : 'skipped',
    started_at: index === 0 ? '2026-10-31T09:19:10Z' : '2026-10-31T10:39:50Z', completed_at: OLD_END,
    steps: index < 2 ? [{ name: index === 0 ? 'Wait for the existing collection' : 'Start and verify this collection',
      status: 'completed', conclusion: index === 0 ? 'success' : 'failure' }] : null,
  }))
  const first = { ...run(111, '2026-10-31T09:18:52Z', '.github/workflows/sample-survey.yml'), conclusion: 'success' }
  return { parentRunId: '333', firstRunId: '111', previousParentRunId: '222',
    parents: { total_count: 2, workflow_runs: [structuredClone(previous), current] }, previousParent: previous,
    previousJobs: { total_count: 5, jobs }, childRuns: { total_count: 1, workflow_runs: [first] } }
}

test('completed first stage and an undispatched remainder may be adopted once, even after 24 hours', () => {
  const input = fixture()
  assert.doesNotThrow(() => validateProductionResume(input))
  input.parents.workflow_runs[1].status = 'queued'
  assert.doesNotThrow(() => validateProductionResume(input))
})

test('new children after this parent was created do not break later resumed stages', () => {
  const input = fixture()
  input.childRuns.workflow_runs.push({ ...run(999, '2026-11-02T01:00:01Z', '.github/workflows/sample-survey.yml'), conclusion: 'success' })
  input.childRuns.total_count++
  assert.doesNotThrow(() => validateProductionResume(input))
})

test('any possible child dispatch between the old parent and this parent blocks replay', () => {
  for (const created of [OLD_START, '2026-10-31T10:39:54Z', '2026-11-01T12:00:00Z', NEW_START]) {
    const input = fixture()
    input.childRuns.workflow_runs.push({ ...run(999, created, '.github/workflows/sample-survey.yml'), conclusion: 'success' })
    input.childRuns.total_count++
    assert.throws(() => validateProductionResume(input))
  }
  const older = fixture()
  older.childRuns.workflow_runs.push({ ...run(999, '2026-10-31T09:19:04Z', '.github/workflows/sample-survey.yml'), conclusion: 'success' })
  older.childRuns.total_count++
  assert.doesNotThrow(() => validateProductionResume(older))
})

test('an active, cancelled, successful or rerun old parent cannot authorize a resume', () => {
  for (const patch of [{ status: 'in_progress', conclusion: null }, { conclusion: 'cancelled' }, { conclusion: 'success' }, { run_attempt: 2 }]) {
    const input = fixture()
    Object.assign(input.previousParent, patch)
    Object.assign(input.parents.workflow_runs[0], patch)
    assert.throws(() => validateProductionResume(input))
  }
})

test('another original parent, duplicate resume, or altered suffix cannot reuse the first run', () => {
  for (const title of ['Sample survey production 111', 'Sample survey production 111 resume 222', 'Sample survey production 111 resume 999']) {
    const input = fixture()
    input.parents.workflow_runs.push({ ...run(999, NEW_START), display_title: title })
    input.parents.total_count++
    assert.throws(() => validateProductionResume(input))
  }
  const other = fixture()
  other.parents.workflow_runs.push({ ...run(999, NEW_START), display_title: 'Sample survey production 1111' })
  other.parents.total_count++
  assert.doesNotThrow(() => validateProductionResume(other))
})

test('metadata, chronology and source-parent mismatches reject adoption', () => {
  for (const change of [
    (x: ReturnType<typeof fixture>) => { x.parentRunId = x.previousParentRunId },
    (x: ReturnType<typeof fixture>) => { x.previousParentRunId = x.firstRunId },
    (x: ReturnType<typeof fixture>) => { x.firstRunId = '../111' },
    (x: ReturnType<typeof fixture>) => { x.parents.workflow_runs[1].display_title = 'Sample survey production 111 resume 999' },
    (x: ReturnType<typeof fixture>) => { x.parents.workflow_runs[1].run_attempt = 2 },
    (x: ReturnType<typeof fixture>) => { x.parents.workflow_runs[1].head_branch = 'feature' },
    (x: ReturnType<typeof fixture>) => { x.parents.workflow_runs[1].status = 'completed' },
    (x: ReturnType<typeof fixture>) => { x.parents.workflow_runs[1].event = 'push' },
    (x: ReturnType<typeof fixture>) => { x.parents.workflow_runs[1].repository.full_name = 'other/sf6' },
    (x: ReturnType<typeof fixture>) => { x.previousParent.head_repository.full_name = 'other/sf6' },
    (x: ReturnType<typeof fixture>) => { x.previousParent.path = '.github/workflows/other.yml' },
    (x: ReturnType<typeof fixture>) => { x.previousParent.head_sha = 'c'.repeat(40) },
    (x: ReturnType<typeof fixture>) => { x.previousParent.updated_at = NEW_START; x.parents.workflow_runs[0].updated_at = NEW_START },
    (x: ReturnType<typeof fixture>) => { x.previousParent.created_at = NEW_START; x.parents.workflow_runs[0].created_at = NEW_START },
    (x: ReturnType<typeof fixture>) => { x.parents.workflow_runs[1].created_at = 'not-a-date' },
  ]) {
    const input = fixture(); change(input)
    assert.throws(() => validateProductionResume(input))
  }
})

test('partial, duplicated, oversized or malformed API listings cannot prove undispatched work', () => {
  for (const key of ['parents', 'childRuns'] as const) {
    for (const count of [-1, 101, fixture()[key].total_count + 1]) {
      const input = fixture(); input[key].total_count = count
      assert.throws(() => validateProductionResume(input))
    }
    const input = fixture(); input[key].workflow_runs.push(structuredClone(input[key].workflow_runs[0])); input[key].total_count++
    assert.throws(() => validateProductionResume(input))
  }
  const input = fixture(); input.childRuns.workflow_runs[0].created_at = PRIVATE
  assert.throws(() => validateProductionResume(input), error => error instanceof Error && !error.message.includes(PRIVATE))
})

test('only the exact five-job first-success / second-failure / remaining-skipped stop is supported', () => {
  for (const change of [
    (x: ReturnType<typeof fixture>) => { x.previousJobs.total_count = 6 },
    (x: ReturnType<typeof fixture>) => { x.previousJobs.jobs[1].id = x.previousJobs.jobs[0].id },
    (x: ReturnType<typeof fixture>) => { x.previousJobs.jobs[1].run_id = 999 },
    (x: ReturnType<typeof fixture>) => { x.previousJobs.jobs[1].name = 'ROOKIE and IRON' },
    (x: ReturnType<typeof fixture>) => { x.previousJobs.jobs[0].conclusion = 'failure' },
    (x: ReturnType<typeof fixture>) => { x.previousJobs.jobs[1].conclusion = 'success' },
    (x: ReturnType<typeof fixture>) => { x.previousJobs.jobs[1].status = 'in_progress' },
    (x: ReturnType<typeof fixture>) => { x.previousJobs.jobs[2].conclusion = 'failure' },
    (x: ReturnType<typeof fixture>) => { x.previousJobs.jobs[1].steps![0].name = 'Other step' },
    (x: ReturnType<typeof fixture>) => { x.previousJobs.jobs[1].steps![0].conclusion = 'success' },
    (x: ReturnType<typeof fixture>) => { x.previousJobs.jobs[2].steps = [{ name: 'Unexpected execution', status: 'completed', conclusion: 'success' }] },
    (x: ReturnType<typeof fixture>) => { x.previousJobs.jobs[0].started_at = '2026-10-31T09:19:04Z' },
    (x: ReturnType<typeof fixture>) => { x.previousJobs.jobs[1].completed_at = NEW_START },
  ]) {
    const input = fixture(); change(input)
    assert.throws(() => validateProductionResume(input))
  }
})

test('parent workflow makes resume explicit and passes the same source to every stage', async () => {
  const workflow = await readFile(new URL('../../.github/workflows/sample-survey-production.yml', import.meta.url), 'utf8')
  assert.match(workflow, /resume_from_run_id:/)
  assert.match(workflow, /format\('Sample survey production \{0\} resume \{1\}'/)
  for (let stage = 1; stage <= 5; stage++) {
    const section = workflow.split(`  stage-${stage}:`)[1].split(/\n  stage-\d:/)[0]
    assert.match(section, /PRODUCTION_RESUME_FROM_RUN_ID: \$\{\{ inputs.resume_from_run_id \}\}/)
    assert.match(section, /github\.run_attempt == 1/)
    if (stage > 1) assert.match(section, new RegExp(`needs: stage-${stage - 1}`))
  }
  assert.match(workflow, /cancel-in-progress: false/)
  assert.doesNotMatch(workflow, /secrets\.|BUCKLER_WEEKLY_SESSION|continue-on-error:/)
})
