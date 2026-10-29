import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Keep the dev-only Node/Playwright graph out of Vite's bundled configuration.
const parallelFetchServiceUrl = new URL('./scripts/lib/parallel-fetch-service.ts', import.meta.url).href
const parallelFetchCloudServiceUrl = new URL('./scripts/lib/parallel-fetch-cloud-service.ts', import.meta.url).href
const sampleSurveyServiceUrl = new URL('./scripts/lib/sample-survey-service.ts', import.meta.url).href

export default defineConfig(async ({ command, isPreview }) => ({
  plugins: [react(), ...(command === 'serve' && !isPreview
    ? [(await import(parallelFetchServiceUrl)).parallelFetchPlugin(),
      (await import(parallelFetchCloudServiceUrl)).parallelFetchCloudPlugin(),
      (await import(sampleSurveyServiceUrl)).sampleSurveyPlugin()] : [])],
  base: '/sf6/',
  server: { fs: { deny: [
    // Preserve Vite's default deny list and keep local survey/session storage private.
    '.env', '.env.*', '*.{crt,pem,key,p12,pfx,cer,der}', '.npmrc', '.yarnrc.yml', '**/.git/**', '**/.local/**',
  ] } },
}))
