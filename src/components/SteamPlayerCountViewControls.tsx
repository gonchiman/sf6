export const STEAM_HOURLY_VIEWS = [['chart', 'グラフ'], ['table', '表']] as const
export const STEAM_COMPARISON_SCALES = [['people', '人数'], ['index', '各ゲーム平均＝100']] as const
export const STEAM_COMPARISON_METRICS = [['mean', '期間平均'], ['peak', '観測最大']] as const
export type SteamHourlyView = typeof STEAM_HOURLY_VIEWS[number][0]
export type SteamComparisonScale = typeof STEAM_COMPARISON_SCALES[number][0]
export type SteamComparisonMetric = typeof STEAM_COMPARISON_METRICS[number][0]

export function steamHourlyLocationSegments(view: SteamHourlyView, scale?: SteamComparisonScale): string[] {
  const segments: string[] = [STEAM_HOURLY_VIEWS.find(([id]) => id === view)![1]]
  if (view === 'chart' && scale) segments.push(STEAM_COMPARISON_SCALES.find(([id]) => id === scale)![1])
  return segments
}

export function SteamPlayerCountHourlyViewControls({ value, onChange }: {
  value: SteamHourlyView
  onChange: (value: SteamHourlyView) => void
}) {
  return <div className="win-rates-view-selector steam-player-count-format-controls" role="group" aria-label="時間帯比較の表示形式">
    {STEAM_HOURLY_VIEWS.map(([id, label]) => <button key={id} type="button" className="win-rates-button"
      aria-pressed={value === id} onClick={() => onChange(id)}>{label}</button>)}
  </div>
}
