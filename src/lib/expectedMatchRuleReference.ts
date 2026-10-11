import { EXPECTED_MATCH_RULE_SOURCES } from './expectedMatchModel.ts'

/** Dates describe the referenced publications, separately from win-rate months. */
export const EXPECTED_MATCH_RULE_REFERENCE = {
  checkedAt: '2026-10-11',
  example: { winLp: 50, lowRankBonusStep: 50 },
  sources: {
    official: {
      title: 'Capcom Showcase Recap',
      url: EXPECTED_MATCH_RULE_SOURCES.rankRules,
      publishedAt: '2023-04-20',
    },
    guide: {
      title: 'ランクマッチのポイント解説',
      url: EXPECTED_MATCH_RULE_SOURCES.bonusAssumptions,
      publishedAt: '2026-09-29',
    },
  },
  rows: [
    { item: '基本LP', description: '勝利 +50 / 敗北 −40', status: '参考情報', source: 'guide' },
    { item: 'ROOKIE', description: '敗北でLPを失わない', status: '公式資料に記載', source: 'official' },
    { item: 'IRON〜GOLD', description: '下位リーグへ降格しない', status: '公式資料に記載', source: 'official' },
    { item: 'ROOKIE〜GOLD・連勝ボーナス', description: '3連勝 +50、以後1勝ごとに +50、10連勝以上 +400', status: '参考情報', source: 'guide' },
    { item: 'PLATINUM ★1〜2・連勝ボーナス', description: '10連勝以上で追加 +500', status: '参考情報（公式の金額は未確認）', source: 'guide' },
    { item: 'PLATINUM ★3〜5・連勝ボーナス', description: '10連勝以上で追加 +1,000。★3は15,400 LPから', status: '参考情報（公式の金額は未確認）', source: 'guide' },
    { item: 'DIAMOND・連勝ボーナス', description: '10連勝以上で追加 +1,000', status: '参考情報（公式の金額は未確認）', source: 'guide' },
    { item: '降格保護', description: 'DIAMOND以下に1回の降格保護', status: '公式資料に記載', source: 'official' },
  ],
} as const
