import type { CharacterReleaseRow } from '../types/characterReleases.ts'
import type { CharacterReleaseTimelineData, CharacterReleaseTimelineEvent } from '../types/characterReleaseTimeline.ts'

const MILLISECONDS_PER_DAY = 86_400_000

function utcDay(date: string): number {
  const timestamp = Date.parse(`${date}T00:00:00Z`)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(timestamp)
    || new Date(timestamp).toISOString().slice(0, 10) !== date) {
    throw new Error('タイムラインの実装日が正しくありません。')
  }
  return timestamp / MILLISECONDS_PER_DAY
}

function eventLabel(rows: readonly CharacterReleaseRow[]): string {
  if (rows.length === 1) return rows[0].character.name
  return rows.every((row) => row.kind === 'initial') ? `初期${rows.length}キャラ` : `同日${rows.length}キャラ`
}

/** Group the already filtered rows without changing their identities or release evidence. */
export function buildCharacterReleaseTimeline(rows: readonly CharacterReleaseRow[]): CharacterReleaseTimelineData {
  const groups = new Map<string, CharacterReleaseTimelineEvent>()
  const undated: CharacterReleaseRow[] = []
  for (const row of rows) {
    const date = row.releaseDate
    if (row.status === 'unverified' || date === null) {
      undated.push(row)
      continue
    }
    const key = `${date}:${row.status}`
    const existing = groups.get(key)
    if (existing) {
      existing.rows.push(row)
    } else {
      groups.set(key, { key, date, day: utcDay(date), label: '', rows: [row], status: row.status })
    }
  }
  const events = [...groups.values()].sort((first, second) => first.day - second.day
    || (first.status === 'released' ? 0 : 1) - (second.status === 'released' ? 0 : 1))
  for (const event of events) event.label = eventLabel(event.rows)
  return { events, undated }
}
