import assert from 'node:assert/strict'
import test from 'node:test'
import { balanceAdjustmentDetailsFromSnapshot, balanceAdjustmentHtmlText } from './balance-adjustment-snapshot.ts'
import type { CharacterManifest } from '../../src/types/characters.ts'
import type { BalanceAdjustmentCatalog } from '../../src/types/balanceAdjustments.ts'

const manifest: CharacterManifest = {
  schemaVersion: 1, generatedAt: '2026-10-14T00:00:00.000Z',
  characters: [
    { id: 'ryu', name: 'リュウ', englishName: 'RYU', file: 'ryu.json' },
    { id: 'ehonda', name: 'エドモンド本田', englishName: 'E.HONDA', file: 'ehonda.json' },
    { id: 'yasmine', name: 'ヤスミン', englishName: 'YASMINE', file: 'yasmine.json' },
  ],
}

function fixture() {
  const roster = [
    { fighter_id: 'ryu', fighter_tool_name: 'ryu', fighter_url_name: 'ryu', fighter_alpha: 'RYU', exist: true },
    { fighter_id: 'honda', fighter_tool_name: 'honda', fighter_url_name: 'honda', fighter_alpha: 'E.HONDA', exist: true },
    { fighter_id: 'yasmine', fighter_tool_name: 'yasmine', fighter_url_name: 'yasmine', fighter_alpha: 'YASMINE', exist: false },
  ]
  const next = {
    isFallback: false, query: { version: '20260803' } as { version: string; character_id?: string },
    props: { pageProps: { __lang: 'ja-jp', common: { statusCode: 200, isError: false },
      adjust: {
        title: '2026.08.03 update', current_version: '20260803', current_fighter: '', fighter_list: roster,
        policy: [{ title: '全体コンセプト', text: '全体方針<br><br>操作タイプの方針' }, { title: 'honda', text: '本田の方針' }],
        common: [{ title: 'ドライブリバーサル', body: [{ category: '不具合修正', text: '入力の不具合を修正しました。' }] }],
        fighter: [
          { fighter_id: 'リュウ', fighter_tool_name: 'ryu', fighter_url_name: 'ryu',
            detail: [{ title: '【OD】波動拳<br>(↓↘→+PP)', body: [{ category: '調整', text: "①<div data-word='combo_count'>コンボカウント</div>加算値を減少しました。<br>②上限値を増加しました。" }] }] },
          { fighter_id: 'エドモンド本田', fighter_tool_name: 'honda', fighter_url_name: 'honda',
            detail: [{ title: '立ち中P', body: [{ category: '調整・不具合修正', text: '攻撃発生を9Fから8Fに変更しました。' }] }] },
        ],
      },
    } },
  }
  const snapshot = () => ({ url: 'https://www.streetfighter.com/6/buckler/ja-jp/battle_change/20260803',
    capturedAt: '2026-10-14T01:00:00.000Z',
    html: `<title>バトル変更リスト 2026.08.03 update｜Buckler&#x27;s Boot Camp</title><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(next)}</script>` })
  const parse = () => balanceAdjustmentDetailsFromSnapshot(snapshot(), manifest, '2026-10-14T02:00:00.000Z')
  return { next, snapshot, parse }
}

test('imports official targets and wording, maps stable IDs, and keeps confirmed unlisted distinct', () => {
  const patch = fixture().parse().patches[0]
  assert.equal(patch.common.changes.length, 1)
  assert.equal(patch.common.policy, '全体方針\n\n操作タイプの方針')
  assert.equal(patch.characters.length, 3)
  const [ryu, honda, yasmine] = patch.characters
  assert.equal(ryu.changes.length, 1, '①② within one official change remain one item')
  assert.equal(ryu.changes[0].target, '【OD】波動拳\n(↓↘→+PP)')
  assert.equal(ryu.changes[0].description, '①コンボカウント加算値を減少しました。\n②上限値を増加しました。')
  assert.equal(honda.characterId, 'ehonda')
  assert.ok(honda.source?.url.endsWith('/honda'))
  assert.equal(honda.policy, '本田の方針')
  assert.equal(honda.changes[0].categoryLabel, '調整・不具合修正')
  assert.deepEqual(yasmine, { characterId: 'yasmine', name: 'ヤスミン', status: 'unlisted', source: null, policy: '', changes: [] })
  assert.equal(ryu.changes[0].id, fixture().parse().patches[0].characters[0].changes[0].id)
})

