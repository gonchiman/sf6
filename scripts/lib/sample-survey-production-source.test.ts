import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runInNewContext } from 'node:vm'
import { sampleSurveySourceSelection, verifySampleSurveySource, parseSampleSurveyRecovery, SampleSurveySourceError } from './sample-survey-production-source.ts'

const SOURCE = 'a'.repeat(40), RUN = 'b'.repeat(40), BLOB = 'c'.repeat(40)
const WORKFLOW = '.github/workflows/sample-survey.yml', PRIVATE = 'raw-command-secret'
const environment = (overrides: Record<string, string | undefined> = {}) => ({
  GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Windows',
  GITHUB_REPOSITORY: 'gonchiman/sf6', GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_WORKFLOW_REF: 'gonchiman/sf6/.github/workflows/sample-survey.yml@refs/heads/main',
  GITHUB_SHA: RUN, SAMPLE_SURVEY_SOURCE_SHA: SOURCE, ...overrides,
})
const expectedError = (code: SampleSurveySourceError['code']) => (error: unknown) => {
  assert.ok(error instanceof SampleSurveySourceError)
  assert.equal(error.code, code)
  assert.ok(!error.message.includes(PRIVATE))
  return true
}

test('manual auth recovery binds the old checkpoint revision to an explicit request and ancestor check', async () => {
  const previous = 'd'.repeat(40), f = fixture()
  const env = environment({ GITHUB_SHA: SOURCE, SAMPLE_SURVEY_RECOVER_AUTHENTICATION: 'true',
    SAMPLE_SURVEY_RESUME_SOURCE_SHA: previous, SAMPLE_SURVEY_RESUME_RUN_ID: '123' })
  assert.deepEqual(parseSampleSurveyRecovery(env), { recoverAuthentication: true, resumeSourceSha: previous })
  await verifySampleSurveySource({ env, git: f.git })
  assert.ok(f.calls.some(args => args.join(' ') === `merge-base --is-ancestor ${previous} ${SOURCE}`))
  await assert.rejects(verifySampleSurveySource({ env, git: fixture('merge-base').git }), expectedError('ancestry'))
  for (const change of [{ SAMPLE_SURVEY_RECOVER_AUTHENTICATION: 'false' }, { SAMPLE_SURVEY_RECOVER_AUTHENTICATION: 'yes' },
    { SAMPLE_SURVEY_RESUME_SOURCE_SHA: 'main' }, { SAMPLE_SURVEY_RESUME_RUN_ID: '' }, { SAMPLE_SURVEY_RESUME_SOURCE_SHA: '' }]) {
    const calls = fixture()
    await assert.rejects(verifySampleSurveySource({ env: { ...env, ...change }, git: calls.git }), expectedError('source'))
    assert.equal(calls.calls.length, 0)
  }
})
function fixture(failAt?: string) {
  const calls: string[][] = []
  return { calls, git: async (args: string[]) => {
    calls.push(args)
    if (args[0] === failAt) throw new Error(PRIVATE)
    return args[0] === 'rev-parse' ? args[2] === 'HEAD' ? SOURCE : BLOB : ''
  } }
}

test('manual defaults select the execution revision and avoid another Git fetch', async () => {
  for (const value of [undefined, '']) {
    const f = fixture(), env = environment({ GITHUB_SHA: SOURCE, SAMPLE_SURVEY_SOURCE_SHA: value })
    assert.deepEqual(sampleSurveySourceSelection(env), { sourceSha: SOURCE, runSha: SOURCE })
    assert.deepEqual(await verifySampleSurveySource({ env, git: f.git }), { sourceSha: SOURCE, runSha: SOURCE })
    assert.deepEqual(f.calls, [['rev-parse', '--verify', 'HEAD'], ['rev-parse', '--verify', `${SOURCE}:${WORKFLOW}`]])
  }
})

test('an unrelated main update preserves the pinned source after ancestry and workflow checks', async () => {
  const f = fixture()
  assert.deepEqual(await verifySampleSurveySource({ env: environment(), git: f.git }), { sourceSha: SOURCE, runSha: RUN })
  assert.deepEqual(f.calls, [
    ['rev-parse', '--verify', 'HEAD'], ['rev-parse', '--verify', `${SOURCE}:${WORKFLOW}`],
    ['cat-file', '-t', RUN],
    ['fetch', '--no-tags', '--filter=blob:none', '--depth=1000', 'https://github.com/gonchiman/sf6.git', RUN],
    ['merge-base', '--is-ancestor', SOURCE, RUN], ['rev-parse', '--verify', `${RUN}:${WORKFLOW}`],
  ])
})

test('the source helper reuses history already fetched by the trusted workflow gate', async () => {
  const f = fixture()
  await verifySampleSurveySource({ env: environment(), git: async args => args[0] === 'cat-file' ? 'commit' : f.git(args) })
  assert.ok(!f.calls.some(args => args[0] === 'fetch'))
  assert.ok(f.calls.some(args => args[0] === 'merge-base'))
})

