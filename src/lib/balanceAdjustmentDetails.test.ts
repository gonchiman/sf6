import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rmdir, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  balanceAdjustmentCharacterStatus, balanceAdjustmentPatchDetails,
  loadBalanceAdjustmentDetails, parseBalanceAdjustmentDetails,
} from './balanceAdjustmentDetails.ts'
import type { BalanceAdjustment, BalanceAdjustmentCatalog } from '../types/balanceAdjustments.ts'
import type {
  BalanceAdjustmentChange, BalanceAdjustmentCharacterDetails, BalanceAdjustmentDetailsCatalog,
  BalanceAdjustmentPatchDetails,
} from '../types/balanceAdjustmentDetails.ts'
import type { CharacterManifest } from '../types/characters.ts'
import { validateBalanceAdjustmentDetails } from '../../scripts/validate-balance-adjustment-details.ts'

function event(overrides: Partial<BalanceAdjustment> = {}): BalanceAdjustment {
  return {
    id: 'battle-change-20260803', date: '2026-08-03', dateBasis: 'effective', kindLabel: 'キャラ調整・修正', title: 'バトル変更リスト',
    source: { url: 'https://www.streetfighter.com/6/buckler/ja-jp/battle_change/20260803', title: 'バトル変更リスト' },
    announcement: { url: 'https://www.streetfighter.com/6/buckler/ja-jp/information/detail/update20260803', title: 'アップデートのお知らせ' },
    ...overrides,
  }
}

function history(overrides: Partial<BalanceAdjustmentCatalog> = {}): BalanceAdjustmentCatalog {
  return {
    schemaVersion: 1, generatedAt: '2026-10-08T00:00:00.000Z', checkedAt: '2026-10-08T00:00:00Z',
    source: { url: 'https://www.streetfighter.com/6/buckler/ja-jp/information/battle_change/1', title: '公式バトル変更一覧' },
    coverage: { fromMonth: '2023-07', toMonth: '2026-08' }, events: [event()], ...overrides,
  }
}

function change(overrides: Partial<BalanceAdjustmentChange> = {}): BalanceAdjustmentChange {
  return { id: 'ryu-1', target: '鳩尾砕き', categoryLabel: '調整', description: 'ガードバックを調整しました。', ...overrides }
}

function character(overrides: Partial<BalanceAdjustmentCharacterDetails> = {}): BalanceAdjustmentCharacterDetails {
  return {
    characterId: 'ryu', name: 'リュウ', status: 'ready',
    source: { url: `${event().source.url}/ryu`, title: 'リュウ バトル変更リスト' },
    policy: '立ち回りを調整しました。', changes: [change()], ...overrides,
  }
}

function patch(overrides: Partial<BalanceAdjustmentPatchDetails> = {}): BalanceAdjustmentPatchDetails {
  return {
    adjustmentId: event().id, date: event().date, capturedAt: '2026-10-14T05:01:00.000Z', source: event().source,
    common: { policy: '', changes: [change({ id: 'common-1', target: 'ドライブリバーサル', categoryLabel: '不具合修正' })] },
    characters: [character()], ...overrides,
  }
}

function catalog(overrides: Partial<BalanceAdjustmentDetailsCatalog> = {}): BalanceAdjustmentDetailsCatalog {
  return { schemaVersion: 1, generatedAt: '2026-10-14T05:02:00.000Z', patches: [patch()], ...overrides }
}

function manifest(): CharacterManifest {
  return {
    schemaVersion: 1, generatedAt: '2026-10-08T00:00:00Z',
    characters: [
      { id: 'ryu', name: 'リュウ', englishName: 'RYU', file: 'ryu.json' },
      { id: 'ehonda', name: 'エドモンド本田', englishName: 'E.HONDA', file: 'ehonda.json' },
      { id: 'yasmine', name: 'ヤスミン', englishName: 'YASMINE', file: 'yasmine.json' },
    ],
  }
}

