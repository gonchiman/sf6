export const HOME_HREF = import.meta.env.BASE_URL

export const APP_NAV_ITEMS = [
  { id: 'win-rates', label: '勝率', href: '#win-rates' },
] as const

export type NavigationPage = (typeof APP_NAV_ITEMS)[number]['id']
