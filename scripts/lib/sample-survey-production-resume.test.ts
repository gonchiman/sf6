import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { validateProductionRecovery, validateProductionRestart, validateProductionResume } from './sample-survey-production-resume.ts'

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
  const first = { ...run(111, '2026-10-31T09:18:52Z', '.github/workflows/sample-survey.yml'), conclusion: 'success' as string | null }
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

function restartFixture() {
  const old = fixture(), previousStart = '2026-11-01T03:37:55Z', previousEnd = '2026-11-01T04:02:30Z'
  const previous = { ...old.parents.workflow_runs[1], created_at: previousStart, updated_at: previousEnd, status: 'completed', conclusion: 'failure' }
  const current = { ...run(666, NEW_START), updated_at: NEW_START, head_sha: 'c'.repeat(40),
    display_title: 'Sample survey production 111 resume 333 restart 555', status: 'in_progress', conclusion: null }
  const failed = { ...run(555, '2026-11-01T03:38:25Z', '.github/workflows/sample-survey.yml'),
    updated_at: '2026-11-01T04:02:15Z', head_sha: previous.head_sha, display_title: `Sample survey source ${previous.head_sha}` }
  const previousJobs = { total_count: 5, jobs: old.previousJobs.jobs.map((job, index) => ({ ...structuredClone(job),
    id: 1000 + index, run_id: 333, started_at: previousStart, completed_at: previousEnd })) }
  return { parentRunId: '666', firstRunId: '111', previousParentRunId: '333', restartFailedRunId: '555',
    parents: { total_count: 3, workflow_runs: [structuredClone(old.previousParent), structuredClone(previous), current] },
    previousParent: previous, previousJobs, ancestorParent: old.previousParent, ancestorJobs: old.previousJobs,
    failedChild: failed, failedChildArtifacts: { total_count: 0, artifacts: [] as unknown[] },
    failedChildJobs: { total_count: 2, jobs: [
      { id: 2000, run_id: 555, name: 'collect', status: 'completed', conclusion: 'failure', steps: [
        { name: 'Collect serial sample with saved session', status: 'completed', conclusion: 'failure' }] },
      { id: 2001, run_id: 555, name: 'save-history', status: 'completed', conclusion: 'skipped', steps: null },
    ] }, childRuns: { total_count: 2, workflow_runs: [...old.childRuns.workflow_runs, structuredClone(failed)] } }
}

test('explicit legacy restart preserves the original 400 slots after a failed child without artifacts', () => {
  const input = restartFixture()
  assert.doesNotThrow(() => validateProductionRestart(input))
  input.childRuns.workflow_runs.push({ ...run(777, '2026-11-02T01:00:01Z', '.github/workflows/sample-survey.yml'), conclusion: 'success' })
  input.childRuns.total_count++
  assert.doesNotThrow(() => validateProductionRestart(input))
})

test('a dispatched child may finish after its parent metadata check failed, but must finish before the new parent', () => {
  const input = restartFixture()
  input.failedChild.updated_at = '2026-11-01T05:00:00Z'
  input.childRuns.workflow_runs[1].updated_at = input.failedChild.updated_at
  assert.doesNotThrow(() => validateProductionRestart(input))
  input.failedChild.updated_at = NEW_START
  input.childRuns.workflow_runs[1].updated_at = NEW_START
  assert.throws(() => validateProductionRestart(input))
})