test('公式の変更箇所・分類・本文・改行と出典を保持し、入力を変更しない', () => {
  const input = catalog({ patches: [patch({ characters: [character({
    changes: [change({ description: '①ガードバックを調整しました。\n②コンボ時の挙動を変更しました。' })],
  })] })] })
  const before = structuredClone(input)
  const result = parseBalanceAdjustmentDetails(input, history(), manifest())
  assert.deepEqual(result, input)
  assert.notStrictEqual(result.patches[0].characters[0], input.patches[0].characters[0])
  assert.equal(result.patches[0].common.changes[0].categoryLabel, '不具合修正')
  assert.deepEqual(input, before)
})

test('確認済みの変更なし・公式未掲載・本文未取込を区別する', () => {
  const input = catalog({ patches: [patch({ characters: [
    character({ changes: [], policy: '' }),
    character({ characterId: 'yasmine', name: 'ヤスミン', status: 'unlisted', source: null, policy: '', changes: [] }),
  ] })] })
  const result = parseBalanceAdjustmentDetails(input, history(), manifest())
  assert.equal(balanceAdjustmentCharacterStatus(result.patches[0], 'ryu'), 'unchanged')
  assert.equal(balanceAdjustmentCharacterStatus(result.patches[0], 'yasmine'), 'unlisted')
  assert.equal(balanceAdjustmentCharacterStatus(result.patches[0], 'ken'), 'unimported')
  assert.equal(balanceAdjustmentCharacterStatus(null, 'ryu'), 'unimported')
  assert.equal(balanceAdjustmentCharacterStatus(patch(), 'ryu'), 'ready')
  assert.strictEqual(balanceAdjustmentPatchDetails(result, event()), result.patches[0])
  assert.equal(balanceAdjustmentPatchDetails(result, event({ id: 'past-patch' })), null)
  assert.equal(balanceAdjustmentPatchDetails(result, event({ date: '2026-08-04' })), null)
})

test('未掲載には本文・出典・方針を付けず、掲載ページと混同させない', () => {
  for (const entry of [
    character({ status: 'unlisted' }),
    character({ status: 'unlisted', source: null, policy: '', changes: [change()] }),
    character({ status: 'unlisted', source: null, policy: '方針', changes: [] }),
    character({ status: 'ready', source: null }),
    character({ status: 'unknown' as never }),
  ]) assert.throws(() => parseBalanceAdjustmentDetails(catalog({ patches: [patch({ characters: [entry] })] })), /characters/)
})

test('キャラの安定IDと公式URL slugの相違を明示し、他キャラURLを拒否する', () => {
  const honda = character({ characterId: 'ehonda', name: 'エドモンド本田', source: { url: `${event().source.url}/honda`, title: '本田' } })
  assert.equal(parseBalanceAdjustmentDetails(catalog({ patches: [patch({ characters: [honda] })] }), history(), manifest()).patches[0].characters[0].characterId, 'ehonda')
  for (const slug of ['ehonda', 'ryu', '../honda', 'honda/']) {
    assert.throws(() => parseBalanceAdjustmentDetails(catalog({ patches: [patch({ characters: [
      { ...honda, source: { ...honda.source!, url: `${event().source.url}/${slug}` } },
    ] })] })), /source.url/)
  }
})

test('履歴のID・実日付・固定版URLおよびキャラ一覧と照合する', () => {
  for (const entry of [patch({ adjustmentId: 'wrong-patch' }), patch({ date: '2026-08-04' }),
    patch({ source: { url: event().source.url.replace('20260803', '20260804'), title: '別版' }, characters: [] }),
  ]) assert.throws(() => parseBalanceAdjustmentDetails(catalog({ patches: [entry] }), history()), /履歴|characters/)
  assert.throws(() => parseBalanceAdjustmentDetails(catalog(), history({ events: [] })), /履歴/)
  assert.throws(() => parseBalanceAdjustmentDetails(catalog({ patches: [patch({ characters: [character({ name: 'RYU' })] })] }), history(), manifest()), /キャラ一覧/)
  assert.throws(() => parseBalanceAdjustmentDetails(catalog({ patches: [patch({ characters: [character({
    characterId: 'ken', source: { url: `${event().source.url}/ken`, title: 'ケン' },
  })] })] }), history(), manifest()), /キャラ一覧/)
})

