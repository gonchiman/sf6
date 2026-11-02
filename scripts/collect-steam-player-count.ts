import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { parseSteamPlayerCountObservation } from '../src/lib/steamPlayerCount.ts'
import { DEFAULT_STEAM_PLAYER_COUNT_GAME, getSteamPlayerCountGame, STEAM_PLAYER_COUNT_GAMES } from '../src/lib/steamPlayerCountGames.ts'
import type { SteamPlayerCountAppId, SteamPlayerCountObservation } from '../src/types/steamPlayerCount.ts'
import { checkSteamParents, steamJson } from './lib/steam-player-count-files.ts'

type Environment = Record<string, string | undefined>
type CollectionErrorCode = 'runner' | 'arguments' | 'http' | 'backoff' | 'response' | 'network' | 'output'
export interface SteamPlayerCountCapture {
  schemaVersion: 1
  appId: SteamPlayerCountAppId
  sourceUrl: string
  observation: SteamPlayerCountObservation
}
export type SteamPlayerCountResult = { appId: SteamPlayerCountAppId; status: 'succeeded'; capture: SteamPlayerCountCapture }
  | { appId: SteamPlayerCountAppId; status: 'failed'; errorCode: CollectionErrorCode }
export interface SteamPlayerCountBatch {
  schemaVersion: 1
  runId: string | null
  runAttempt: number | null
  results: SteamPlayerCountResult[]
}

export class SteamPlayerCountCollectionError extends Error {
  readonly code: CollectionErrorCode
  constructor(code: SteamPlayerCountCollectionError['code']) {
    super(`Steam同時接続数を取得できませんでした (${code})。`)
    this.name = 'SteamPlayerCountCollectionError'
    this.code = code
  }
}

function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !keys.includes(key)) || keys.some(key => !Object.hasOwn(value, key))) {
    throw new SteamPlayerCountCollectionError('response')
  }
  return value as Record<string, unknown>
}

export function parseSteamPlayerCountCapture(value: unknown, expectedAppId?: SteamPlayerCountAppId): SteamPlayerCountCapture {
  const input = record(value, ['schemaVersion', 'appId', 'sourceUrl', 'observation'])
  const game = getSteamPlayerCountGame(input.appId as SteamPlayerCountAppId)
  if (input.schemaVersion !== 1 || input.sourceUrl !== game.sourceUrl || expectedAppId !== undefined && game.appId !== expectedAppId) {
    throw new SteamPlayerCountCollectionError('response')
  }
  return { schemaVersion: 1, appId: game.appId, sourceUrl: game.sourceUrl, observation: parseSteamPlayerCountObservation(input.observation) }
}

export function parseSteamPlayerCountBatch(value: unknown): SteamPlayerCountBatch {
  const input = record(value, ['schemaVersion', 'runId', 'runAttempt', 'results'])
  if (input.schemaVersion !== 1 || !Array.isArray(input.results) || input.results.length !== STEAM_PLAYER_COUNT_GAMES.length
    || (input.runId === null) !== (input.runAttempt === null)
    || input.runId !== null && (typeof input.runId !== 'string' || !/^[1-9]\d{0,24}$/.test(input.runId)
      || !Number.isSafeInteger(input.runAttempt) || (input.runAttempt as number) <= 0)) throw new SteamPlayerCountCollectionError('response')
  const results = input.results.map((raw): SteamPlayerCountResult => {
    if (!raw || typeof raw !== 'object' || !('status' in raw)) throw new SteamPlayerCountCollectionError('response')
    const item = record(raw, raw.status === 'succeeded' ? ['appId', 'status', 'capture'] : ['appId', 'status', 'errorCode'])
    const game = getSteamPlayerCountGame(item.appId as SteamPlayerCountAppId)
    if (item.status === 'succeeded') {
      const capture = parseSteamPlayerCountCapture(item.capture, game.appId)
      if (capture.observation.runId !== input.runId || capture.observation.runAttempt !== input.runAttempt) throw new SteamPlayerCountCollectionError('response')
      return { appId: game.appId, status: 'succeeded', capture }
    }
    if (item.status !== 'failed' || !['runner', 'arguments', 'http', 'backoff', 'response', 'network', 'output'].includes(item.errorCode as string)) {
      throw new SteamPlayerCountCollectionError('response')
    }
    return { appId: game.appId, status: 'failed', errorCode: item.errorCode as CollectionErrorCode }
  })
  if (new Set(results.map(result => result.appId)).size !== STEAM_PLAYER_COUNT_GAMES.length) throw new SteamPlayerCountCollectionError('response')
  return { schemaVersion: 1, runId: input.runId as string | null, runAttempt: input.runAttempt as number | null, results }
}

