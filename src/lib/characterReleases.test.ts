import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { filterCharacterReleases, loadCharacterReleaseCatalog, parseCharacterReleaseCatalog } from './characterReleases.ts'
import { parseCharacterManifest } from './characters.ts'
import { validateCharacterReleases } from '../../scripts/validate-character-releases.ts'
import type { CharacterManifest } from '../types/characters.ts'
import type { CharacterRelease, CharacterReleaseCatalog } from '../types/characterReleases.ts'

function manifest(): CharacterManifest {
  return {
    schemaVersion: 1, generatedAt: '2026-10-15T00:00:00Z',
    characters: [
      { id: 'ryu', name: 'リュウ', englishName: 'RYU', file: 'ryu.json' },
      { id: 'ken', name: 'ケン', englishName: 'KEN', file: 'ken.json' },
      { id: 'aki', name: 'A.K.I.', englishName: 'A.K.I.', file: 'aki.json' },
      { id: 'unverified', name: '未確認', englishName: 'UNVERIFIED', file: 'unverified.json' },
    ],
  }
}

function release(characterId = 'ryu', overrides: Partial<CharacterRelease> = {}): CharacterRelease {
  return {
    characterId, kind: 'initial', status: 'released', releaseDate: '2023-06-02',
    source: { title: '本日発売', url: 'https://prtimes.jp/main/html/rd/p/000003774.000013450.html' }, ...overrides,
  }
}

function catalog(overrides: Partial<CharacterReleaseCatalog> = {}): CharacterReleaseCatalog {
  return {
    schemaVersion: 1, generatedAt: '2026-10-15T08:00:00Z', checkedAt: '2026-10-15T07:00:00Z', timezone: 'Asia/Tokyo',
    characters: [release(), release('ken'), release('aki', { kind: 'additional', status: 'scheduled', releaseDate: '2023-09-27' }),
      release('unverified', { kind: 'additional', status: 'unverified', releaseDate: null, source: null })], ...overrides,
  }
}

test('日本日付・根拠・未確認を保持し、過去の予定日も壁時計で実装済みに変換しない', () => {
  const input = catalog()
  const before = structuredClone(input)
  const result = parseCharacterReleaseCatalog(input, manifest())
  assert.deepEqual(result, input)
  assert.equal(result.characters[2].status, 'scheduled')
  assert.equal(result.characters[3].releaseDate, null)
  assert.equal(result.characters[3].source, null)
  assert.notStrictEqual(result.characters[0], input.characters[0])
  assert.notStrictEqual(result.characters[0].source, input.characters[0].source)
  assert.deepEqual(input, before)
})

test('未知・重複・欠けたIDを拒否し、キャラ一覧の全員分のレコードを必須にする', () => {
  for (const characters of [catalog().characters.slice(1), [...catalog().characters, release('ryu')],
    catalog().characters.map((entry) => entry.characterId === 'ken' ? { ...entry, characterId: 'unknown-id' } : entry), []]) {
    assert.throws(() => parseCharacterReleaseCatalog(catalog({ characters }), manifest()), /characterId|不足/)
  }
  for (const input of [null, [], { ...catalog(), schemaVersion: 2 }, { ...catalog(), characters: null },
    { ...catalog(), timezone: 'UTC' }, { ...catalog(), timezone: 'Japan' }]) {
    assert.throws(() => parseCharacterReleaseCatalog(input, manifest()), /形式/)
  }
})

test('日付の繰り上がり・時差欠落・確認時刻と生成時刻の逆転を拒否する', () => {
  for (const value of ['2023-02-29', '2024-04-31', '2024-00-01', '2024-13-01', '2024-01-00', '2024-1-01', ' 2024-01-01']) {
    const input = catalog()
    input.characters[0].releaseDate = value
    assert.throws(() => parseCharacterReleaseCatalog(input, manifest()), /releaseDate/)
  }
  const leap = catalog()
  leap.characters[0].releaseDate = '2024-02-29'
  assert.equal(parseCharacterReleaseCatalog(leap, manifest()).characters[0].releaseDate, '2024-02-29')
  for (const value of ['2026-02-30T00:00:00Z', '2026-10-15T24:00:00Z', '2026-10-15T07:00:00', '2026-10-15T07:00:00+24:00']) {
    assert.throws(() => parseCharacterReleaseCatalog(catalog({ checkedAt: value }), manifest()), /checkedAt/)
    assert.throws(() => parseCharacterReleaseCatalog(catalog({ generatedAt: value }), manifest()), /generatedAt/)
  }
  assert.throws(() => parseCharacterReleaseCatalog(catalog({ checkedAt: '2026-10-15T09:00:00Z' }), manifest()), /checkedAt と generatedAt/)
  const future = catalog()
  future.characters[0].releaseDate = '2026-10-16'
  assert.throws(() => parseCharacterReleaseCatalog(future, manifest()), /released と checkedAt/)
  // UTC still has the previous date; the catalog explicitly uses Japan calendar dates.
  future.checkedAt = future.generatedAt = '2026-10-15T16:00:00Z'
  assert.equal(parseCharacterReleaseCatalog(future, manifest()).characters[0].releaseDate, '2026-10-16')
})

