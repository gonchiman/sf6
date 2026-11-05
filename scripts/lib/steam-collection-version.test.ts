import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { reportSteamCollectionVersion, steamCollectionVersion, STEAM_COLLECTION_VERSION } from './steam-collection-version.ts'
import type { SteamCollectionComponent } from './steam-collection-version.ts'
import { STEAM_COLLECTION_HISTORY, STEAM_COLLECTION_VERSION as browserVersion } from '../../src/lib/steamCollectionVersion.ts'

const sourceSha = 'a'.repeat(40)
const privateValue = 'private-token-must-not-appear'
const components: SteamCollectionComponent[] = ['dispatcher', 'collector', 'publisher']
const cli = fileURLToPath(new URL('./steam-collection-version.ts', import.meta.url))
const child = (args: string[], env: Record<string, string | undefined> = {}) => spawnSync(process.execPath, [cli, ...args], {
  encoding: 'utf8', windowsHide: true, timeout: 10_000,
  env: { ...process.env, GITHUB_ACTIONS: 'false', GITHUB_STEP_SUMMARY: '', ...env },
})

test('the browser and CLI share the current version and documented implementation history', async () => {
  assert.equal(browserVersion, STEAM_COLLECTION_VERSION)
  assert.equal(STEAM_COLLECTION_HISTORY[0].version, STEAM_COLLECTION_VERSION)
  assert.equal(STEAM_COLLECTION_HISTORY[0].retrospective, false)
  assert.equal(new Set(STEAM_COLLECTION_HISTORY.map(release => release.version)).size, STEAM_COLLECTION_HISTORY.length)
  const changelog = await readFile(new URL('../../docs/steam-player-count/CHANGELOG.md', import.meta.url), 'utf8')
  let previousReleaseStart = Infinity
  const commitShas = new Set<string>()
  for (const release of STEAM_COLLECTION_HISTORY) {
    assert.ok(release.changes.length > 0)
    assert.ok(changelog.includes(`## ${release.version} —`))
    let previousChangeAt = 0
    for (const change of release.changes) {
      assert.match(change.commitSha, /^[0-9a-f]{40}$/)
      assert.ok(!commitShas.has(change.commitSha), 'each implementation commit must appear once')
      commitShas.add(change.commitSha)
      assert.match(change.committedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+09:00$/)
      const committedAt = Date.parse(change.committedAt)
      assert.ok(Number.isFinite(committedAt) && committedAt >= previousChangeAt)
      assert.ok(committedAt < previousReleaseStart, 'release histories must not overlap')
      previousChangeAt = committedAt
      assert.ok(changelog.includes(`/commit/${change.commitSha})`), `undocumented commit: ${change.commitSha}`)
      assert.ok(changelog.includes(change.committedAt.slice(0, 19).replace('T', ' ')), 'commit time must match the documented JST time')
      assert.ok(changelog.includes(change.summary), 'the short history must agree with the changelog')
    }
    previousReleaseStart = Date.parse(release.changes[0].committedAt)
  }
  assert.equal(STEAM_COLLECTION_HISTORY.find(release => release.version === 'v2')?.changes.length, 2,
    'v2 records its behavior change and the later version-reporting introduction separately')
})

