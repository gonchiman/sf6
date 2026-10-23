import assert from 'node:assert/strict'
import test from 'node:test'
import { deflateRawSync } from 'node:zlib'
import { cloudConfig, DEFAULT_CLOUD_INTERVAL_OPTIONS } from '../../src/lib/parallelFetchCloud.ts'
import { createCloudGitHub, extractCloudReportZip, ParallelFetchCloudServiceError } from './parallel-fetch-github.ts'
import type { CloudGhCommand, CloudRemoteRun } from './parallel-fetch-github.ts'

const REQUEST = '12345678-1234-4123-8123-123456789abc'
const SECRET = 'arbitrary-private-github-output'
const TIME = '2026-10-21T00:00:00Z'
const remote = (): CloudRemoteRun => ({ runId: '123', runAttempt: 1, requestId: REQUEST, state: 'completed',
  startedAt: '2026-10-21T00:00:00.000Z', finishedAt: '2026-10-21T00:00:00.000Z', headSha: 'a'.repeat(40), conclusion: 'failure' })
const rawRun = () => ({ id: 123, run_attempt: 1, display_title: `Parallel fetch ${REQUEST}`, event: 'workflow_dispatch',
  head_branch: 'main', path: '.github/workflows/parallel-fetch-test.yml', status: 'completed', conclusion: 'failure',
  run_started_at: TIME, updated_at: TIME, head_sha: 'a'.repeat(40), repository: { full_name: 'gonchiman/sf6' }, head_repository: { full_name: 'gonchiman/sf6' } })
function zip(name: string, text: string): Buffer {
  const filename = Buffer.from(name), bytes = Buffer.from(text), packed = deflateRawSync(bytes)
  let crc = 0xffffffff
  for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0) }
  crc = (crc ^ 0xffffffff) >>> 0
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8)
  local.writeUInt32LE(crc, 14); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(bytes.length, 22); local.writeUInt16LE(filename.length, 26)
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6)
  central.writeUInt16LE(8, 10); central.writeUInt32LE(crc, 16); central.writeUInt32LE(packed.length, 20)
  central.writeUInt32LE(bytes.length, 24); central.writeUInt16LE(filename.length, 28)
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10)
  end.writeUInt32LE(central.length + filename.length, 12); end.writeUInt32LE(local.length + filename.length + packed.length, 16)
  return Buffer.concat([local, filename, packed, central, filename, end])
}
function report() {
  return { schemaVersion: 1, runId: 'cloud-123-1-serial', config: cloudConfig('serial'), state: 'error',
    startedAt: '2026-10-21T00:00:00.000Z', finishedAt: '2026-10-21T00:00:01.000Z', trials: [], errorCode: 'human-verification' }
}
function mocked(answer: (args: string[]) => unknown | Buffer) {
  const calls: { args: string[]; limit: number }[] = []
  const command: CloudGhCommand = async (args, limit) => {
    calls.push({ args, limit }); const value = answer(args)
    return Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value))
  }
  return { github: createCloudGitHub(command), calls }
}

test('dispatch and cancellation use fixed repository/workflow/main and separate bounded arguments', async () => {
  const f = mocked(() => Buffer.alloc(0))
  await f.github.dispatch('serial', REQUEST)
  assert.deepEqual(f.calls[0].args, ['workflow', 'run', 'parallel-fetch-test.yml', '--repo', 'gonchiman/sf6', '--ref', 'main',
    '--raw-field', 'mode=serial', '--raw-field', `request_id=${REQUEST}`])
  await f.github.cancel('123')
  assert.deepEqual(f.calls[1].args, ['api', '--hostname', 'github.com', '--method', 'POST', 'repos/gonchiman/sf6/actions/runs/123/cancel'])
  await assert.rejects(f.github.dispatch('serial', `--repo=${SECRET}`))
  await assert.rejects(f.github.cancel(`123/${SECRET}`))
  assert.equal(f.calls.length, 2)
})

test('readiness distinguishes missing gh, authentication failure and unavailable workflow', async () => {
  for (const [error, expected] of [['gh-unavailable', 'gh-unavailable'], ['github-unavailable', 'github-unavailable']] as const) {
    const github = createCloudGitHub(async () => { throw new ParallelFetchCloudServiceError(error) })
    assert.equal(await github.readiness(), expected)
  }
  const missing = mocked(args => args[0] === 'auth' ? Buffer.alloc(0) : { state: 'disabled_manually' })
  assert.equal(await missing.github.readiness(), 'workflow-unavailable')
  const ready = mocked(args => args[0] === 'auth' ? Buffer.alloc(0) : { state: 'active' })
  assert.equal(await ready.github.readiness(), 'ready')
})

test('correlation uses exact request run-name and rejects multiple matches or another repository', async () => {
  const f = mocked(args => args.at(-1)!.includes('/workflows/') ? { workflow_runs: [
    { ...rawRun(), id: 999, display_title: `Parallel fetch ${REQUEST}-extra` }, rawRun(),
  ] } : rawRun())
  assert.deepEqual(await f.github.findRun(REQUEST), remote())
  const duplicate = mocked(() => ({ workflow_runs: [rawRun(), { ...rawRun(), id: 999 }] }))
  await assert.rejects(duplicate.github.findRun(REQUEST), error => error instanceof ParallelFetchCloudServiceError && error.code === 'run-ambiguous')
  const wrong = mocked(() => ({ ...rawRun(), head_repository: { full_name: 'other/sf6' } }))
  await assert.rejects(wrong.github.getRun('123'))
})

