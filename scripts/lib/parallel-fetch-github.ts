import { spawn } from 'node:child_process'
import { inflateRawSync } from 'node:zlib'
import { parseParallelFetchReport } from '../../src/lib/parallelFetch.ts'
import { cloudConfig } from '../../src/lib/parallelFetchCloud.ts'
import type { ParallelFetchReport } from '../../src/types/parallelFetch.ts'
import type { CloudError, CloudMode } from '../../src/types/parallelFetchCloud.ts'
import { cloudSecretEnvironment } from '../send-buckler-cloud-session.ts'

const REPO = 'repos/gonchiman/sf6'
const WORKFLOW = 'parallel-fetch-test.yml'
const JSON_LIMIT = 1024 * 1024
const METADATA_LIMIT = 4 * 1024 * 1024
const ZIP_LIMIT = 2 * JSON_LIMIT
export class ParallelFetchCloudServiceError extends Error {
  readonly code: CloudError | 'gh-unavailable'
  constructor(code: CloudError | 'gh-unavailable') { super(code); this.name = 'ParallelFetchCloudServiceError'; this.code = code }
}
export interface CloudRemoteRun {
  runId: string
  runAttempt: number
  requestId: string
  state: 'queued' | 'preparing' | 'collecting' | 'completed'
  startedAt: string | null
  finishedAt: string | null
  headSha: string | null
  conclusion: string | null
}
export interface CloudGitHub {
  readiness(): Promise<'ready' | 'gh-unavailable' | 'github-unavailable' | 'workflow-unavailable'>
  dispatch(mode: CloudMode, requestId: string): Promise<void>
  findRun(requestId: string): Promise<CloudRemoteRun | null>
  getRun(runId: string, attempt?: number): Promise<CloudRemoteRun>
  cancel(runId: string): Promise<void>
  readReport(run: CloudRemoteRun, mode: CloudMode): Promise<ParallelFetchReport>
}
export type CloudGhCommand = (args: string[], limit: number) => Promise<Buffer>

/** Fixed executable, argument arrays and a bounded, non-logging pipe. */
export const runCloudGhCommand: CloudGhCommand = (args, limit) => new Promise((resolve, reject) => {
  let settled = false, size = 0
  const chunks: Buffer[] = []
  const child = spawn('gh', args, { shell: false, windowsHide: true, env: cloudSecretEnvironment(process.env), stdio: ['ignore', 'pipe', 'ignore'] })
  const timer = setTimeout(() => finish('github-unavailable'), 30000)
  timer.unref()
  function finish(error?: CloudError | 'gh-unavailable'): void {
    if (settled) return
    settled = true; clearTimeout(timer)
    if (error) { child.kill(); reject(new ParallelFetchCloudServiceError(error)) }
    else resolve(Buffer.concat(chunks))
  }
  child.on('error', error => finish('code' in error && error.code === 'ENOENT' ? 'gh-unavailable' : 'github-unavailable'))
  child.on('close', code => finish(code === 0 ? undefined : 'github-unavailable'))
  child.stdout.on('data', (chunk: Buffer) => {
    size += chunk.length
    if (size > limit) finish('github-unavailable')
    else chunks.push(Buffer.from(chunk))
  })
})

function fail(code: CloudError): never { throw new ParallelFetchCloudServiceError(code) }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('github-unavailable')
  return value as Record<string, unknown>
}
function id(value: unknown): string {
  const text = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value
  if (typeof text !== 'string' || !/^[1-9]\d{0,24}$/.test(text)) return fail('github-unavailable')
  return text
}
function uuid(value: string): void { if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value)) fail('invalid-request') }
function timestamp(value: unknown): string | null {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null
}
function parseRemoteRun(value: unknown): CloudRemoteRun {
  const input = object(value)
  if (input.event !== 'workflow_dispatch' || input.head_branch !== 'main'
    || object(input.repository).full_name !== 'gonchiman/sf6' || object(input.head_repository).full_name !== 'gonchiman/sf6'
    || ![`.github/workflows/${WORKFLOW}`, `.github/workflows/${WORKFLOW}@refs/heads/main`].includes(String(input.path))) return fail('run-ambiguous')
  const requestId = typeof input.display_title === 'string' ? /^Parallel fetch ([a-f0-9-]{36})$/.exec(input.display_title)?.[1] : undefined
  if (!requestId) return fail('run-ambiguous')
  uuid(requestId)
  if (!Number.isSafeInteger(input.run_attempt) || Number(input.run_attempt) < 1 || Number(input.run_attempt) > 999999) return fail('run-ambiguous')
  const conclusion = ['success', 'failure', 'cancelled', 'timed_out', 'action_required', 'neutral', 'skipped', 'stale', 'startup_failure'].includes(String(input.conclusion))
    ? String(input.conclusion) : null
  return { runId: id(input.id), runAttempt: Number(input.run_attempt), requestId,
    state: input.status === 'completed' ? 'completed' : input.status === 'in_progress' ? 'preparing' : 'queued',
    startedAt: timestamp(input.run_started_at), finishedAt: input.status === 'completed' ? timestamp(input.updated_at) : null,
    headSha: typeof input.head_sha === 'string' && /^[a-f0-9]{40}$/.test(input.head_sha) ? input.head_sha : null, conclusion }
}

