export const HOME_HREF = import.meta.env.BASE_URL

export const APP_NAV_ITEMS = [
  { id: 'win-rates', label: '勝率', href: '#win-rates' },
  { id: 'usage-rates', label: '使用率', href: '#usage-rates' },
  { id: 'characters', label: 'キャラ情報', href: '#characters' },
  { id: 'win-rate-history', label: '勝率推移', href: '#win-rate-history' },
  { id: 'expected-matches', label: '期待試合数', href: '#expected-matches' },
  { id: 'monthly-win-rate-statistics', label: '月別勝率統計', href: '#monthly-win-rate-statistics' },
  { id: 'monthly-usage-rate-statistics', label: '月別使用率統計', href: '#monthly-usage-rate-statistics' },
  { id: 'win-usage-correlation', label: '勝率と使用率', href: '#win-usage-correlation' },
  { id: 'control-type-ratio', label: '操作タイプ比率（推定）', href: '#control-type-ratio' },
  { id: 'rank-distribution', label: 'ランク分布', href: '#rank-distribution' },
  { id: 'new-account-observation', label: '新規参入観測', href: '#new-account-observation' },
  { id: 'character-traits', label: 'キャラ分類', href: '#character-traits' },
  { id: 'balance-adjustments', label: 'バトル変更一覧', href: '#balance-adjustments' },
] as const

export type NavigationPage = (typeof APP_NAV_ITEMS)[number]['id']
