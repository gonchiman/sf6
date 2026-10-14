import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { TestContext } from 'node:test'
import { PLAYER_OBSERVATION_CONDITIONS } from '../../src/lib/playerObservations.ts'
import type { PlayerObservationInput, PlayerObservationPageCapture } from './player-observation-collector.ts'

export const TEST_GENERATED_AT = '2026-10-12T23:59:59.000Z'
export function testTime(second: number): string { return new Date(Date.parse('2026-10-10T00:00:00.000Z') + second * 1000).toISOString() }
export function testRun(id = 'baseline', second = 0, scope: 'probe' | 'population' = 'population'): PlayerObservationInput['run'] {
  return { id, scope, scheduledAt: testTime(second), startedAt: testTime(second), endedAt: testTime(second + 9) }
}
export function testPage(page = 1, total = 20, second = 1, ids?: string[]): PlayerObservationPageCapture {
  const from = (page - 1) * 20 + 1
  const length = Math.min(20, total - from + 1)
  return {
    page, capturedAt: testTime(second),
    url: `https://www.streetfighter.com/6/buckler/ja-jp/ranking/league?character_filter=2&character_id=luke&platform=1&user_status=1&home_filter=1&home_category_id=0&home_id=0&league_rank=0&page=${page}`,
    conditions: { ...PLAYER_OBSERVATION_CONDITIONS }, range: { from, to: from + length - 1, total },
    rows: Array.from({ length }, (_, index) => ({ cfnId: ids?.[index] ?? String(9000000000 + from + index), lp: 1, rank: 1 })),
  }
}
export function testInput(run = testRun(), captures = [testPage()]): PlayerObservationInput {
  return { schemaVersion: 1, definitionVersion: 1, seriesId: 'buckler-max-lp-v1', run, captures, failures: [] }
}
export async function testDirectory(t: TestContext): Promise<string> {
  const parent = resolve('.cache', 'player-observation-tests')
  await mkdir(parent, { recursive: true })
  const path = await mkdtemp(join(parent, 'sf6-observation-'))
  t.after(() => {
    const child = relative(parent, path)
    if (!child || isAbsolute(child) || child === '..' || child.startsWith('..' + sep)) {
      throw new Error('テストの後片付け先が作成したフォルダーの範囲外です。')
    }
    return rm(path, { recursive: true, force: true })
  })
  return path
}