/** Extract exactly one bounded JSON entry in memory; no untrusted archive paths reach disk. */
export function extractCloudReportZip(zip: Buffer, expected: string): Buffer {
  try {
    if (zip.length < 22 || zip.length > ZIP_LIMIT) throw new Error()
    let end = -1
    for (let offset = zip.length - 22; offset >= Math.max(0, zip.length - 65557); offset--) {
      if (zip.readUInt32LE(offset) === 0x06054b50 && offset + 22 + zip.readUInt16LE(offset + 20) === zip.length) { end = offset; break }
    }
    if (end < 0 || zip.readUInt16LE(end + 4) !== 0 || zip.readUInt16LE(end + 6) !== 0
      || zip.readUInt16LE(end + 8) !== 1 || zip.readUInt16LE(end + 10) !== 1) throw new Error()
    const central = zip.readUInt32LE(end + 16), centralSize = zip.readUInt32LE(end + 12)
    if (central + centralSize !== end || centralSize < 46 || zip.readUInt32LE(central) !== 0x02014b50) throw new Error()
    const flags = zip.readUInt16LE(central + 8), method = zip.readUInt16LE(central + 10)
    const crc = zip.readUInt32LE(central + 16), compressed = zip.readUInt32LE(central + 20), uncompressed = zip.readUInt32LE(central + 24)
    const nameLength = zip.readUInt16LE(central + 28), extraLength = zip.readUInt16LE(central + 30), commentLength = zip.readUInt16LE(central + 32)
    const local = zip.readUInt32LE(central + 42)
    const decode = (bytes: Buffer): string => new TextDecoder('utf8', { fatal: true }).decode(bytes)
    if (flags & 1 || ![0, 8].includes(method) || uncompressed < 1 || uncompressed > JSON_LIMIT || compressed > ZIP_LIMIT
      || centralSize !== 46 + nameLength + extraLength + commentLength || zip.readUInt16LE(central + 34) !== 0
      || (zip.readUInt32LE(central + 38) >>> 16 & 0xf000) === 0xa000
      || decode(zip.subarray(central + 46, central + 46 + nameLength)) !== expected
      || local + 30 > central || zip.readUInt32LE(local) !== 0x04034b50
      || zip.readUInt16LE(local + 6) !== flags || zip.readUInt16LE(local + 8) !== method) throw new Error()
    const localName = zip.readUInt16LE(local + 26), localExtra = zip.readUInt16LE(local + 28), data = local + 30 + localName + localExtra
    if (data + compressed > central || decode(zip.subarray(local + 30, local + 30 + localName)) !== expected) throw new Error()
    const packed = zip.subarray(data, data + compressed)
    const bytes = method === 0 ? Buffer.from(packed) : inflateRawSync(packed, { maxOutputLength: JSON_LIMIT })
    if (bytes.length !== uncompressed) throw new Error()
    let checksum = 0xffffffff
    for (const byte of bytes) {
      checksum ^= byte
      for (let bit = 0; bit < 8; bit++) checksum = checksum >>> 1 ^ (checksum & 1 ? 0xedb88320 : 0)
    }
    if ((checksum ^ 0xffffffff) >>> 0 !== crc) throw new Error()
    return bytes
  } catch { return fail('invalid-report') }
}

