import assert from 'node:assert/strict'
import { test } from 'node:test'
import { balanceAdjustmentDetailHash, characterHash, parseHashRoute } from './routes.ts'

test('標本調査の直接URLを区別する', () => {
  assert.deepEqual(parseHashRoute('#sample-survey'), { page: 'sample-survey' })
  assert.deepEqual(parseHashRoute('#sample-survey/'), { page: 'sample-survey' })
  assert.deepEqual(parseHashRoute('#sample-survey/unknown'), { page: 'win-rates' })
})

test('並列取得テストの直接URLを区別する', () => {
  assert.deepEqual(parseHashRoute('#parallel-fetch-test'), { page: 'parallel-fetch-test' })
  assert.deepEqual(parseHashRoute('#parallel-fetch-test/'), { page: 'parallel-fetch-test' })
  assert.deepEqual(parseHashRoute('#parallel-fetch-test/unknown'), { page: 'win-rates' })
  assert.deepEqual(parseHashRoute('#parallel-fetch-test-invalid'), { page: 'win-rates' })
})

test('キャラ実装日一覧の直接URLを既存キャラ情報と区別し、余分なパスを受け入れない', () => {
  assert.deepEqual(parseHashRoute('#character-releases'), { page: 'character-releases' })
  assert.deepEqual(parseHashRoute('#character-releases/'), { page: 'character-releases' })
  assert.deepEqual(parseHashRoute('#character-releases/ryu'), { page: 'win-rates' })
  assert.deepEqual(parseHashRoute('#character-releases-invalid'), { page: 'win-rates' })
})

test('勝率と使用率の相関ページの直接URLを区別する', () => {
  assert.deepEqual(parseHashRoute('#win-usage-correlation'), { page: 'win-usage-correlation' })
  assert.deepEqual(parseHashRoute('#win-usage-correlation/'), { page: 'win-usage-correlation' })
  assert.deepEqual(parseHashRoute('#win-usage-correlation/unknown'), { page: 'win-rates' })
})

test('月別使用率統計の直接URLを勝率統計と区別し、不正な派生URLを受け入れない', () => {
  assert.deepEqual(parseHashRoute('#monthly-usage-rate-statistics'), { page: 'monthly-usage-rate-statistics' })
  assert.deepEqual(parseHashRoute('#monthly-usage-rate-statistics/'), { page: 'monthly-usage-rate-statistics' })
  assert.deepEqual(parseHashRoute('#monthly-win-rate-statistics'), { page: 'monthly-win-rate-statistics' })
  assert.deepEqual(parseHashRoute('#monthly-usage-rate-statistics/unknown'), { page: 'win-rates' })
})

test('既存の勝率URLとキャラ一覧・キャラ直接URLを読み取る', () => {
  for (const hash of ['', '#', '#win-rates', '#unknown']) {
    assert.deepEqual(parseHashRoute(hash), { page: 'win-rates' })
  }
  assert.deepEqual(parseHashRoute('#characters'), { page: 'characters', characterId: null })
  assert.deepEqual(parseHashRoute('#characters/'), { page: 'characters', characterId: null })
  assert.deepEqual(parseHashRoute(characterHash('gouki_akuma')), { page: 'characters', characterId: 'gouki_akuma' })
})

test('不明・壊れたキャラIDも選択ページで扱い、URL解析で落ちない', () => {
  assert.deepEqual(parseHashRoute('#characters/%'), { page: 'characters', characterId: '%' })
  assert.deepEqual(parseHashRoute('#characters/no-such-character'), { page: 'characters', characterId: 'no-such-character' })
  const id = '名前/複合'
  assert.deepEqual(parseHashRoute(characterHash(id)), { page: 'characters', characterId: id })
})

test('勝率推移の直接URLは既存ページと区別して読み取る', () => {
  assert.deepEqual(parseHashRoute('#win-rate-history'), { page: 'win-rate-history' })
  assert.deepEqual(parseHashRoute('#win-rate-history/'), { page: 'win-rate-history' })
  assert.deepEqual(parseHashRoute('#win-rate-history-invalid'), { page: 'win-rates' })
})

test('操作タイプ比率の直接URLを独立したページとして読み取る', () => {
  assert.deepEqual(parseHashRoute('#control-type-ratio'), { page: 'control-type-ratio' })
  assert.deepEqual(parseHashRoute('#control-type-ratio/'), { page: 'control-type-ratio' })
  assert.deepEqual(parseHashRoute('#control-type-ratio/unknown'), { page: 'win-rates' })
})