test('実装済み・予定には日付と一次出典を必須にし、未確認への日付の推測保存を拒否する', () => {
  for (const entry of [release('ryu', { releaseDate: null }), release('ryu', { source: null }),
    release('ryu', { status: 'scheduled', releaseDate: null }), release('ryu', { status: 'scheduled', source: null }),
    release('ryu', { status: 'unverified' }), release('ryu', { status: 'unverified', releaseDate: null }),
    release('ryu', { status: 'unknown' as never }), release('ryu', { kind: 'unknown' as never })]) {
    const input = catalog()
    input.characters[0] = entry
    assert.throws(() => parseCharacterReleaseCatalog(input, manifest()), /releaseDate|source|unverified|status|kind/)
  }
  for (const url of [
    'http://prtimes.jp/main/html/rd/p/000003774.000013450.html',
    'https://prtimes.jp/main/html/rd/p/000003774.000999999.html',
    'https://prtimes.jp.example.com/main/html/rd/p/000003774.000013450.html',
    'https://user@prtimes.jp/main/html/rd/p/000003774.000013450.html',
    'https://prtimes.jp:8000/main/html/rd/p/000003774.000013450.html',
    'https://example.com/character/ryu',
    'https://prtimes.jp/main/html/rd/p/000003774.000013450.html?tracking=1',
    'https://prtimes.jp/main/html/rd/p/000003774.000013450.html#date',
  ]) {
    const input = catalog()
    input.characters[0].source = { title: '出典', url }
    assert.throws(() => parseCharacterReleaseCatalog(input, manifest()), /source.url/)
  }
})

test('キャラ・初期追加を絞り、同日の名簿順と未確認末尾を昇降順で維持し入力を変更しない', () => {
  const input = catalog({ characters: [...catalog().characters].reverse() })
  const names = manifest()
  const before = structuredClone({ input, names })
  const all = { characterId: 'all', kind: 'all' as const }
  assert.deepEqual(filterCharacterReleases(input, names).map((row) => row.characterId), ['aki', 'ryu', 'ken', 'unverified'])
  assert.deepEqual(filterCharacterReleases(input, names, all, 'asc').map((row) => row.characterId), ['ryu', 'ken', 'aki', 'unverified'])
  assert.deepEqual(filterCharacterReleases(input, names, { ...all, kind: 'initial' }).map((row) => row.characterId), ['ryu', 'ken'])
  assert.deepEqual(filterCharacterReleases(input, names, { ...all, kind: 'additional' }).map((row) => row.characterId), ['aki', 'unverified'])
  const selected = filterCharacterReleases(input, names, { characterId: 'ken', kind: 'initial' })
  assert.equal(selected.length, 1)
  assert.strictEqual(selected[0].character, names.characters[1])
  assert.deepEqual(filterCharacterReleases(input, names, { characterId: 'ken', kind: 'additional' }), [])
  assert.deepEqual(filterCharacterReleases(input, names, { characterId: 'unknown', kind: 'all' }), [])
  assert.deepEqual({ input, names }, before)
})

test('HTTP・JSON・形式エラー後はキャッシュを破棄して再試行し、並行取得を共有して各名簿と再照合する', async (t) => {
  const input = catalog()
  let mode: 'http' | 'json' | 'format' | 'ready' = 'http'
  let requests = 0
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request) => {
    requests += 1
    assert.ok(String(url).endsWith('/data/character-releases.json'))
    return { ok: mode !== 'http', json: async () => {
      if (mode === 'json') throw new SyntaxError('invalid JSON')
      return mode === 'format' ? { ...input, schemaVersion: 0 } : input
    } } as Response
  })
  await assert.rejects(loadCharacterReleaseCatalog(manifest()), /読み込めません/)
  mode = 'json'
  await assert.rejects(loadCharacterReleaseCatalog(manifest()), /invalid JSON/)
  mode = 'format'
  await assert.rejects(loadCharacterReleaseCatalog(manifest()), /schemaVersion/)
  mode = 'ready'
  const [first, second] = await Promise.all([loadCharacterReleaseCatalog(manifest()), loadCharacterReleaseCatalog(manifest())])
  assert.deepEqual(first, input)
  assert.deepEqual(second, input)
  assert.equal(requests, 4)
  const expanded = manifest()
  expanded.characters.push({ id: 'new', name: '新キャラ', englishName: 'NEW', file: 'new.json' })
  await assert.rejects(loadCharacterReleaseCatalog(expanded), /不足/)
  assert.equal(requests, 4)
  await loadCharacterReleaseCatalog(manifest())
  assert.equal(requests, 5)
  // Clear the successful request for any subsequent loader tests in this process.
  await assert.rejects(loadCharacterReleaseCatalog(expanded), /不足/)
})

test('配信データは名簿31人全員を一意に収録し、初期18と追加13の実日付・根拠を検証する', async () => {
  const [raw, names] = await Promise.all([
    readFile(new URL('../../public/data/character-releases.json', import.meta.url), 'utf8'),
    readFile(new URL('../../public/data/characters/index.json', import.meta.url), 'utf8'),
  ])
  const expected = parseCharacterManifest(JSON.parse(names))
  const input = parseCharacterReleaseCatalog(JSON.parse(raw), expected)
  assert.equal(input.characters.length, 31)
  assert.deepEqual(new Set(input.characters.map((row) => row.characterId)), new Set(expected.characters.map((row) => row.id)))
  assert.equal(input.characters.filter((row) => row.kind === 'initial').length, 18)
  assert.ok(input.characters.filter((row) => row.kind === 'initial').every((row) => row.releaseDate === '2023-06-02'))
  assert.equal(input.characters.find((row) => row.characterId === 'elena')?.releaseDate, '2025-06-04')
  assert.equal(input.characters.find((row) => row.characterId === 'yasmine')?.releaseDate, '2026-08-03')
  assert.deepEqual(await validateCharacterReleases(), { characters: 31, released: 31, scheduled: 0, unverified: 0 })
})
