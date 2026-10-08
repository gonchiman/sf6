export type AppRoute =
  | { page: 'win-rates' }
  | { page: 'characters'; characterId: string | null }

export function characterHash(characterId: string): string {
  return `#characters/${encodeURIComponent(characterId)}`
}

export function parseHashRoute(hash: string): AppRoute {
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