for (const input of ['refs/heads/main', '../source', '--upload-pack=bad', 'https://example.com/repo', 'A'.repeat(40), '0'.repeat(39), `${SOURCE}\n`, ' ']) {
  test(`rejects untrusted source expression ${JSON.stringify(input)} before Git`, async () => {
    const f = fixture()
    await assert.rejects(verifySampleSurveySource({ env: environment({ SAMPLE_SURVEY_SOURCE_SHA: input }), git: f.git }), expectedError('source'))
    assert.equal(f.calls.length, 0)
    await assert.rejects(verifySampleSurveySource({ env: environment({ GITHUB_SHA: input }), git: f.git }), expectedError('source'))
    assert.equal(f.calls.length, 0)
  })
}

test('source verification remains restricted to the normal hosted manual main workflow', async () => {
  for (const change of [{ GITHUB_ACTIONS: 'false' }, { RUNNER_ENVIRONMENT: 'self-hosted' }, { RUNNER_OS: 'Linux' },
    { GITHUB_REPOSITORY: 'other/sf6' }, { GITHUB_REF: 'refs/heads/feature' }, { GITHUB_EVENT_NAME: 'pull_request' },
    { GITHUB_WORKFLOW_REF: 'gonchiman/sf6/.github/workflows/other.yml@refs/heads/main' }]) {
    const f = fixture()
    await assert.rejects(verifySampleSurveySource({ env: environment(change), git: f.git }), expectedError('environment'))
    assert.equal(f.calls.length, 0)
  }
})

test('a checkout mismatch stops before remote access or workflow acceptance', async () => {
  const f = fixture()
  await assert.rejects(verifySampleSurveySource({ env: environment(), git: async args => {
    const result = await f.git(args); return args[2] === 'HEAD' ? RUN : result
  } }), expectedError('checkout'))
  assert.equal(f.calls.length, 1)
})

test('a changed workflow is rejected even when main descends from the pinned source', async () => {
  const f = fixture()
  await assert.rejects(verifySampleSurveySource({ env: environment(), git: async args => {
    const result = await f.git(args); return args[2] === `${RUN}:${WORKFLOW}` ? 'd'.repeat(40) : result
  } }), expectedError('workflow'))
  assert.equal(f.calls.length, 6)
})

for (const [command, code, count] of [['rev-parse', 'checkout', 1], ['fetch', 'ancestry', 4], ['merge-base', 'ancestry', 5]] as const) {
  test(`${command} failure stops without exposing raw errors or attempting later checks`, async () => {
    const f = fixture(command)
    await assert.rejects(verifySampleSurveySource({ env: environment(), git: f.git }), expectedError(code))
    assert.equal(f.calls.length, count)
  })
}

test('real Git object ancestry and blobs accept unrelated changes, ignore checkout newline differences and reject a workflow change', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sf6-source-verification-'))
  t.after(async () => { await rm(directory, { recursive: true, force: true }) })
  const execute = promisify(execFile)
  const git = async (args: string[]) => (await execute('git', ['-C', directory, ...args], { windowsHide: true })).stdout.trim()
  await git(['init', '--initial-branch=main'])
  await git(['config', 'user.name', 'Synthetic test'])
  await git(['config', 'user.email', 'synthetic@example.invalid'])
  await git(['config', 'core.autocrlf', 'false'])
  await mkdir(join(directory, '.github/workflows'), { recursive: true })
  await writeFile(join(directory, WORKFLOW), 'name: Collect sample survey\non: workflow_dispatch\n')
  await writeFile(join(directory, 'collector.txt'), 'original collector\n')
  await git(['add', '.']); await git(['commit', '-m', 'source'])
  const source = await git(['rev-parse', 'HEAD'])
  await writeFile(join(directory, 'unrelated-ui.txt'), 'new screen\n')
  await writeFile(join(directory, 'collector.txt'), 'new collector not selected by this run\n')
  await git(['add', '.']); await git(['commit', '-m', 'main changes'])
  const unrelated = await git(['rev-parse', 'HEAD'])
  await writeFile(join(directory, WORKFLOW), 'name: Different workflow\non: workflow_dispatch\n')
  await git(['add', '.']); await git(['commit', '-m', 'workflow change'])
  const changed = await git(['rev-parse', 'HEAD'])
  await git(['checkout', '--detach', source])
  await writeFile(join(directory, WORKFLOW), 'name: Collect sample survey\r\non: workflow_dispatch\r\n')
  const noNetworkGit = async (args: string[]) => args[0] === 'fetch' ? '' : git(args)
  assert.deepEqual(await verifySampleSurveySource({ env: environment({ SAMPLE_SURVEY_SOURCE_SHA: source, GITHUB_SHA: unrelated }), git: noNetworkGit }),
    { sourceSha: source, runSha: unrelated })
  assert.equal(await readFile(join(directory, 'collector.txt'), 'utf8'), 'original collector\n')
  await assert.rejects(verifySampleSurveySource({ env: environment({ SAMPLE_SURVEY_SOURCE_SHA: source, GITHUB_SHA: changed }), git: noNetworkGit }), expectedError('workflow'))
  await assert.rejects(verifySampleSurveySource({ env: environment({ SAMPLE_SURVEY_SOURCE_SHA: unrelated, GITHUB_SHA: source }),
    git: async args => args[0] === 'rev-parse' && args[2] === 'HEAD' ? unrelated : noNetworkGit(args) }), expectedError('ancestry'))
})

