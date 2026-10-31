import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { parseSteamPlayerCountObservation, STEAM_PLAYER_COUNT_SOURCE_URL } from '../src/lib/steamPlayerCount.ts'
import type { SteamPlayerCountObservation } from '../src/types/steamPlayerCount.ts'
import { checkSteamParents, steamJson } from './lib/steam-player-count-files.ts'

type Environment = Record<string, string | undefined>
export class SteamPlayerCountCollectionError extends Error {
  readonly code: 'runner' | 'arguments' | 'http' | 'response' | 'network' | 'output'
  constructor(code: SteamPlayerCountCollectionError['code']) {
    super(`Steam同時接続数を取得できませんでした (${code})。`)
    this.name = 'SteamPlayerCountCollectionError'
    this.code = code
  }
}

export function isAllowedSteamWorkflow(env: Environment): boolean {
  return env.GITHUB_ACTIONS === 'true' && env.RUNNER_ENVIRONMENT === 'github-hosted'
    && env.RUNNER_OS === 'Linux' && env.GITHUB_REPOSITORY === 'gonchiman/sf6'
    && env.GITHUB_REF === 'refs/heads/main'
    && env.GITHUB_WORKFLOW_REF === 'gonchiman/sf6/.github/workflows/steam-player-count.yml@refs/heads/main'
    && ['schedule', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME ?? '')
}

export function parseSteamPlayerCountResponse(value: unknown): number {
  if (!value || typeof value !== 'object' || !('response' in value)
    || !value.response || typeof value.response !== 'object') throw new SteamPlayerCountCollectionError('response')
  const response = value.response as Record<string, unknown>
  if (response.result !== 1 || !Number.isSafeInteger(response.player_count) || (response.player_count as number) < 0) {
    throw new SteamPlayerCountCollectionError('response')
  }
  return response.player_count as number
}

async function responseJson(response: Response): Promise<unknown> {
  if (!response.body) throw new SteamPlayerCountCollectionError('response')
  const reader = response.body.getReader(), chunks: Uint8Array[] = []
  let length = 0
  try {
    for (;;) {
      const item = await reader.read()
      if (item.done) break
      length += item.value.byteLength
      if (length > 16 * 1024) throw new SteamPlayerCountCollectionError('response')
      chunks.push(item.value)
    }
    const bytes = new Uint8Array(length)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch (error) {
    // Cancelling an untrusted/overlarge body is best effort and must not prolong the deadline.
    void reader.cancel().catch(() => {})
    throw error instanceof SteamPlayerCountCollectionError ? error : new SteamPlayerCountCollectionError('response')
  } finally { reader.releaseLock() }
}

/** One successful response is one observation. Retries never backdate it to the cron slot. */
export async function collectSteamPlayerCount(options: {
  fetch?: typeof fetch
  now?: () => Date
  wait?: (milliseconds: number) => Promise<unknown>
  env?: Environment
  timeoutMs?: number
  uuid?: () => string
} = {}): Promise<SteamPlayerCountObservation> {
  const env = options.env ?? process.env
  if (env.GITHUB_ACTIONS === 'true' && !isAllowedSteamWorkflow(env)) throw new SteamPlayerCountCollectionError('runner')
  const runId = env.GITHUB_ACTIONS === 'true' ? env.GITHUB_RUN_ID ?? '' : null
  const runAttempt = runId === null ? null : Number(env.GITHUB_RUN_ATTEMPT)
  if (runId !== null && (!/^[1-9]\d{0,24}$/.test(runId) || !Number.isSafeInteger(runAttempt) || runAttempt! <= 0)) {
    throw new SteamPlayerCountCollectionError('runner')
  }
  const now = options.now ?? (() => new Date()), fetchData = options.fetch ?? fetch
  const timeoutMs = options.timeoutMs ?? 15_000
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000) throw new SteamPlayerCountCollectionError('arguments')
  for (let attempt = 0; attempt < 3; attempt++) {
    const requestStartedAt = now().toISOString(), controller = new AbortController()
    let retry = true, retryAfter = 500 * 2 ** attempt
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new SteamPlayerCountCollectionError('network')) }, timeoutMs)
    })
    try {
      const request = (async () => {
        const response = await fetchData(STEAM_PLAYER_COUNT_SOURCE_URL, {
          credentials: 'omit', redirect: 'error', headers: { Accept: 'application/json' }, signal: controller.signal,
        })
        if (!response.ok) {
          retry = response.status === 429 || response.status >= 500
          const retryHeader = response.headers.get('retry-after')
          if (retryHeader !== null) {
            const seconds = /^\d+$/.test(retryHeader.trim()) ? Number(retryHeader) : null
            const requestedWait = seconds === null ? Date.parse(retryHeader) - now().getTime() : seconds * 1000
            if (Number.isFinite(requestedWait)) {
              // Respect the server's backoff. A long wait becomes a missed observation;
              // this short-lived collector must not retry earlier than requested.
              if (requestedWait > 5_000) retry = false
              else retryAfter = Math.max(retryAfter, requestedWait, 0)
            }
          }
          void response.body?.cancel().catch(() => {})
          throw new SteamPlayerCountCollectionError('http')
        }
        const playerCount = parseSteamPlayerCountResponse(await responseJson(response))
        const observedAt = now().toISOString()
        return parseSteamPlayerCountObservation({
          id: runId === null ? `observation-${observedAt.replace(/[:.]/g, '-')}-${(options.uuid ?? randomUUID)()}` : `steam-${runId}-${runAttempt}`,
          requestStartedAt, observedAt, playerCount, runId, runAttempt,
        })
      })()
      return await Promise.race([request, deadline])
    } catch (error) {
      if (error instanceof SteamPlayerCountCollectionError && error.code === 'response') retry = false
      if (!retry || attempt === 2) throw error instanceof SteamPlayerCountCollectionError ? error : new SteamPlayerCountCollectionError('network')
    } finally { clearTimeout(timer); controller.abort() }
    await (options.wait ?? delay)(retryAfter)
  }
  throw new SteamPlayerCountCollectionError('network')
}

export async function writeSteamObservation(directory: string, observation: SteamPlayerCountObservation): Promise<string> {
  const output = resolve(directory)
  const text = steamJson(parseSteamPlayerCountObservation(observation))
  try {
    await checkSteamParents(output)
    await mkdir(output, { recursive: true })
    await checkSteamParents(output)
    const path = resolve(output, 'observation.json')
    await writeFile(path, text, { flag: 'wx' })
    return path
  } catch { throw new SteamPlayerCountCollectionError('output') }
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  if (args.length === 1 && args[0] === '--help') {
    console.log('node scripts/collect-steam-player-count.ts --collect --output <新しい出力ディレクトリ>')
    return
  }
  if (args.length !== 3 || args[0] !== '--collect' || args[1] !== '--output' || !args[2]) throw new SteamPlayerCountCollectionError('arguments')
  const observation = await collectSteamPlayerCount()
  await writeSteamObservation(args[2], observation)
  console.log(JSON.stringify({ observedAt: observation.observedAt, playerCount: observation.playerCount }))
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(error instanceof SteamPlayerCountCollectionError ? error.message : 'Steam同時接続数を取得できませんでした。')
    process.exitCode = 1
  })
}