export function isAllowedSteamWorkflow(env: Environment): boolean {
  return env.GITHUB_ACTIONS === 'true' && env.RUNNER_ENVIRONMENT === 'github-hosted'
    && env.RUNNER_OS === 'Linux' && env.GITHUB_REPOSITORY === 'gonchiman/sf6'
    && env.GITHUB_REF === 'refs/heads/main'
    && env.GITHUB_WORKFLOW_REF === 'gonchiman/sf6/.github/workflows/steam-player-count.yml@refs/heads/main'
    && ['schedule', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME ?? '')
}

function collectionIdentity(env: Environment): { runId: string | null; runAttempt: number | null } {
  if (env.GITHUB_ACTIONS === 'true' && !isAllowedSteamWorkflow(env)) throw new SteamPlayerCountCollectionError('runner')
  const runId = env.GITHUB_ACTIONS === 'true' ? env.GITHUB_RUN_ID ?? '' : null
  const runAttempt = runId === null ? null : Number(env.GITHUB_RUN_ATTEMPT)
  if (runId !== null && (!/^[1-9]\d{0,24}$/.test(runId) || !Number.isSafeInteger(runAttempt) || runAttempt! <= 0)) {
    throw new SteamPlayerCountCollectionError('runner')
  }
  return { runId, runAttempt }
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
export interface SteamPlayerCountCollectionOptions {
  appId?: SteamPlayerCountAppId
  fetch?: typeof fetch
  now?: () => Date
  wait?: (milliseconds: number) => Promise<unknown>
  env?: Environment
  timeoutMs?: number
  uuid?: () => string
}

export async function collectSteamPlayerCount(options: SteamPlayerCountCollectionOptions = {}): Promise<SteamPlayerCountObservation> {
  const game = getSteamPlayerCountGame(options.appId ?? DEFAULT_STEAM_PLAYER_COUNT_GAME.appId)
  const env = options.env ?? process.env
  const { runId, runAttempt } = collectionIdentity(env)
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
        const response = await fetchData(game.sourceUrl, {
          credentials: 'omit', redirect: 'error', headers: { Accept: 'application/json' }, signal: controller.signal,
        })
        if (!response.ok) {
          retry = response.status === 429 || response.status >= 500
          let stopBatch = response.status === 429 && attempt === 2
          const retryHeader = response.headers.get('retry-after')
          if (retryHeader !== null) {
            const seconds = /^\d+$/.test(retryHeader.trim()) ? Number(retryHeader) : null
            const requestedWait = seconds === null ? Date.parse(retryHeader) - now().getTime() : seconds * 1000
            if (Number.isFinite(requestedWait)) {
              // Respect the server's backoff. A long wait becomes a missed observation;
              // this short-lived collector must not retry earlier than requested.
              if (requestedWait > 5_000 || requestedWait > 0 && (!retry || attempt === 2)) { retry = false; stopBatch = true }
              else retryAfter = Math.max(retryAfter, requestedWait, 0)
            }
          }
          void response.body?.cancel().catch(() => {})
          throw new SteamPlayerCountCollectionError(stopBatch ? 'backoff' : 'http')
        }
        const playerCount = parseSteamPlayerCountResponse(await responseJson(response))
        const observedAt = now().toISOString()
        const namespace = game.appId === DEFAULT_STEAM_PLAYER_COUNT_GAME.appId ? '' : `${game.appId}-`
        return parseSteamPlayerCountObservation({
          id: runId === null ? `observation-${namespace}${observedAt.replace(/[:.]/g, '-')}-${(options.uuid ?? randomUUID)()}` : `steam-${namespace}${runId}-${runAttempt}`,
          requestStartedAt, observedAt, playerCount, runId, runAttempt,
        })
      })()
      return await Promise.race([request, deadline])
    } catch (error) {
      if (error instanceof SteamPlayerCountCollectionError && ['response', 'backoff'].includes(error.code)) retry = false
      if (!retry || attempt === 2) throw error instanceof SteamPlayerCountCollectionError ? error : new SteamPlayerCountCollectionError('network')
    } finally { clearTimeout(timer); controller.abort() }
    await (options.wait ?? delay)(retryAfter)
  }
  throw new SteamPlayerCountCollectionError('network')
}