test('調整一覧の直接URLを独立したページとして読み取る', () => {
  assert.deepEqual(parseHashRoute('#balance-adjustments'), { page: 'balance-adjustments' })
  assert.deepEqual(parseHashRoute('#balance-adjustments/'), { page: 'balance-adjustments' })
})

test('調整詳細のURLは日付ではなく調整IDを保持し、不明IDも詳細ページで扱う', () => {
  for (const adjustmentId of ['battle-change-202405', 'unknown', '同日/別の調整']) {
    assert.deepEqual(parseHashRoute(balanceAdjustmentDetailHash(adjustmentId)), {
      page: 'balance-adjustment-detail', adjustmentId, scope: null,
    })
  }
  assert.equal(balanceAdjustmentDetailHash('battle-change-202405'), '#balance-adjustments/battle-change-202405')
})

test('調整詳細は共通・キャラの表示対象をURLで往復し、すべての表示ではqueryを省く', () => {
  for (const scope of ['__common__', 'ryu', '名前/複合 &+']) {
    const hash = balanceAdjustmentDetailHash('調整/ID', scope)
    assert.deepEqual(parseHashRoute(hash), {
      page: 'balance-adjustment-detail', adjustmentId: '調整/ID', scope,
    })
  }
  assert.equal(balanceAdjustmentDetailHash('event', '__common__'), '#balance-adjustments/event?scope=__common__')
  assert.equal(balanceAdjustmentDetailHash('event', null), '#balance-adjustments/event')
  assert.equal(balanceAdjustmentDetailHash('event', ''), '#balance-adjustments/event')
  assert.deepEqual(parseHashRoute('#balance-adjustments/event?scope='), {
    page: 'balance-adjustment-detail', adjustmentId: 'event', scope: null,
  })
})

test('壊れたpercentの調整ID・対象でもURL解析は落ちず、余計なパスは受け入れない', () => {
  assert.deepEqual(parseHashRoute('#balance-adjustments/%?scope=%'), {
    page: 'balance-adjustment-detail', adjustmentId: '%', scope: '%',
  })
  for (const hash of [
    '#balance-adjustments/event/extra',
    '#balance-adjustments//event',
    '#balance-adjustments/?scope=ryu',
    '#balance-adjustments-invalid/event',
    '#balance-adjustments/event#extra',
  ]) {
    assert.deepEqual(parseHashRoute(hash), { page: 'win-rates' })
  }
})

test('使用率の直接URLを独立したページとして読み取り、壊れたURLを混ぜない', () => {
  assert.deepEqual(parseHashRoute('#usage-rates'), { page: 'usage-rates' })
  assert.deepEqual(parseHashRoute('#usage-rates/'), { page: 'usage-rates' })
  assert.deepEqual(parseHashRoute('#usage-rates/unknown'), { page: 'win-rates' })
})

test('ランク分布の直接URLを独立したページとして読み取る', () => {
  assert.deepEqual(parseHashRoute('#rank-distribution'), { page: 'rank-distribution' })
  assert.deepEqual(parseHashRoute('#rank-distribution/'), { page: 'rank-distribution' })
  assert.deepEqual(parseHashRoute('#rank-distribution/unknown'), { page: 'win-rates' })
  assert.deepEqual(parseHashRoute('#rank-distribution-invalid'), { page: 'win-rates' })
})

test('期待試合数の直接URLを独立したページとして読み取る', () => {
  assert.deepEqual(parseHashRoute('#expected-matches'), { page: 'expected-matches' })
  assert.deepEqual(parseHashRoute('#expected-matches/'), { page: 'expected-matches' })
  assert.deepEqual(parseHashRoute('#expected-matches/unknown'), { page: 'win-rates' })
})

test('新規参入観測の直接URLを独立したページとして読み取る', () => {
  assert.deepEqual(parseHashRoute('#new-account-observation'), { page: 'new-account-observation' })
  assert.deepEqual(parseHashRoute('#new-account-observation/'), { page: 'new-account-observation' })
  assert.deepEqual(parseHashRoute('#new-account-observation/unknown'), { page: 'win-rates' })
  assert.deepEqual(parseHashRoute('#new-account-observation-invalid'), { page: 'win-rates' })
})

test('キャラ分類の直接URLを独立したページとして読み取る', () => {
  assert.deepEqual(parseHashRoute('#character-traits'), { page: 'character-traits' })
  assert.deepEqual(parseHashRoute('#character-traits/'), { page: 'character-traits' })
  assert.deepEqual(parseHashRoute('#character-traits/unknown'), { page: 'win-rates' })
})
