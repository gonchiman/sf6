import { calculateExpectedMatches } from '../lib/expectedMatches'
import type { ExpectedMatchCharacter, ExpectedMatchRow, ExpectedMatchSettings, ExpectedMatchWorkerResponse } from '../types/expectedMatchData'

const worker = self as unknown as {
  onmessage: ((event: MessageEvent<{ characters: ExpectedMatchCharacter[]; model: ExpectedMatchSettings }>) => void) | null
  postMessage(message: ExpectedMatchWorkerResponse): void
}

worker.onmessage = event => {
  try {
    const { characters, model } = event.data
    const rows: ExpectedMatchRow[] = []
    for (const character of characters) {
      const result = model.startLp === model.targetLp
        ? { status: 'finite' as const, expectedMatches: 0, stateCount: 0, residualBound: 0 }
        : !character.available ? { status: 'missing-data' as const }
          : calculateExpectedMatches({ ...model, ranks: character.ranks.map(rank => ({
            id: rank.league, minimumLp: rank.minimumLp, winProbability: rank.probability!,
          })) })
      rows.push({ character, result })
      worker.postMessage({ status: 'progress', completed: rows.length, total: characters.length })
    }
    worker.postMessage({ status: 'ready', rows })
  } catch {
    worker.postMessage({ status: 'error' })
  }
}