test('6桁の月版固定URLを維持し、URLにないリスト日を履歴から照合する', () => {
  const source = { url: 'https://www.streetfighter.com/6/buckler/ja-jp/battle_change/202405', title: '202405 Ver.' }
  const item = event({ id: 'battle-change-202405', date: '2024-05-22', dateBasis: 'list', source, announcement: null })
  const input = catalog({ patches: [patch({ adjustmentId: item.id, date: item.date, source,
    characters: [character({ source: { url: `${source.url}/ryu`, title: 'リュウ' } })],
  })] })
  const result = parseBalanceAdjustmentDetails(input, history({ events: [item] }), manifest())
  assert.equal(result.patches[0].date, '2024-05-22')
  assert.equal(result.patches[0].source.url, source.url)
  assert.throws(() => parseBalanceAdjustmentDetails(catalog({ patches: [{ ...input.patches[0], date: '2024-05-01' }] }), history({ events: [item] })), /履歴/)
})

test('日付の繰り上がり、時差の欠落、取得日時が生成日時より後のデータを拒否する', () => {
  for (const value of ['2026-02-29', '2026-04-31', '2026-13-01', '2026-08-00', '2026-8-3']) {
    assert.throws(() => parseBalanceAdjustmentDetails(catalog({ patches: [patch({ date: value })] })), /date/)
  }
  for (const value of ['2026-02-30T00:00:00Z', '2026-10-14T05:00:00', '2026-10-14T24:00:00Z', '2026-10-14T00:00:00+24:00']) {
    assert.throws(() => parseBalanceAdjustmentDetails(catalog({ generatedAt: value })), /generatedAt/)
    assert.throws(() => parseBalanceAdjustmentDetails(catalog({ patches: [patch({ capturedAt: value })] })), /capturedAt/)
  }
  assert.throws(() => parseBalanceAdjustmentDetails(catalog({ patches: [patch({ capturedAt: '2026-10-14T05:03:00Z' })] })), /capturedAt と generatedAt/)
  assert.equal(parseBalanceAdjustmentDetails(catalog({ patches: [patch({ date: '2024-02-29' })] })).patches[0].date, '2024-02-29')
})

test('ID・本文の非空文字列とID一意性を要求するが別キャラの変更ID空間は分離する', () => {
  for (const input of [null, [], { ...catalog(), schemaVersion: 2 }, { ...catalog(), patches: null },
    catalog({ patches: [patch(), patch()] }), catalog({ patches: [patch({ characters: [] })] }),
    catalog({ patches: [patch({ characters: [character(), character()] })] }),
    catalog({ patches: [patch({ common: { policy: '', changes: [change(), change()] } })] }),
    catalog({ patches: [patch({ characters: [character({ changes: [change(), change()] })] })] }),
  ]) assert.throws(() => parseBalanceAdjustmentDetails(input), /形式/)
  for (const field of ['id', 'target', 'categoryLabel', 'description'] as const) {
    for (const value of [null, 0, ' ', ' 前後の空白 ', ...(field === 'id' || field === 'description' ? [''] : [])]) {
      assert.throws(() => parseBalanceAdjustmentDetails(catalog({ patches: [patch({ characters: [character({ changes: [change({ [field]: value })] })] })] })), new RegExp(field))
    }
  }
  const second = character({ characterId: 'ken', name: 'ケン', source: { url: `${event().source.url}/ken`, title: 'ケン' } })
  assert.equal(parseBalanceAdjustmentDetails(catalog({ patches: [patch({ characters: [character(), second] })] })).patches[0].characters.length, 2)
})

