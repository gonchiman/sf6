export const HOME_HREF = import.meta.env.BASE_URL

export const APP_NAV_ITEMS = [
  { id: 'win-rates', label: '勝率', href: '#win-rates' },
  { id: 'characters', label: 'キャラ情報', href: '#characters' },
  { id: 'win-rate-history', label: '勝率推移', href: '#win-rate-history' },
  { id: 'expected-matches', label: '期待試合数', href: '#expected-matches' },
  { id: 'monthly-win-rate-statistics', label: '月別勝率統計', href: '#monthly-win-rate-statistics' },
  { id: 'control-type-ratio', label: '操作タイプ比率（推定）', href: '#control-type-ratio' },
  { id: 'character-traits', label: 'キャラ分類', href: '#character-traits' },
] as const

export type NavigationPage = (typeof APP_NAV_ITEMS)[number]['id']