test('component reports preserve previous summary content and identify each checked-out job separately', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'steam-version-'))
  try {
    const summary = join(directory, 'summary.md'), logs: string[] = []
    await writeFile(summary, 'Previous job details\n')
    for (const component of components) await reportSteamCollectionVersion(component, {
      env: { GITHUB_ACTIONS: 'true', GITHUB_SHA: sourceSha, GITHUB_STEP_SUMMARY: summary,
        GH_TOKEN: privateValue, GITHUB_TOKEN: privateValue }, write: value => logs.push(value),
    })
    assert.deepEqual(logs.map(value => JSON.parse(value)), components.map(component => ({
      event: 'steam-collection-version', component, processVersion: STEAM_COLLECTION_VERSION, codeSha: sourceSha,
    })))
    const content = await readFile(summary, 'utf8')
    assert.ok(content.startsWith('Previous job details\n'))
    for (const label of ['起動役', '取得', '履歴保存']) assert.ok(content.includes(`| ${label} | ${STEAM_COLLECTION_VERSION} |`))
    assert.equal(content.match(new RegExp(sourceSha, 'g'))?.length, 3)
    assert.ok(!content.includes(privateValue) && logs.every(value => !value.includes(privateValue)))
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('unverified SHA values never leak into report logs or Markdown', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'steam-version-'))
  try {
    const summary = join(directory, 'summary.md'), logs: string[] = []
    for (const value of [undefined, '', 'main', 'a'.repeat(39), 'a'.repeat(41), 'A'.repeat(40),
      `${sourceSha}\n`, `${sourceSha}\r\n`, `${sourceSha}\n${privateValue}`, `[${privateValue}](https://example.com)`]) {
      await reportSteamCollectionVersion('collector', { env: { GITHUB_ACTIONS: 'true', GITHUB_SHA: value,
        GITHUB_STEP_SUMMARY: summary, GH_TOKEN: privateValue }, write: message => logs.push(message) })
    }
    assert.ok(logs.every(value => JSON.parse(value).codeSha === null))
    const output = logs.join('\n') + await readFile(summary, 'utf8')
    assert.ok(output.includes('未確認'))
    assert.ok(!output.includes(privateValue))
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('local reports ignore inherited Actions paths and SHA without modifying files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'steam-version-'))
  try {
    const summary = join(directory, 'summary.md'), logs: string[] = []
    await writeFile(summary, 'untouched\n')
    for (const actions of [undefined, '', 'false']) await reportSteamCollectionVersion('publisher', {
      env: { GITHUB_ACTIONS: actions, GITHUB_SHA: sourceSha, GITHUB_STEP_SUMMARY: summary },
      write: message => logs.push(message),
    })
    assert.equal(await readFile(summary, 'utf8'), 'untouched\n')
    assert.ok(logs.every(value => JSON.parse(value).codeSha === null))
    await reportSteamCollectionVersion('publisher', { env: { GITHUB_SHA: sourceSha,
      GITHUB_STEP_SUMMARY: join(directory, 'missing', 'summary.md') }, write: () => {} })
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('the CLI reports all components and writes Actions summaries without collecting data', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'steam-version-'))
  try {
    const summary = join(directory, 'summary.md')
    for (const component of components) {
      const result = child([component], { GITHUB_ACTIONS: 'true', GITHUB_SHA: sourceSha,
        GITHUB_STEP_SUMMARY: summary, GH_TOKEN: privateValue })
      assert.equal(result.error, undefined)
      assert.equal(result.status, 0, result.stderr)
      assert.equal(result.stderr, '')
      assert.deepEqual(JSON.parse(result.stdout), { event: 'steam-collection-version', component,
        processVersion: STEAM_COLLECTION_VERSION, codeSha: sourceSha })
      assert.ok(!result.stdout.includes(privateValue))
    }
    assert.equal((await readFile(summary, 'utf8')).match(/### Steam取得処理/g)?.length, 3)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('CLI version lookup has no summary side effects and rejects arbitrary arguments without echoing them', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'steam-version-'))
  try {
    const summary = join(directory, 'summary.md')
    await writeFile(summary, 'untouched\n')
    const env = { GITHUB_ACTIONS: 'true', GITHUB_STEP_SUMMARY: summary, GH_TOKEN: privateValue }
    const result = child(['--version'], env)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout.trim(), STEAM_COLLECTION_VERSION)
    assert.match(result.stdout.trim(), /^v[1-9]\d*$/)
    assert.equal(result.stderr, '')
    for (const args of [[], [privateValue], ['__proto__'], ['constructor'], ['--version', privateValue], ['collector', privateValue]]) {
      const invalid = child(args, env)
      assert.equal(invalid.status, 1)
      assert.equal(invalid.stdout, '')
      assert.match(invalid.stderr, /指定:/)
      assert.ok(!invalid.stderr.includes(privateValue))
    }
    assert.equal(await readFile(summary, 'utf8'), 'untouched\n')
    assert.throws(() => steamCollectionVersion(privateValue as SteamCollectionComponent), error =>
      error instanceof Error && !error.message.includes(privateValue))
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('CLI summary failures expose a fixed error rather than the private filesystem path', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'steam-version-'))
  try {
    const result = child(['dispatcher'], { GITHUB_ACTIONS: 'true', GITHUB_SHA: sourceSha,
      GITHUB_STEP_SUMMARY: join(directory, privateValue, 'summary.md') })
    assert.equal(result.status, 1)
    assert.equal(JSON.parse(result.stdout).processVersion, STEAM_COLLECTION_VERSION)
    assert.match(result.stderr, /Steam取得処理の版を記録できませんでした/)
    assert.ok(!result.stderr.includes(privateValue))
  } finally { await rm(directory, { recursive: true, force: true }) }
})
