export type AppRoute =
  | { page: 'win-rates' }
  | { page: 'characters'; characterId: string | null }
  | { page: 'character-traits' }

export function characterHash(characterId: string): string {
  return `#characters/${encodeURIComponent(characterId)}`
}

export function parseHashRoute(hash: string): AppRoute {
  if (hash === '#character-traits' || hash === '#character-traits/') {
    return { page: 'character-traits' }
  }
  if (hash === '#characters' || hash === '#characters/') {
    return { page: 'characters', characterId: null }
  }
  if (hash.startsWith('#characters/')) {
    const encodedId = hash.slice('#characters/'.length)
    try {
      return { page: 'characters', characterId: decodeURIComponent(encodedId) }
    } catch {
      return { page: 'characters', characterId: encodedId }
    }
  }
  return { page: 'win-rates' }
}
