import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { collectPlayerObservationInput, markPlayerObservationMissingRun } from './lib/player-observation-collector.ts'

export { collectPlayerObservationInput, markPlayerObservationMissingRun }

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const defaultDatabase = fileURLToPath(new URL('../.local/player-observations/history.sqlite', import.meta.url))
  const input = process.argv[2]
  if (input === '--missing') {
    if (!process.argv[3] || !process.argv[4] || process.argv.length > 6) {
      console.error('使い方: node scripts/collect-player-observations.ts --missing <走査ID> <予定ISO-UTC日時> [非公開DBパス]')
      process.exitCode = 1
    } else try {
      markPlayerObservationMissingRun(process.argv[3], process.argv[4], process.argv[5] ?? defaultDatabase)
      console.log('欠測記録を保存しました。人数を0件として補完しません。')
    } catch {
      console.error('欠測記録を保存できませんでした。予定日時・形式・既存の走査履歴を確認してください。')
      process.exitCode = 1
    }
  } else if (!input || process.argv.length > 4 || input.startsWith('--')) {
    console.error('使い方: node scripts/collect-player-observations.ts <画面取得input.json> [非公開DBパス] または --missing <走査ID> <予定ISO-UTC日時> [非公開DBパス]')
    process.exitCode = 1
  } else {
    try {
      const database = process.argv[3] ?? defaultDatabase
      const result = await collectPlayerObservationInput(input, database)
      console.log(`画面記録の取り込み完了: ${result.pages.succeeded}ページ / ${result.observedIdCount ?? '未取得'} ID / ${result.status}（ライブ取得は行いません）`)
    } catch {
      // Do not echo input IDs, arbitrary input strings, cookies, or raw adapter errors.
      console.error('観測入力を取り込めませんでした。入力の形式・対象条件・時刻・既存の走査履歴を確認してください。')
      process.exitCode = 1
    }
  }
}