test('公式で空の変更箇所・分類を保持し、本文のある変更を0件や未取込にしない', () => {
  const result = parseBalanceAdjustmentDetails(catalog({ patches: [patch({ characters: [character({ changes: [change({ target: '', categoryLabel: '' })] })] })] }))
  const item = result.patches[0].characters[0]
  assert.equal(item.changes.length, 1)
  assert.equal(item.changes[0].target, '')
  assert.equal(item.changes[0].categoryLabel, '')
  assert.equal(item.changes[0].description, change().description)
  assert.equal(balanceAdjustmentCharacterStatus(result.patches[0], 'ryu'), 'ready')
})

test('出典を日本語公式の固定版と正しいキャラページに限定する', () => {
  for (const url of [
    'https://example.com/6/buckler/ja-jp/battle_change/20260803',
    'https://www.streetfighter.com.example.com/6/buckler/ja-jp/battle_change/20260803',
    'http://www.streetfighter.com/6/buckler/ja-jp/battle_change/20260803',
    'https://someone@www.streetfighter.com/6/buckler/ja-jp/battle_change/20260803',
    'https://www.streetfighter.com:1234/6/buckler/ja-jp/battle_change/20260803',
    `${event().source.url}?preview=1`, `${event().source.url}#latest`,
    'https://www.streetfighter.com/6/buckler/en/battle_change/20260803',
    'https://www.streetfighter.com/6/buckler/ja-jp/information/battle_change/1', 'javascript:alert(1)',
  ]) assert.throws(() => parseBalanceAdjustmentDetails(catalog({ patches: [patch({ source: { url, title: '出典' } })] })), /source.url/)
  assert.throws(() => parseBalanceAdjustmentDetails(catalog({ patches: [patch({ characters: [character({
    source: { url: `${event().source.url}/ken`, title: '別キャラ' },
  })] })] })), /source.url/)
})

test('詳細取得の並行要求を共有し、通信・JSON・形式・履歴不一致の失敗後に再試行する', async (t) => {
  const input = catalog()
  const detailsUrls: string[] = []
  const historyUrls: string[] = []
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request) => {
    const value = String(url)
    if (value.endsWith('/balance-adjustments.json')) {
      historyUrls.push(value)
      return Response.json(history())
    }
    detailsUrls.push(value)
    if (detailsUrls.length === 1) throw new Error('network failure')
    if (detailsUrls.length === 2) return new Response(null, { status: 503 })
    if (detailsUrls.length === 3) return new Response('{', { status: 200 })
    if (detailsUrls.length === 4) return Response.json({ ...input, schemaVersion: 2 })
    if (detailsUrls.length === 5) return Response.json(catalog({ patches: [patch({ adjustmentId: 'wrong-patch' })] }))
    return Response.json(input)
  })
  for (const error of [/network failure/, /読み込めません/, /JSON/, /schemaVersion/, /履歴/]) {
    const first = loadBalanceAdjustmentDetails()
    const duplicate = loadBalanceAdjustmentDetails()
    assert.strictEqual(first, duplicate)
    await assert.rejects(first, error)
    await assert.rejects(duplicate, error)
  }
  const first = loadBalanceAdjustmentDetails()
  const duplicate = loadBalanceAdjustmentDetails()
  assert.strictEqual(first, duplicate)
  const [firstResult, duplicateResult] = await Promise.all([first, duplicate])
  assert.strictEqual(firstResult, duplicateResult)
  assert.deepEqual(firstResult, input)
  assert.strictEqual(await loadBalanceAdjustmentDetails(), firstResult)
  assert.deepEqual(await loadBalanceAdjustmentDetails(history(), manifest()), input)
  await assert.rejects(loadBalanceAdjustmentDetails(history({ events: [] }), manifest()), /履歴/)
  assert.deepEqual(await loadBalanceAdjustmentDetails(history(), manifest()), input)
  assert.deepEqual(detailsUrls, Array(7).fill('/data/balance-adjustment-details.json'))
  assert.deepEqual(historyUrls, ['/data/balance-adjustments.json'])
})

