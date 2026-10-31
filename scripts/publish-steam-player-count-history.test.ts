import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { publishSteamPlayerCountHistory, STEAM_HISTORY_BRANCH, STEAM_HISTORY_REMOTE } from './publish-steam-player-count-history.ts'

const env = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Linux', GITHUB_REPOSITORY: 'gonchiman/sf6',
  GITHUB_REF: 'refs/heads/main', GITHUB_WORKFLOW_REF: 'gonchiman/sf6/.github/workflows/steam-player-count.yml@refs/heads/main',
  GITHUB_EVENT_NAME: 'schedule', GH_TOKEN: 'synthetic-test-token', GIT_DIR: 'ignored-external-directory' }

async function setup(t: TestContext, options: { failures?: number; alreadyPresent?: boolean; wrongBranch?: boolean; newBranch?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'sf6-steam-git-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const calls: string[][] = [], inputs: string[] = []
  let pushes = 0, publications = 0, seeds = 0
  const dependencies = { root, env,
    git: async (args: string[], directory: string, environment: Record<string, string | undefined>) => {
      calls.push(args)
      assert.equal(environment.GH_TOKEN, undefined)
      assert.equal(environment.GIT_DIR, undefined)
      if (args[0] === 'push') {
        assert.match(environment.GIT_CONFIG_VALUE_0!, /^AUTHORIZATION: basic /)
        pushes++
        assert.deepEqual(args, ['push', 'origin', `HEAD:refs/heads/${STEAM_HISTORY_BRANCH}`])
        return { code: pushes <= (options.failures ?? 0) ? 1 : 0, stdout: '' }
      }
      assert.equal(environment.GIT_CONFIG_VALUE_0, undefined)
      if (args[0] === 'rev-parse') return { code: 0, stdout: directory }
      if (args[0] === 'symbolic-ref') return { code: 0, stdout: options.wrongBranch ? 'main' : STEAM_HISTORY_BRANCH }
      if (args[0] === 'remote' && args[1] === 'get-url') return { code: 0, stdout: STEAM_HISTORY_REMOTE }
      if (args[0] === 'ls-remote') return { code: 0, stdout: options.newBranch ? '' : `${'a'.repeat(40)}\trefs/heads/${STEAM_HISTORY_BRANCH}` }
      if (args[0] === 'diff') return { code: options.alreadyPresent && publications > 1 ? 0 : 1, stdout: '' }
      return { code: 0, stdout: '' }
    },
    publish: async (input: string) => { inputs.push(input); publications++; return { changed: true, observations: publications, days: 1 } },
    seed: async (source: string, destination: string) => {
      seeds++
      assert.equal(source, join(root, 'public/data/steam-player-count'))
      assert.ok(destination.endsWith(`${join('', 'public')}`))
    },
  }
  return { dependencies, calls, inputs, seedCount: () => seeds, counts: () => ({ pushes, publications }) }
}

test('rejected push reloads the latest branch and replays the same retained observation', async t => {
  const f = await setup(t, { failures: 1 })
  await publishSteamPlayerCountHistory(f.dependencies)
  assert.deepEqual(f.counts(), { pushes: 2, publications: 2 })
  assert.equal(new Set(f.inputs).size, 1)
  assert.match(f.inputs[0], /incoming[\\/]observation\.json$/)
  assert.equal(f.calls.filter(args => args[0] === 'fetch').length, 2)
  assert.equal(f.calls.filter(args => args[0] === 'reset').length, 2)
  assert.ok(f.calls.every(args => !args.includes('--force') && !args.includes('main')))
  assert.equal(f.seedCount(), 0)
})

test('lost push acknowledgement recognizes the remote observation without rewriting it', async t => {
  const f = await setup(t, { failures: 1, alreadyPresent: true })
  await publishSteamPlayerCountHistory(f.dependencies)
  assert.deepEqual(f.counts(), { pushes: 1, publications: 2 })
})

test('only a missing remote branch is initialized from the bundled history, once across push retries', async t => {
  const f = await setup(t, { newBranch: true, failures: 1 })
  await publishSteamPlayerCountHistory(f.dependencies)
  assert.equal(f.seedCount(), 1)
  assert.deepEqual(f.counts(), { pushes: 2, publications: 2 })
})

test('persistent publication failure exhausts a bounded retry and surfaces recovery action', async t => {
  const f = await setup(t, { failures: 10 })
  await assert.rejects(publishSteamPlayerCountHistory(f.dependencies), /artifact/)
  assert.deepEqual(f.counts(), { pushes: 3, publications: 3 })
})

test('refuses an unexpected branch and rejects unauthorized execution before any Git operation', async t => {
  const f = await setup(t, { wrongBranch: true })
  await assert.rejects(publishSteamPlayerCountHistory(f.dependencies), /公開先/)
  assert.deepEqual(f.counts(), { pushes: 0, publications: 0 })
  await assert.rejects(publishSteamPlayerCountHistory({ env: {}, git: async () => assert.fail('must not invoke Git') }), /workflow/)
})

test('workflow separates collection from queued publishing and retains the original artifact name on publisher reruns', async () => {
  const workflow = await readFile(new URL('../.github/workflows/steam-player-count.yml', import.meta.url), 'utf8')
  assert.match(workflow, /cron: '7,22,37,52 \* \* \* \*'/)
  assert.match(workflow, /queue: max/)
  assert.match(workflow, /needs\.collect\.outputs\.artifact_name/)
  assert.match(workflow, /artifact_name: \$\{\{ steps\.artifact-name\.outputs\.name \}\}/)
  assert.match(workflow, /node-version: 24/)
  assert.doesNotMatch(workflow, /deploy-pages|pages: write|npm ci|BUCKLER|secrets\./)
  const [collection, publisher] = workflow.split('  save-history:')
  assert.doesNotMatch(collection, /contents: write|concurrency:/)
  assert.match(publisher, /contents: write/)
})
