export type PublishedDataPublication<Manifest> = {
  manifest: Manifest
  source: 'history' | 'bundled'
  baseUrl: string
}

export interface PublishedDataFeedOptions {
  fetch?: typeof fetch
  localBaseUrl?: string
  historyBaseUrl?: string
  timeoutMs?: number
}

interface PublishedDescriptor {
  id: string
  path: string
  captureEndedAt: string
}
interface PublishedManifest<Descriptor> {
  generatedAt: string
  source: { url: string }
  datasets: Descriptor[]
}
interface PublishedDataset {
  generatedAt: string
  source: { url: string }
}
interface PublishedDataContract<Manifest, Descriptor, Dataset> {
  label: string
  localPath: string
  historyBaseUrl: string
  parseManifest(value: unknown): Manifest
  parseDescriptor(value: unknown): Descriptor
  parseDataset(value: unknown, expected: Descriptor): Dataset
}

const trailingSlash = (value: string): string => value.endsWith('/') ? value : `${value}/`

/** Select a complete validated publication, then keep every capture on that source. */
export function createPublishedDataFeed<Descriptor extends PublishedDescriptor,
  Manifest extends PublishedManifest<Descriptor>, Dataset extends PublishedDataset>(
  contract: PublishedDataContract<Manifest, Descriptor, Dataset>, options: PublishedDataFeedOptions = {},
) {
  type Publication = PublishedDataPublication<Manifest>
  const fetchData = options.fetch ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args))
  const bases = {
    history: trailingSlash(options.historyBaseUrl ?? contract.historyBaseUrl),
    bundled: trailingSlash(options.localBaseUrl ?? `${trailingSlash(import.meta.env?.BASE_URL ?? '/')}${contract.localPath}`),
  }
  const timeoutMs = options.timeoutMs ?? 10_000
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) throw new Error('読込の制限時間が不正です。')
  let publicationRequest: Promise<Publication> | null = null
  const datasetRequests = new Map<string, Promise<Dataset>>()

  async function readJson(url: string, refresh = false): Promise<unknown> {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort()
        reject(new Error(`${contract.label}データの読込が時間内に完了しませんでした。`))
      }, timeoutMs)
    })
    try {
      const request = (async () => {
        const response = await fetchData(url, { cache: refresh ? 'no-store' : 'default', credentials: 'omit', signal: controller.signal })
        if (!response.ok) throw new Error(`${contract.label}データを読み込めませんでした。もう一度お試しください。`)
        return response.json() as Promise<unknown>
      })()
      // Bound the body read too, including transports that do not honor abort.
      return await Promise.race([request, deadline])
    } finally {
      clearTimeout(timer)
    }
  }

  async function loadDataset(publication: Publication, descriptor: Descriptor): Promise<Dataset> {
    if (!['history', 'bundled'].includes(publication.source) || publication.baseUrl !== bases[publication.source]) {
      throw new Error(`${contract.label}データの取得元が一致しません。`)
    }
    const manifest = contract.parseManifest(publication.manifest)
    const expected = contract.parseDescriptor(descriptor)
    const listed = manifest.datasets.find(item => item.id === expected.id)
    if (!listed || JSON.stringify(listed) !== JSON.stringify(expected)) throw new Error(`${contract.label}の取得記録が一覧と一致しません。`)
    const key = JSON.stringify([publication.source, publication.baseUrl, manifest.generatedAt, expected])
    const cached = datasetRequests.get(key)
    if (cached) return cached
    const url = `${publication.baseUrl}${expected.path}?v=${encodeURIComponent(expected.captureEndedAt)}&published=${encodeURIComponent(manifest.generatedAt)}`
    const request = readJson(url).then(value => {
      const dataset = contract.parseDataset(value, expected)
      if (dataset.source.url !== manifest.source.url || Date.parse(dataset.generatedAt) > Date.parse(manifest.generatedAt)) {
        throw new Error(`${contract.label}データの出典または日時が一覧と一致しません。`)
      }
      return dataset
    }).catch(error => {
      if (datasetRequests.get(key) === request) datasetRequests.delete(key)
      throw error
    })
    datasetRequests.set(key, request)
    return request
  }

  async function readPublication(source: Publication['source']): Promise<Publication> {
    const baseUrl = bases[source]
    const manifest = contract.parseManifest(await readJson(`${baseUrl}index.json`, true))
    const publication = { manifest, source, baseUrl }
    const latest = [...manifest.datasets].sort((a, b) => Date.parse(b.captureEndedAt) - Date.parse(a.captureEndedAt)
      || a.id.localeCompare(b.id))[0]
    // A new index alone is insufficient: verify the capture that the page will initially show.
    if (latest) await loadDataset(publication, latest)
    return publication
  }

  function loadPublication(): Promise<Publication> {
    if (publicationRequest) return publicationRequest
    const request = readPublication('history').catch(() => readPublication('bundled')).finally(() => {
      if (publicationRequest === request) publicationRequest = null
    })
    publicationRequest = request
    return request
  }

  return { loadPublication, loadDataset }
}
