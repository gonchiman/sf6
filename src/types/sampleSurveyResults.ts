export interface SampleSurveyResultsDescriptor {
  id: string
  path: string
  captureStartedAt: string
  captureEndedAt: string
}

/** Published aggregate references only. Private checkpoints and account IDs never belong here. */
export interface SampleSurveyResultsManifest {
  schemaVersion: 1
  generatedAt: string
  source: { url: string; title: string }
  datasets: SampleSurveyResultsDescriptor[]
}
