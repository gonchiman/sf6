import type { SampleSurveyError, SampleSurveyTarget } from '../../src/types/sampleSurvey.ts'

/** Private in-process data. Never serialize this type to the frontend or an Actions artifact. */
export interface SampleSurveyPage {
  target: SampleSurveyTarget
  page: number
  pageSize: number
  totalCount: number
  totalPages: number
  observedAt: string
  entries: { accountId: string; value: number; rankId: number | null }[]
}
export interface SampleSurveyReader {
  readPage(target: SampleSurveyTarget, page: number): Promise<SampleSurveyPage>
  close(): Promise<void>
}
export class SampleSurveyReadError extends Error {
  readonly code: SampleSurveyError
  constructor(code: SampleSurveyError) { super(`sample-survey:${code}`); this.name = 'SampleSurveyReadError'; this.code = code }
}