test('rejects a different patch, language, fallback, or selected-character page', () => {
  const mutations = [
    (f: ReturnType<typeof fixture>) => { f.next.props.pageProps.adjust.current_version = '20260317' },
    (f: ReturnType<typeof fixture>) => { f.next.query.version = '20260317' },
    (f: ReturnType<typeof fixture>) => { f.next.props.pageProps.__lang = 'en' },
    (f: ReturnType<typeof fixture>) => { f.next.isFallback = true },
    (f: ReturnType<typeof fixture>) => { f.next.query.character_id = 'ryu' },
    (f: ReturnType<typeof fixture>) => { f.next.props.pageProps.common.isError = true },
  ]
  for (const mutate of mutations) { const f = fixture(); mutate(f); assert.throws(f.parse, /一致しません/) }
})

test('rejects missing, empty, duplicated, mismatched, or extra published character data', () => {
  const missing = fixture()
  missing.next.props.pageProps.adjust.fighter.pop()
  assert.throws(missing.parse, /不足/)
  const empty = fixture()
  empty.next.props.pageProps.adjust.fighter[0].detail = []
  assert.throws(empty.parse, /空/)
  const duplicate = fixture()
  duplicate.next.props.pageProps.adjust.fighter_list.push(duplicate.next.props.pageProps.adjust.fighter_list[0])
  assert.throws(duplicate.parse, /重複/)
  const mismatch = fixture()
  mismatch.next.props.pageProps.adjust.fighter[0].fighter_id = 'ケン'
  assert.throws(mismatch.parse, /一致/)
  const unknown = fixture()
  unknown.next.props.pageProps.adjust.fighter_list.push({ fighter_id: 'ken', fighter_tool_name: 'ken', fighter_url_name: 'ken', fighter_alpha: 'KEN', exist: true })
  assert.throws(unknown.parse, /対応/)
})

test('never turns a missing source record into a confirmed unlisted character', () => {
  const f = fixture()
  f.next.props.pageProps.adjust.fighter_list.pop()
  assert.throws(f.parse, /掲載状況/)
  const snapshot = f.snapshot()
  snapshot.html = '<title>Loading</title>'
  assert.throws(() => balanceAdjustmentDetailsFromSnapshot(snapshot, manifest), /静的ページデータ/)
  const inconsistent = fixture()
  inconsistent.next.props.pageProps.adjust.policy.push({ title: 'yasmine', text: '実際には調整方針がある' })
  assert.throws(inconsistent.parse, /未掲載キャラに調整方針/)
})

test('preserves known command-icon alternatives and entities; rejects unsupported markup or icons', () => {
  assert.equal(balanceAdjustmentHtmlText('中<img src="/icons/icon_punch.png"/><br><img alt="↓↘→" src="/command.png"/>+P &amp; K'), '中P\n↓↘→+P & K')
  assert.throws(() => balanceAdjustmentHtmlText('<img src="/unknown.png"/>'), /代替表記/)
  assert.throws(() => balanceAdjustmentHtmlText('<script>ignored</script>'), /未対応/)
  assert.throws(() => balanceAdjustmentHtmlText('&unknown;'), /文字参照/)
})

test('preserves an officially empty target and category without dropping its change row', () => {
  const f = fixture()
  const detail = f.next.props.pageProps.adjust.fighter[0].detail[0]
  detail.title = ''
  detail.body[0].category = ''
  const result = f.parse().patches[0].characters[0].changes[0]
  assert.equal(result.target, '')
  assert.equal(result.categoryLabel, '')
  assert.ok(result.description)
})

