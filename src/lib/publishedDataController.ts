import { selectRefreshedDataId, shouldAcceptPublication, type PublishedDataPublication } from './publishedDataRefresh.ts'

export interface PublishedDataFeed<P extends PublishedDataPublication> {
  loadPublication(): Promise<P>
  loadDataset(publication: P, descriptor: P['manifest']['datasets'][number]): Promise<unknown>
}

export interface PublishedDataState<P extends PublishedDataPublication> {
  status: 'loading' | 'error' | 'ready'
  publication: P | null
  selectedId: string | null
  refreshError: boolean
}

export function initialPublishedDataState<P extends PublishedDataPublication>(): PublishedDataState<P> {
  return { status: 'loading', publication: null, selectedId: null, refreshError: false }
}

/** Share refresh and selection transitions without binding them to a page or React renderer. */
export function createPublishedDataController<P extends PublishedDataPublication>(feed: PublishedDataFeed<P>,
  onChange: (state: PublishedDataState<P>) => void) {
  let state = initialPublishedDataState<P>()
  let active = true
  let pending: Promise<void> | null = null
  const update = (next: PublishedDataState<P>) => {
    if (!active) return
    state = next
    onChange(state)
  }

  async function readPublication(): Promise<void> {
    try {
      const next = await feed.loadPublication()
      if (!active) return
      const previous = state.publication
      if (!shouldAcceptPublication(previous, next)) {
        update({ ...state, refreshError: true })
        return
      }
      // Selection can change while checking a new publication. Preload the final
      // selected capture too, or leave the usable publication until the next refresh.
      for (let attempt = 0; ; attempt++) {
        const nextId = selectRefreshedDataId(previous?.manifest ?? null, next.manifest, state.selectedId)
        const nextDescriptor = next.manifest.datasets.find(item => item.id === nextId)
        if (nextDescriptor) await feed.loadDataset(next, nextDescriptor)
        if (!active) return
        if (nextId === selectRefreshedDataId(previous?.manifest ?? null, next.manifest, state.selectedId)) break
        if (attempt === 2) return
      }
      const publication = previous && JSON.stringify(previous) === JSON.stringify(next) ? previous : next
      const selectedId = selectRefreshedDataId(previous?.manifest ?? null, next.manifest, state.selectedId)
      if (publication !== previous || selectedId !== state.selectedId || state.refreshError || state.status !== 'ready') {
        update({ status: 'ready', publication, selectedId, refreshError: false })
      }
    } catch {
      if (active) update(state.publication ? { ...state, refreshError: true } : { ...state, status: 'error' })
    }
  }

  return {
    getState: () => state,
    setSelectedId(selectedId: string | null) {
      if (selectedId !== state.selectedId) update({ ...state, selectedId })
    },
    refresh(): Promise<void> {
      if (!active) return Promise.resolve()
      if (pending) return pending
      if (!state.publication && state.status !== 'loading') update({ ...state, status: 'loading' })
      const request = readPublication().finally(() => { if (pending === request) pending = null })
      pending = request
      return request
    },
    dispose() { active = false },
  }
}
