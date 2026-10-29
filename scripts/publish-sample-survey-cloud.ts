import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isAllowedSampleSurveyCloudExecution, SampleSurveyCloudError } from './collect-sample-survey-cloud.ts'
import { publishSampleSurveyResults } from './lib/sample-survey-publication.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const SAMPLE_SURVEY_CLOUD_INCOMING = resolve(ROOT, '.local/sample-survey-cloud/incoming/public/data/sample-survey')
export const SAMPLE_SURVEY_CLOUD_HISTORY = resolve(ROOT, '.local/sample-survey-cloud/history/public/data/sample-survey')
export async function publishSampleSurveyCloud(dependencies: {
  env?: Record<string, string | undefined>; publish?: typeof publishSampleSurveyResults
} = {}): Promise<void> {
  if (!isAllowedSampleSurveyCloudExecution(dependencies.env ?? process.env)) throw new SampleSurveyCloudError('runner')
  await (dependencies.publish ?? publishSampleSurveyResults)(SAMPLE_SURVEY_CLOUD_INCOMING, SAMPLE_SURVEY_CLOUD_HISTORY)
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.slice(2).length) { console.error('引数は指定できません。'); process.exitCode = 1 }
  else publishSampleSurveyCloud().then(() => console.log('標本調査の集計履歴を反映しました。')).catch(() => {
    console.error('標本調査の履歴を反映できませんでした。以前の正常データを保持してください。'); process.exitCode = 1
  })
}