export function createCloudGitHub(command: CloudGhCommand = runCloudGhCommand): CloudGitHub {
  const api = async (path: string): Promise<Record<string, unknown>> => {
    try { return object(JSON.parse((await command(['api', '--hostname', 'github.com', path], METADATA_LIMIT)).toString('utf8'))) }
    catch (error) { if (error instanceof ParallelFetchCloudServiceError) throw error; return fail('github-unavailable') }
  }
  async function getRun(runId: string, attempt?: number): Promise<CloudRemoteRun> {
    if (attempt !== undefined && (!Number.isSafeInteger(attempt) || attempt < 1 || attempt > 100000)) return fail('invalid-request')
    const run = parseRemoteRun(await api(`${REPO}/actions/runs/${id(runId)}${attempt === undefined ? '' : `/attempts/${attempt}`}`))
    if (run.runId !== runId || attempt !== undefined && run.runAttempt !== attempt) return fail('run-ambiguous')
    if (run.state === 'preparing') {
      const jobs = await api(`${REPO}/actions/runs/${runId}/attempts/${run.runAttempt}/jobs?per_page=100`)
      if (Array.isArray(jobs.jobs) && jobs.jobs.some(job => Array.isArray(object(job).steps)
        && (object(job).steps as unknown[]).some(step => object(step).name === 'Run bounded collection test'
          && ['in_progress', 'completed'].includes(String(object(step).status))))) run.state = 'collecting'
    }
    return run
  }
  return {
    async readiness() {
      try { await command(['auth', 'status', '--hostname', 'github.com'], 16384) }
      catch (error) { return error instanceof ParallelFetchCloudServiceError && error.code === 'gh-unavailable' ? 'gh-unavailable' : 'github-unavailable' }
      try { const workflow = await api(`${REPO}/actions/workflows/${WORKFLOW}`); return workflow.state === 'active' ? 'ready' : 'workflow-unavailable' }
      catch { return 'workflow-unavailable' }
    },
    async dispatch(mode, requestId) {
      uuid(requestId)
      if (!['serial', 'compare'].includes(mode)) return fail('invalid-request')
      await command(['workflow', 'run', WORKFLOW, '--repo', 'gonchiman/sf6', '--ref', 'main',
        '--raw-field', `mode=${mode}`, '--raw-field', `request_id=${requestId}`], 16384)
    },
    async findRun(requestId) {
      uuid(requestId)
      const matches: CloudRemoteRun[] = []
      for (let page = 1; page <= 5; page++) {
        const value = await api(`${REPO}/actions/workflows/${WORKFLOW}/runs?event=workflow_dispatch&branch=main&per_page=100&page=${page}`)
        if (!Array.isArray(value.workflow_runs)) return fail('github-unavailable')
        for (const entry of value.workflow_runs) if (object(entry).display_title === `Parallel fetch ${requestId}`) matches.push(parseRemoteRun(entry))
        if (value.workflow_runs.length < 100) break
      }
      if (matches.length > 1) return fail('run-ambiguous')
      return matches.length ? getRun(matches[0].runId) : null
    },
    getRun,
    async cancel(runId) { await command(['api', '--hostname', 'github.com', '--method', 'POST', `${REPO}/actions/runs/${id(runId)}/cancel`], 16384) },
    async readReport(run, mode) {
      const expected = `parallel-fetch-cloud-${id(run.runId)}-${run.runAttempt}-${mode}`
      let value: Record<string, unknown>
      try { value = await api(`${REPO}/actions/runs/${run.runId}/artifacts?per_page=100`) } catch { return fail('artifact-download-failed') }
      if (!Array.isArray(value.artifacts)) return fail('artifact-download-failed')
      const matches = value.artifacts.filter(item => object(item).name === expected)
      if (matches.length !== 1) return fail(matches.length ? 'invalid-report' : 'artifact-missing')
      const artifact = object(matches[0])
      if (artifact.expired === true) return fail('artifact-expired')
      if (!Number.isSafeInteger(artifact.size_in_bytes) || Number(artifact.size_in_bytes) < 1 || Number(artifact.size_in_bytes) > ZIP_LIMIT) return fail('invalid-report')
      let zip: Buffer
      try { zip = await command(['api', '--hostname', 'github.com', `${REPO}/actions/artifacts/${id(artifact.id)}/zip`], ZIP_LIMIT) }
      catch { return fail('artifact-download-failed') }
      try {
        const report = parseParallelFetchReport(JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(extractCloudReportZip(zip, `${expected}.json`))))
        if (report.runId !== `cloud-${run.runId}-${run.runAttempt}-${mode}` || report.state === 'running'
          || JSON.stringify(report.config) !== JSON.stringify(cloudConfig(mode))) return fail('invalid-report')
        return report
      } catch { return fail('invalid-report') }
    },
  }
}