test('uses matching history dates for six-digit versions and accepts original unpadded titles', () => {
  const f = fixture()
  f.next.query.version = '202405'
  f.next.props.pageProps.adjust.current_version = '202405'
  f.next.props.pageProps.adjust.title = '202405 Ver.'
  const snapshot = { ...f.snapshot(), url: 'https://www.streetfighter.com/6/buckler/ja-jp/battle_change/202405' }
  const history: BalanceAdjustmentCatalog = { schemaVersion: 1,
    generatedAt: '2026-10-14T00:00:00.000Z', checkedAt: '2026-10-14T00:00:00.000Z', coverage: { fromMonth: '2024-05', toMonth: '2024-05' },
    source: { url: 'https://www.streetfighter.com/6/buckler/ja-jp/battle_change', title: 'バトル変更リスト' },
    events: [{ id: 'battle-change-202405', date: '2024-05-22', dateBasis: 'list', kindLabel: '全体調整', title: '202405 Ver.',
      source: { url: snapshot.url, title: '202405 Ver.' }, announcement: null }],
  }
  const parsed = balanceAdjustmentDetailsFromSnapshot(snapshot, manifest, '2026-10-14T02:00:00.000Z', history).patches[0]
  assert.equal(parsed.date, '2024-05-22')
  assert.equal(parsed.adjustmentId, 'battle-change-202405')
  assert.throws(() => balanceAdjustmentDetailsFromSnapshot(snapshot, manifest), /履歴の日付/)
  const unpadded = fixture()
  unpadded.next.query.version = '20231201'
  unpadded.next.props.pageProps.adjust.current_version = '20231201'
  unpadded.next.props.pageProps.adjust.title = '2023.12.1 update'
  assert.equal(balanceAdjustmentDetailsFromSnapshot({ ...unpadded.snapshot(), url: 'https://www.streetfighter.com/6/buckler/ja-jp/battle_change/20231201' }, manifest).patches[0].date, '2023-12-01')
})

test('keeps numbered and untitled overall policies in official order and character policies separate', () => {
  const f = fixture()
  f.next.props.pageProps.adjust.policy = [
    { title: '', text: '全体方針の前文' },
    { title: '1. 第一の目的', text: '一つ目の方針' },
    { title: '2. 第二の目的', text: '二つ目の方針' },
    { title: 'honda', text: '本田の方針' },
  ]
  const p = f.parse().patches[0]
  assert.equal(p.common.policy, '全体方針の前文\n\n1. 第一の目的\n一つ目の方針\n\n2. 第二の目的\n二つ目の方針')
  assert.equal(p.characters[1].policy, '本田の方針')
})

test('retains original cancellation and emphasis meaning, including styled official categories', () => {
  const f = fixture()
  const detail = f.next.props.pageProps.adjust.common[0]
  detail.title = "<span class='battle_change_through'>ジャストパリィ</span>"
  detail.body[0] = { category: '共通調整2', text: "<span class='battle_change_through'>旧記載</span><br><span class='battle_change_caution'>訂正された記載</span>" }
  Object.assign(f.next.props.pageProps, { __namespaces: { adjust: { '[t]共通調整2': "<span class='battle_change_through'>共通調整</span>" } } })
  const change = f.parse().patches[0].common.changes[0]
  assert.equal(change.target, '【取消線】ジャストパリィ【/取消線】')
  assert.equal(change.categoryLabel, '共通調整（取消線）')
  assert.equal(change.description, '【取消線】旧記載【/取消線】\n【強調】訂正された記載【/強調】')
  delete (f.next.props.pageProps as { __namespaces?: unknown }).__namespaces
  assert.throws(f.parse, /category translation/)
})

test('preserves ordered lists, bullet lists, block line breaks and official related links', () => {
  const result = balanceAdjustmentHtmlText("前文<ul style='list-style: decimal;'><li>一つ目</li><li>二つ目</li></ul><p>対象技</p><ul style='list-style: disc;'><li>波動拳</li><li>昇龍拳</li></ul><span style='display: block;'>補足</span><a href='20250205'>別の変更リスト</a>")
  assert.equal(result, '前文\n1. 一つ目\n2. 二つ目\n対象技\n・波動拳\n・昇龍拳\n補足\n別の変更リスト（https://www.streetfighter.com/6/buckler/ja-jp/battle_change/20250205）')
  assert.throws(() => balanceAdjustmentHtmlText("<a href='javascript:example'>不正リンク</a>"), /リンク先が不正/)
})

test('separate official body rows remain separate changes and their categories remain distinct', () => {
  const f = fixture()
  f.next.props.pageProps.adjust.fighter[0].detail[0].body.push({ category: '不具合修正', text: '別の不具合を修正しました。' })
  const changes = f.parse().patches[0].characters[0].changes
  assert.equal(changes.length, 2)
  assert.deepEqual(changes.map((change) => change.categoryLabel), ['調整', '不具合修正'])
  assert.equal(changes[0].target, changes[1].target)
  assert.notEqual(changes[0].id, changes[1].id)
})