test('known attempts use pinned endpoints and collecting requires the designated step', async () => {
  const f = mocked(args => args.at(-1)!.includes('/jobs?') ? { jobs: [{ steps: [
    { name: 'Run bounded collection test', status: 'in_progress' },
  ] }] } : { ...rawRun(), status: 'in_progress', conclusion: null })
  assert.equal((await f.github.getRun('123', 1)).state, 'collecting')
  assert.ok(f.calls[0].args.includes('repos/gonchiman/sf6/actions/runs/123/attempts/1'))
  assert.ok(f.calls[1].args.includes('repos/gonchiman/sf6/actions/runs/123/attempts/1/jobs?per_page=100'))
  const wrong = mocked(() => ({ ...rawRun(), run_attempt: 2 }))
  await assert.rejects(wrong.github.getRun('123', 1))
})

test('downloads only the exact artifact and imports a safe terminal report with matching identity', async () => {
  const name = 'parallel-fetch-cloud-123-1-serial', value = report()
  const f = mocked(args => args.at(-1)!.endsWith('/zip') ? zip(`${name}.json`, JSON.stringify({ ...value, cookies: SECRET })) : {
    artifacts: [{ id: 999, name: 'unrelated', size_in_bytes: 100, expired: false }, { id: 456, name, size_in_bytes: 100, expired: false }],
  })
  const result = await f.github.readReport(remote(), 'serial')
  assert.deepEqual(result, value)
  assert.equal(JSON.stringify(result).includes(SECRET), false)
  assert.ok(f.calls[1].args.includes('repos/gonchiman/sf6/actions/artifacts/456/zip'))
})

test('missing, expired, download and malformed artifacts have distinct fixed failures', async () => {
  const name = 'parallel-fetch-cloud-123-1-serial'
  for (const [artifacts, expected] of [[[], 'artifact-missing'], [[{ id: 456, name, expired: true, size_in_bytes: 100 }], 'artifact-expired']] as const) {
    const f = mocked(() => ({ artifacts }))
    await assert.rejects(f.github.readReport(remote(), 'serial'), error => error instanceof ParallelFetchCloudServiceError && error.code === expected)
    assert.equal(f.calls.length, 1)
  }
  for (const malformed of [Buffer.from(SECRET), zip('../escape.json', '{}'),
    zip(`${name}.json`, JSON.stringify({ ...report(), runId: 'cloud-123-2-serial' }))]) {
    const f = mocked(args => args.at(-1)!.endsWith('/zip') ? malformed : { artifacts: [{ id: 456, name, expired: false, size_in_bytes: 100 }] })
    await assert.rejects(f.github.readReport(remote(), 'serial'), error => error instanceof ParallelFetchCloudServiceError
      && error.code === 'invalid-report' && !error.message.includes(SECRET))
  }
  const failed = createCloudGitHub(async () => { throw new Error(SECRET) })
  await assert.rejects(failed.readReport(remote(), 'serial'), error => error instanceof ParallelFetchCloudServiceError && error.code === 'artifact-download-failed')
})

test('archive extraction rejects traversal, additional entries, oversized inflation and corruption', () => {
  const good = zip('report.json', '{"ok":true}')
  assert.equal(extractCloudReportZip(good, 'report.json').toString(), '{"ok":true}')
  const multiple = Buffer.from(good); multiple.writeUInt16LE(2, multiple.length - 14); multiple.writeUInt16LE(2, multiple.length - 12)
  const corrupt = Buffer.from(good); corrupt[45] ^= 1
  for (const value of [multiple, corrupt, zip('../report.json', '{}'), zip('report.json', 'x'.repeat(1024 * 1024 + 1))]) {
    assert.throws(() => extractCloudReportZip(value, 'report.json'), error => error instanceof ParallelFetchCloudServiceError && error.code === 'invalid-report')
  }
})

test('interval dispatch uses only canonical allowlisted inputs and rejects invalid options before gh', async () => {
  const f = mocked(() => Buffer.alloc(0))
  await f.github.dispatch('interval-compare', REQUEST, { intervalMsList: [3000, 5000], concurrencies: [2, 1], repetitions: 1 })
  assert.deepEqual(f.calls[0].args.slice(7), ['--raw-field', 'mode=interval-compare', '--raw-field', `request_id=${REQUEST}`,
    '--raw-field', 'intervals=5000,3000', '--raw-field', 'concurrencies=1,2', '--raw-field', 'repetitions=1'])
  await assert.rejects(f.github.dispatch('interval-compare', REQUEST))
  await assert.rejects(f.github.dispatch('interval-compare', REQUEST, { ...DEFAULT_CLOUD_INTERVAL_OPTIONS, repetitions: 3 }))
  await assert.rejects(f.github.dispatch('compare', REQUEST, DEFAULT_CLOUD_INTERVAL_OPTIONS))
  assert.equal(f.calls.length, 1)
})

test('interval artifacts must match the exact selected intervals, concurrencies and repetitions', async () => {
  const name = 'parallel-fetch-cloud-123-1-interval-compare', options = DEFAULT_CLOUD_INTERVAL_OPTIONS
  const value = { ...report(), schemaVersion: 2, runId: 'cloud-123-1-interval-compare', config: cloudConfig('interval-compare', options) }
  const f = mocked(args => args.at(-1)!.endsWith('/zip') ? zip(`${name}.json`, JSON.stringify(value))
    : { artifacts: [{ id: 456, name, size_in_bytes: 100, expired: false }] })
  assert.deepEqual(await f.github.readReport(remote(), 'interval-compare', options), value)
  for (const changed of [{ ...options, intervalMsList: [5000] as const }, { ...options, concurrencies: [1] as const }]) {
    await assert.rejects(f.github.readReport(remote(), 'interval-compare', structuredClone(changed) as never),
      error => error instanceof ParallelFetchCloudServiceError && error.code === 'invalid-report')
  }
  await assert.rejects(f.github.readReport(remote(), 'interval-compare'))
})
