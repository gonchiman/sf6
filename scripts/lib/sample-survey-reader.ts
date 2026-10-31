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

/** A fresh strict read may be attempted; this never permits accepting the failed page. */
export class SampleSurveyRetryableReadError extends SampleSurveyReadError {
  readonly transientHttpStatus: 200 | 502 | 503 | 504
  constructor(code: 'server-error' | 'authentication-unconfirmed', transientHttpStatus: 200 | 502 | 503 | 504) {
    super(code)
    if (!['server-error', 'authentication-unconfirmed'].includes(code) || ![200, 502, 503, 504].includes(transientHttpStatus)
      || transientHttpStatus === 200 && code !== 'authentication-unconfirmed') {
      throw new SampleSurveyReadError('read-failed')
    }
    this.transientHttpStatus = transientHttpStatus
  }
}

export interface SampleSurveyReadRetryEvent {
  at: string
  target: SampleSurveyTarget
  page: number
  attempt: number
  retryNumber: 1 | 2 | 3
  code: 'server-error' | 'authentication-unconfirmed'
  httpStatus: 200 | 502 | 503 | 504
  delayMs: 30000
}