test('both workflow jobs validate and pin source before session or publishing credentials', async () => {
  const workflow = await readFile(new URL('../../.github/workflows/sample-survey.yml', import.meta.url), 'utf8')
  assert.match(workflow, /run-name:.*Sample survey source \{0\}/)
  assert.match(workflow, /source_sha:\s+description:[\s\S]*?default: ''/)
  assert.equal((workflow.match(/ref: \$\{\{ inputs\.source_sha \|\| github\.sha \}\}/g) ?? []).length, 2)
  const collect = workflow.slice(workflow.indexOf('  collect:'), workflow.indexOf('  save-history:'))
  const publisher = workflow.slice(workflow.indexOf('  save-history:'))
  for (const [job, credential] of [[collect, 'BUCKLER_WEEKLY_SESSION:'], [publisher, 'GH_TOKEN:']]) {
    const validate = job.indexOf("-cnotmatch '^[a-f0-9]{40}$'")
    const checkout = job.indexOf('uses: actions/checkout@')
    const trustedGuard = job.indexOf('- name: Verify source trust from the running workflow')
    const guard = job.indexOf('run: node scripts/lib/sample-survey-production-source.ts')
    assert.ok(validate > 0 && validate < checkout && checkout < trustedGuard && trustedGuard < guard && guard < job.indexOf(credential))
    assert.ok(!job.slice(0, guard).includes('secrets.'))
  }
  assert.match(collect, /node --test[^\n]*sample-survey-production-source\.test\.ts/)
})

test('both trusted inline gates reject arbitrary source code before invoking it and use bounded credential-free Git', async () => {
  const workflow = await readFile(new URL('../../.github/workflows/sample-survey.yml', import.meta.url), 'utf8')
  const gates = [...workflow.matchAll(/- name: Verify source trust from the running workflow\r?\n[\s\S]*?        run: \|\r?\n([\s\S]*?)(?=      - name:)/g)]
    .map(match => match[1].split(/\r?\n/).map(line => line.slice(10)).join('\n').trim())
  assert.equal(gates.length, 2)
  for (const gate of gates) for (const kind of ['manual', 'unrelated-main', 'invalid', 'wrong-checkout', 'not-ancestor', 'workflow-changed']) {
    const calls: string[][] = [], runSha = kind === 'manual' ? SOURCE : RUN
    const env = { GITHUB_SHA: runSha, SAMPLE_SURVEY_SOURCE_SHA: kind === 'invalid' ? '--bad' : SOURCE,
      GH_TOKEN: PRIVATE, BUCKLER_WEEKLY_SESSION: PRIVATE, harmless: 'kept' }
    const execute = () => runInNewContext(gate, { process: { env }, require: (name: string) => {
      assert.equal(name, 'node:child_process')
      return { execFileSync: (file: string, args: string[], options: Record<string, unknown>) => {
        assert.equal(file, 'git'); assert.deepEqual(Array.from(args.slice(0, 4)), ['-c', 'credential.helper=', '-c', 'core.askPass='])
        assert.equal(options.shell, false); assert.equal(options.timeout, 120000); assert.equal(options.maxBuffer, 65536)
        const childEnv = options.env as Record<string, string>
        assert.equal(childEnv.GH_TOKEN, undefined); assert.equal(childEnv.BUCKLER_WEEKLY_SESSION, undefined)
        assert.equal(childEnv.GIT_TERMINAL_PROMPT, '0'); assert.equal(childEnv.harmless, 'kept')
        const command = Array.from(args.slice(4)); calls.push(command)
        if (command[0] === 'fetch') assert.deepEqual(command, ['fetch', '--no-tags', '--filter=blob:none', '--depth=1000', 'https://github.com/gonchiman/sf6.git', RUN])
        if (command[0] === 'merge-base' && kind === 'not-ancestor') throw new Error(PRIVATE)
        if (command[0] === 'rev-parse') return command[2] === 'HEAD' ? kind === 'wrong-checkout' ? RUN : SOURCE
          : command[2] === `${RUN}:${WORKFLOW}` && kind === 'workflow-changed' ? 'd'.repeat(40) : BLOB
        return ''
      } }
    } })
    if (kind === 'manual' || kind === 'unrelated-main') execute()
    else assert.throws(execute, error => { assert.ok(!String(error).includes(PRIVATE)); return true })
    if (kind === 'invalid') assert.equal(calls.length, 0)
    if (kind === 'manual') assert.equal(calls.length, 2)
    if (kind === 'unrelated-main') assert.equal(calls.length, 5)
    if (kind === 'wrong-checkout') assert.equal(calls.length, 1)
  }
})