test('公開前検証で8月の全31キャラ・公式未掲載・変更数を照合し、部分取得を公開しない', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'sf6-adjustment-validator-'))
  const files = ['details.json', 'history.json', 'characters.json'].map((name) => join(directory, name))
  t.after(async () => {
    // Only the three files created by this test are removed; no recursive deletion.
    await Promise.all(files.map((file) => unlink(file)))
    await rmdir(directory)
  })
  const characters = [character(), ...Array.from({ length: 29 }, (_, index) => {
    const characterId = `character-${index}`
    return character({ characterId, name: `キャラ${index}`, source: { url: `${event().source.url}/${characterId}`, title: `キャラ${index}` } })
  }), character({ characterId: 'yasmine', name: 'ヤスミン', status: 'unlisted', source: null, policy: '', changes: [] })]
  const expectedManifest: CharacterManifest = {
    schemaVersion: 1, generatedAt: manifest().generatedAt,
    characters: characters.map(({ characterId, name }) => ({ id: characterId, name, englishName: characterId.toUpperCase(), file: `${characterId}.json` })),
  }
  const input = catalog({ patches: [patch({ characters })] })
  await Promise.all([
    writeFile(files[0], JSON.stringify(input)), writeFile(files[1], JSON.stringify(history())), writeFile(files[2], JSON.stringify(expectedManifest)),
  ])
  assert.deepEqual(await validateBalanceAdjustmentDetails(...files as [string, string, string]),
    { patches: 1, characters: 31, unlisted: 1, changes: 31, commonChanges: 1 })
  const olderSource = { url: 'https://www.streetfighter.com/6/buckler/ja-jp/battle_change/20260415', title: '2026.04.15 update' }
  const olderEvent = event({ id: 'battle-change-20260415', date: '2026-04-15', source: olderSource, dateBasis: 'list', announcement: null })
  await writeFile(files[1], JSON.stringify(history({ events: [olderEvent, event()] })))
  await assert.rejects(validateBalanceAdjustmentDetails(...files as [string, string, string]), /履歴の全件/)
  const olderPatch = patch({ adjustmentId: olderEvent.id, date: olderEvent.date, source: olderSource,
    characters: characters.map((entry) => ({ ...entry, status: 'unlisted', source: null, policy: '', changes: [] })),
  })
  await writeFile(files[0], JSON.stringify(catalog({ patches: [olderPatch, input.patches[0]] })))
  assert.deepEqual(await validateBalanceAdjustmentDetails(...files as [string, string, string]),
    { patches: 2, characters: 62, unlisted: 32, changes: 32, commonChanges: 2 })
  await writeFile(files[0], JSON.stringify(catalog({ patches: [{ ...olderPatch, characters: olderPatch.characters.slice(0, 30) }, input.patches[0]] })))
  await assert.rejects(validateBalanceAdjustmentDetails(...files as [string, string, string]), /全キャラ.*battle-change-20260415/)
  await writeFile(files[1], JSON.stringify(history()))
  await writeFile(files[0], JSON.stringify(catalog({ patches: [patch({ characters: characters.slice(0, 30) })] })))
  await assert.rejects(validateBalanceAdjustmentDetails(...files as [string, string, string]), /全キャラ/)
  await writeFile(files[0], JSON.stringify(catalog({ patches: [patch({ characters: [
    ...characters.slice(0, 30), character({ characterId: 'yasmine', name: 'ヤスミン', source: { url: `${event().source.url}/yasmine`, title: 'ヤスミン' }, changes: [] }),
  ] })] })))
  await assert.rejects(validateBalanceAdjustmentDetails(...files as [string, string, string]), /掲載範囲/)
  await writeFile(files[0], JSON.stringify(catalog({ patches: [] })))
  await assert.rejects(validateBalanceAdjustmentDetails(...files as [string, string, string]), /収録済み/)
})