/** Keep each game's failures isolated and run requests sequentially, including retries. */
export async function collectSteamPlayerCounts(options: Omit<SteamPlayerCountCollectionOptions, 'appId'> = {}): Promise<SteamPlayerCountBatch> {
  const identity = collectionIdentity(options.env ?? process.env)
  const results: SteamPlayerCountResult[] = []
  let hostBackoff = false
  for (const game of STEAM_PLAYER_COUNT_GAMES) {
    if (hostBackoff) { results.push({ appId: game.appId, status: 'failed', errorCode: 'backoff' }); continue }
    try {
      const observation = await collectSteamPlayerCount({ ...options, appId: game.appId })
      results.push({ appId: game.appId, status: 'succeeded', capture: {
        schemaVersion: 1, appId: game.appId, sourceUrl: game.sourceUrl, observation,
      } })
    } catch (error) {
      results.push({ appId: game.appId, status: 'failed', errorCode: error instanceof SteamPlayerCountCollectionError ? error.code : 'network' })
      if (error instanceof SteamPlayerCountCollectionError && error.code === 'backoff') hostBackoff = true
    }
  }
  return parseSteamPlayerCountBatch({ schemaVersion: 1, ...identity, results })
}

export async function writeSteamObservation(directory: string, observation: SteamPlayerCountObservation,
  appId: SteamPlayerCountAppId = DEFAULT_STEAM_PLAYER_COUNT_GAME.appId): Promise<string> {
  const output = resolve(directory)
  const game = getSteamPlayerCountGame(appId)
  const text = steamJson(appId === DEFAULT_STEAM_PLAYER_COUNT_GAME.appId ? parseSteamPlayerCountObservation(observation)
    : parseSteamPlayerCountCapture({ schemaVersion: 1, appId, sourceUrl: game.sourceUrl, observation }, appId))
  try {
    await checkSteamParents(output)
    await mkdir(output, { recursive: true })
    await checkSteamParents(output)
    const path = resolve(output, 'observation.json')
    await writeFile(path, text, { flag: 'wx' })
    return path
  } catch { throw new SteamPlayerCountCollectionError('output') }
}

export async function writeSteamPlayerCountBatch(directory: string, batch: SteamPlayerCountBatch): Promise<string> {
  const output = resolve(directory), text = steamJson(parseSteamPlayerCountBatch(batch))
  try {
    await checkSteamParents(output)
    await mkdir(output, { recursive: true })
    await checkSteamParents(output)
    const path = resolve(output, 'batch.json')
    await writeFile(path, text, { flag: 'wx' })
    return path
  } catch { throw new SteamPlayerCountCollectionError('output') }
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  if (args.length === 1 && args[0] === '--help') {
    console.log('node scripts/collect-steam-player-count.ts --collect --output <新しい出力ディレクトリ> [--app-id <登録済みApp ID>]\n全5作品: --collect-all --output <新しい出力ディレクトリ>')
    return
  }
  if (args[0] === '--collect-all' && args.length === 3 && args[1] === '--output' && args[2]) {
    const batch = await collectSteamPlayerCounts()
    await writeSteamPlayerCountBatch(args[2], batch)
    const successfulGames = batch.results.filter(result => result.status === 'succeeded').length
    if (process.env.GITHUB_ACTIONS === 'true' && process.env.GITHUB_OUTPUT) {
      await appendFile(process.env.GITHUB_OUTPUT, `artifact_ready=true\nsuccessful_games=${successfulGames}\n`)
    }
    console.log(JSON.stringify({ successfulGames, results: batch.results.map(result => ({ appId: result.appId, status: result.status,
      ...(result.status === 'failed' ? { errorCode: result.errorCode } : { observedAt: result.capture.observation.observedAt, playerCount: result.capture.observation.playerCount }) })) }))
    if (successfulGames !== STEAM_PLAYER_COUNT_GAMES.length) process.exitCode = 1
    return
  }
  if (![3, 5].includes(args.length) || args[0] !== '--collect' || args[1] !== '--output' || !args[2]
    || args.length === 5 && args[3] !== '--app-id') throw new SteamPlayerCountCollectionError('arguments')
  const appId = getSteamPlayerCountGame(args.length === 5 ? Number(args[4]) as SteamPlayerCountAppId : DEFAULT_STEAM_PLAYER_COUNT_GAME.appId).appId
  const observation = await collectSteamPlayerCount({ appId })
  await writeSteamObservation(args[2], observation, appId)
  console.log(JSON.stringify({ appId, observedAt: observation.observedAt, playerCount: observation.playerCount }))
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(error instanceof SteamPlayerCountCollectionError ? error.message : 'Steam同時接続数を取得できませんでした。')
    process.exitCode = 1
  })
}
