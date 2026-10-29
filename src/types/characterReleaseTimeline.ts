import type { CharacterReleaseRow } from './characterReleases.ts'

export type CharacterReleaseTimelineDirection = 'horizontal' | 'vertical'

export interface CharacterReleaseTimelineEvent {
  key: string
  /** Japan calendar date retained from the release record. */
  date: string
  /** UTC midnight day number, used only for calendar spacing. */
  day: number
  label: string
  rows: CharacterReleaseRow[]
  /** Never promoted from scheduled to released by comparing against today's date. */
  status: 'released' | 'scheduled'
}

export interface CharacterReleaseTimelineData {
  events: CharacterReleaseTimelineEvent[]
  /** Unknown dates have no inferred timeline position. */
  undated: CharacterReleaseRow[]
}
