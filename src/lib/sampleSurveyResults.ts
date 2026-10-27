import { parseSampleSurveyRun } from './sampleSurvey.ts'
import type { SampleSurveyRun } from '../types/sampleSurvey.ts'
import type { SampleSurveyResultsDescriptor, SampleSurveyResultsManifest } from '../types/sampleSurveyResults.ts'
import { createPublishedDataFeed, type PublishedDataFeedOptions, type PublishedDataPublication } from './publishedDataFeed.ts'

export const SAMPLE_SURVEY_RESULTS_SOURCE = {
  url: 'https://www.streetfighter.com/6/buckler/ja-jp/ranking/league', title: 'Buckler’s Boot Camp',
} as const
export const SAMPLE_SURVEY_RESULTS_MAX_DATASETS = 100
export const SAMPLE_SURVEY_RESULTS_MAX_JSON_BYTES = 256 * 1024
export const SAMPLE_SURVEY_RESULTS_HISTORY_BASE_URL = 'https://raw.githubusercontent.com/gonchiman/sf6/refs/heads/codex/sample-survey-history/public/data/sample-survey/'
export type SampleSurveyResultsPublication = PublishedDataPublication<SampleSurveyResultsManifest>

function invalid(): never { throw new Error('標本調査の公開結果の形式が不正です。') }
function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid()
  const input = value as Record<string, unknown>
  if (Object.keys(input).length !== keys.length || keys.some(key => !Object.hasOwn(input, key))) invalid()
  return input
}
function utc(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) invalid()
  return value
}

export function parseSampleSurveyResultsDescriptor(value: unknown): SampleSurveyResultsDescriptor {
  const item = record(value, ['id', 'path', 'captureStartedAt', 'captureEndedAt'])
  if (typeof item.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(item.id)
    || item.path !== `runs/${item.id}.json`) invalid()
  const captureStartedAt = utc(item.captureStartedAt), captureEndedAt = utc(item.captureEndedAt)
  if (captureStartedAt > captureEndedAt) invalid()
  return { id: item.id, path: item.path as string, captureStartedAt, captureEndedAt }
}

export function parseSampleSurveyResultsManifest(value: unknown): SampleSurveyResultsManifest {
  const item = record(value, ['schemaVersion', 'generatedAt', 'source', 'datasets'])
  const source = record(item.source, ['url', 'title'])
  if (item.schemaVersion !== 1 || source.url !== SAMPLE_SURVEY_RESULTS_SOURCE.url || source.title !== SAMPLE_SURVEY_RESULTS_SOURCE.title
    || !Array.isArray(item.datasets) || item.datasets.length > SAMPLE_SURVEY_RESULTS_MAX_DATASETS) invalid()
  const generatedAt = utc(item.generatedAt), datasets = item.datasets.map(parseSampleSurveyResultsDescriptor)
  if (new Set(datasets.map(dataset => dataset.id)).size !== datasets.length
    || new Set(datasets.map(dataset => dataset.path.toLowerCase())).size !== datasets.length
    || datasets.some(dataset => dataset.captureEndedAt > generatedAt)) invalid()
  return { schemaVersion: 1, generatedAt, source: { ...SAMPLE_SURVEY_RESULTS_SOURCE }, datasets }
}

/** Completed v1/v2 public aggregates only; interval evidence and missing counts stay intact. */
export function parseSampleSurveyResultsRun(value: unknown, expected?: SampleSurveyResultsDescriptor): SampleSurveyRun {
  const run = parseSampleSurveyRun(value)
  if (run.state !== 'complete' || run.finishedAt === null || run.stopReason !== null || run.resumeAllowed) invalid()
  if (expected) {
    const descriptor = parseSampleSurveyResultsDescriptor(expected)
    if (descriptor.id !== run.id || descriptor.captureStartedAt !== run.startedAt || descriptor.captureEndedAt !== run.finishedAt) invalid()
  }
  return run
}

/** Bound actual decoded UTF-8 body bytes, including missing or misleading Content-Length. */
async function boundedResponse(response: Response, signal: AbortSignal | null | undefined): Promise<Response> {
  if (!response.ok) { await response.body?.cancel().catch(() => {}); return response }
  const length = response.headers.get('Content-Length')
  if (length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > SAMPLE_SURVEY_RESULTS_MAX_JSON_BYTES)) {
    await response.body?.cancel().catch(() => {}); invalid()
  }
  if (!response.body) invalid()
  const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true })
  let total = 0, text = ''
  const abort = () => { void reader.cancel().catch(() => {}) }
  signal?.addEventListener('abort', abort, { once: true })
  try {
    if (signal?.aborted) invalid()
    for (;;) {
      const { done, value } = await reader.read()
      if (signal?.aborted) invalid()
      if (done) break
      total += value.byteLength
      if (total > SAMPLE_SURVEY_RESULTS_MAX_JSON_BYTES) invalid()
      text += decoder.decode(value, { stream: true })
    }
    text += decoder.decode()
    return new Response(text, { status: response.status, headers: { 'Content-Type': 'application/json' } })
  } catch {
    await reader.cancel().catch(() => {})
    return invalid()
  } finally { signal?.removeEventListener('abort', abort); reader.releaseLock() }
}

interface PublishedRun { run: SampleSurveyRun; generatedAt: string; source: typeof SAMPLE_SURVEY_RESULTS_SOURCE }

export function createSampleSurveyResultsFeed(options: PublishedDataFeedOptions = {}) {
  const fetchData = options.fetch ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args))
  const feed = createPublishedDataFeed<SampleSurveyResultsDescriptor, SampleSurveyResultsManifest, PublishedRun>({
    label: '標本調査', localPath: 'data/sample-survey/', historyBaseUrl: SAMPLE_SURVEY_RESULTS_HISTORY_BASE_URL,
    parseManifest: parseSampleSurveyResultsManifest, parseDescriptor: parseSampleSurveyResultsDescriptor,
    parseDataset(value, expected) {
      const run = parseSampleSurveyResultsRun(value, expected)
      return { run, generatedAt: run.updatedAt, source: SAMPLE_SURVEY_RESULTS_SOURCE }
    },
  }, { ...options, fetch: async (input, init) => boundedResponse(await fetchData(input, { ...init, redirect: 'error' }), init?.signal) })
  return {
    loadPublication: feed.loadPublication,
    async loadDataset(publication: SampleSurveyResultsPublication, descriptor: SampleSurveyResultsDescriptor): Promise<SampleSurveyRun> {
      return (await feed.loadDataset(publication, descriptor)).run
    },
  }
}

export const sampleSurveyResultsFeed = createSampleSurveyResultsFeed()