test('legacy restart refuses a checkpoint, a published artifact, active work, altered lineage or extra child', () => {
  const changes: ((input: ReturnType<typeof restartFixture>) => void)[] = [
    x => { x.failedChildArtifacts.total_count = 1; x.failedChildArtifacts.artifacts = [{ name: 'sample-survey-checkpoint-555-1' }] },
    x => { x.failedChildArtifacts.artifacts = [{ name: 'sample-survey-555-1' }] },
    x => { x.failedChild.conclusion = 'success'; x.childRuns.workflow_runs[1].conclusion = 'success' },
    x => { x.failedChild.status = 'in_progress'; x.childRuns.workflow_runs[1].status = 'in_progress' },
    x => { x.failedChild.run_attempt = 2; x.childRuns.workflow_runs[1].run_attempt = 2 },
    x => { x.failedChild.head_sha = 'c'.repeat(40); x.childRuns.workflow_runs[1].head_sha = 'c'.repeat(40) },
    x => { x.previousParent.display_title = 'Sample survey production 111 resume 999'; x.parents.workflow_runs[1].display_title = x.previousParent.display_title },
    x => { x.parents.workflow_runs[2].display_title = 'Sample survey production 111 resume 333' },
    x => { x.previousJobs.jobs[2].conclusion = 'success' },
    x => { x.ancestorJobs.jobs[0].conclusion = 'failure' },
    x => { x.failedChildJobs.jobs[1].conclusion = 'success' },
    x => { x.failedChildJobs.jobs[0].steps![0].name = 'Unrelated failure' },
    x => { x.childRuns.workflow_runs.push({ ...run(777, '2026-11-01T12:00:00Z', '.github/workflows/sample-survey.yml'), conclusion: 'success' }); x.childRuns.total_count++ },
    x => { x.parents.workflow_runs.push({ ...run(777, NEW_START), display_title: x.parents.workflow_runs[2].display_title }); x.parents.total_count++ },
  ]
  for (const change of changes) { const input = restartFixture(); change(input); assert.throws(() => validateProductionRestart(input)) }
})

function recoveryFixture() {
  const previous = { ...run(222, '2026-11-02T04:12:09Z'), updated_at: '2026-11-02T06:38:23Z',
    display_title: 'Sample survey production 111 resume 10 restart 20' }
  const current = { ...run(333, '2026-11-04T01:00:00Z'), updated_at: '2026-11-04T01:00:00Z', head_sha: 'b'.repeat(40),
    display_title: 'Sample survey production 111 recover 222 checkpoint 555', status: 'in_progress', conclusion: null }
  const second = { ...run(444, '2026-11-02T05:48:26Z', '.github/workflows/sample-survey.yml'),
    updated_at: '2026-11-02T05:53:10Z', display_title: `Sample survey source ${previous.head_sha}`, conclusion: 'success' }
  const failed = { ...run(555, '2026-11-02T05:53:55Z', '.github/workflows/sample-survey.yml'),
    updated_at: '2026-11-02T06:38:09Z', display_title: `Sample survey source ${previous.head_sha}` }
  const retries = [
    { ...second, id: 666, created_at: '2026-11-02T04:12:42Z', updated_at: '2026-11-02T04:53:39Z', conclusion: 'failure' },
    { ...second, id: 777, created_at: '2026-11-02T04:59:03Z', updated_at: '2026-11-02T05:43:09Z', conclusion: 'failure' },
  ]
  const windows = [
    ['ROOKIE and IRON', 'success', '2026-11-02T04:12:13Z', '2026-11-02T04:12:28Z'],
    ['BRONZE and SILVER', 'success', '2026-11-02T04:12:31Z', '2026-11-02T05:53:37Z'],
    ['GOLD and PLATINUM', 'failure', '2026-11-02T05:53:40Z', '2026-11-02T06:38:22Z'],
    ['DIAMOND and MASTER', 'skipped', '2026-11-02T06:38:22Z', '2026-11-02T06:38:22Z'],
    // GitHub may publish skipped job timestamps one second apart in reverse order.
    ['Six MR bands', 'skipped', '2026-11-02T06:38:23Z', '2026-11-02T06:38:22Z'],
  ]
  const jobs = windows.map(([name, conclusion, started_at, completed_at], index) => ({ id: 1000 + index, run_id: 222,
    name, conclusion, started_at, completed_at, status: 'completed', steps: index < 3 ? [{ status: 'completed', conclusion,
      name: index === 0 ? 'Wait for the existing collection' : 'Start and verify this collection' }] : null }))
  return { parentRunId: '333', firstRunId: '111', previousParentRunId: '222', completedSecondRunId: '444', checkpointRunId: '555',
    checkpointSourceSha: previous.head_sha, previousParent: previous, completedSecond: second, failedChild: failed,
    parents: { total_count: 2, workflow_runs: [structuredClone(previous), current] }, previousJobs: { total_count: 5, jobs },
    childRuns: { total_count: 4, workflow_runs: [...retries, structuredClone(second), structuredClone(failed)] } }
}

