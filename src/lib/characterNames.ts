import type { CharacterDescriptor } from '../types/characters.ts'
import type { WinRateFighter } from '../types/winRates.ts'
import { CHARACTER_SERIES_ALIASES } from './seriesColors.ts'

/** Join official frame names to statistics IDs without guessing from display text. */
export function japaneseCharacterNames(characters: readonly CharacterDescriptor[]): ReadonlyMap<string, string> {
  const names = new Map<string, string>()
  for (const character of characters) {
    names.set(character.id, character.name)
    if (Object.hasOwn(CHARACTER_SERIES_ALIASES, character.id)) {
      names.set(CHARACTER_SERIES_ALIASES[character.id as keyof typeof CHARACTER_SERIES_ALIASES], character.name)
    }
  }
  return names
}

export function characterDisplayName(
  fighter: Pick<WinRateFighter, 'characterId' | 'name'>,
  names: ReadonlyMap<string, string> | null,
): string {
  return names?.get(fighter.characterId) ?? fighter.name
}
