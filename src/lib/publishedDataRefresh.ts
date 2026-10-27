export interface PublishedDataDescriptor {
  id: string
  captureEndedAt: string
}

export interface PublishedDataManifest {
  datasets: readonly PublishedDataDescriptor[]
}

export interface PublishedDataPublication {
  manifest: PublishedDataManifest
  source: 'history' | 'bundled'
}

function latestDescriptor(manifest: PublishedDataManifest | null): PublishedDataDescriptor | null {
  return manifest?.datasets.reduce<PublishedDataDescriptor | null>((latest, descriptor) =>
    !latest || Date.parse(descriptor.captureEndedAt) > Date.parse(latest.captureEndedAt) ? descriptor : latest, null) ?? null
}

/** Follow new captures only when the user was viewing the previous latest capture. */
export function selectRefreshedDataId(previousManifest: PublishedDataManifest | null,
  nextManifest: PublishedDataManifest, selectedId: string | null): string | null {
  const nextLatest = latestDescriptor(nextManifest)
  if (selectedId === null || selectedId === latestDescriptor(previousManifest)?.id
    || !nextManifest.datasets.some(descriptor => descriptor.id === selectedId)) return nextLatest?.id ?? null
  return selectedId
}

/** A temporary fallback or incomplete history must not replace captures already displayed. */
export function shouldAcceptPublication(previous: PublishedDataPublication | null, next: PublishedDataPublication): boolean {
  if (!previous) return true
  if (previous.source === 'history' && next.source === 'bundled') return false
  const nextIds = new Set(next.manifest.datasets.map(descriptor => descriptor.id))
  if (previous.manifest.datasets.some(descriptor => !nextIds.has(descriptor.id))) return false
  const previousLatest = latestDescriptor(previous.manifest)
  const nextLatest = latestDescriptor(next.manifest)
  // generatedAt is the import time, not the age of the captured data.
  return !previousLatest || !!nextLatest && Date.parse(nextLatest.captureEndedAt) >= Date.parse(previousLatest.captureEndedAt)
}

interface PublishedDataRefreshEnvironment {
  document: {
    readonly visibilityState: string
    addEventListener(type: 'visibilitychange', listener: () => void): void
    removeEventListener(type: 'visibilitychange', listener: () => void): void
  }
  window: {
    setInterval(callback: () => void, milliseconds: number): number
    clearInterval(handle: number): void
  }
}

/** The caller loads once on mount; background tabs wait until they become visible. */
export function startPublishedDataRefresh(refresh: () => void,
  environment: PublishedDataRefreshEnvironment = { document, window }): () => void {
  let active = true
  const refreshIfVisible = () => {
    if (active && environment.document.visibilityState === 'visible') refresh()
  }
  const interval = environment.window.setInterval(refreshIfVisible, 5 * 60 * 1000)
  environment.document.addEventListener('visibilitychange', refreshIfVisible)
  return () => {
    if (!active) return
    active = false
    environment.window.clearInterval(interval)
    environment.document.removeEventListener('visibilitychange', refreshIfVisible)
  }
}