test('manual stage-three recovery preserves two complete stages and permits proven earlier transient attempts', () => {
  const f = recoveryFixture()
  assert.doesNotThrow(() => validateProductionRecovery(f))
  f.parents.workflow_runs.push({ ...run(99, '2026-11-01T01:00:00Z'), display_title: 'Sample survey production 111' }); f.parents.total_count++
  f.childRuns.workflow_runs.push({ ...f.failedChild, id: 888, created_at: '2026-11-04T01:00:01Z' }); f.childRuns.total_count++
  assert.doesNotThrow(() => validateProductionRecovery(f))
})

test('manual recovery rejects repeat parents, unproven completed stages, active children and any later pre-dispatch attempt', () => {
  const mutations: ((f: ReturnType<typeof recoveryFixture>) => void)[] = [
    f => { f.checkpointSourceSha = 'b'.repeat(40) }, f => { f.checkpointRunId = f.completedSecondRunId },
    f => { f.parents.workflow_runs[1].display_title = 'Sample survey production 111 recover 222 checkpoint 666' },
    f => { f.parents.workflow_runs[1].status = 'completed' }, f => { f.parents.workflow_runs[1].run_attempt = 2 },
    f => { f.parents.workflow_runs.push({ ...f.parents.workflow_runs[1], id: 999 }); f.parents.total_count++ },
    f => { f.parents.workflow_runs[0].head_sha = 'b'.repeat(40) },
    f => { f.previousParent.status = 'in_progress'; f.parents.workflow_runs[0].status = 'in_progress' },
    f => { f.previousJobs.jobs[1].conclusion = 'failure' }, f => { f.previousJobs.jobs[3].conclusion = 'success' },
    f => { f.previousJobs.jobs[2].started_at = '2026-11-02T05:53:00Z' },
    f => { f.previousJobs.jobs[2].steps![0].name = 'Unrelated failure' },
    f => { f.completedSecond.conclusion = 'failure'; f.childRuns.workflow_runs[2].conclusion = 'failure' },
    f => { f.failedChild.conclusion = 'success'; f.childRuns.workflow_runs[3].conclusion = 'success' },
    f => { f.childRuns.workflow_runs[0].status = 'in_progress' },
    f => { f.childRuns.workflow_runs[0].conclusion = 'success' },
    f => { f.childRuns.workflow_runs[0].display_title = 'Sample survey source ' + 'b'.repeat(40) },
    f => { f.childRuns.workflow_runs[0].updated_at = '2026-11-02T05:49:00Z' },
    f => { f.failedChild.updated_at = '2026-11-02T07:00:00Z'; f.childRuns.workflow_runs[3].updated_at = f.failedChild.updated_at },
    f => { f.childRuns.workflow_runs.push({ ...f.failedChild, id: 999, created_at: '2026-11-03T01:00:00Z', updated_at: '2026-11-03T02:00:00Z' }); f.childRuns.total_count++ },
    f => { f.childRuns.workflow_runs.splice(2, 1); f.childRuns.total_count-- },
    f => { f.childRuns.total_count++ }, f => { f.parents.total_count = 101 },
  ]
  for (const mutate of mutations) { const f = recoveryFixture(); mutate(f); assert.throws(() => validateProductionRecovery(f)) }
})

test('manual recovery inputs reach every serial parent job without granting the parent any secret', async () => {
  const workflow = await readFile(new URL('../../.github/workflows/sample-survey-production.yml', import.meta.url), 'utf8')
  assert.match(workflow, /format\('Sample survey production \{0\} recover \{1\} checkpoint \{2\}'/)
  for (const input of ['recovery_parent_run_id', 'recovery_checkpoint_run_id', 'completed_second_run_id', 'checkpoint_source_sha']) {
    assert.match(workflow, new RegExp(`      ${input}:`))
    for (let stage = 1; stage <= 5; stage++) {
      const section = workflow.split(`  stage-${stage}:`)[1].split(/\n  stage-\d:/)[0]
      assert.match(section, new RegExp(`PRODUCTION_${input.toUpperCase()}: \\$\\{\\{ inputs.${input} \\}\\}`))
    }
  }
  assert.doesNotMatch(workflow, /secrets\.|continue-on-error:|always\(\)/)
})
