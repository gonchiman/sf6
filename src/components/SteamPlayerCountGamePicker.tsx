import { useRef, useState } from 'react'
import { DEFAULT_STEAM_PLAYER_COUNT_GAME, STEAM_PLAYER_COUNT_GAMES } from '../lib/steamPlayerCountGames'
import { steamPlayerCountGameLabel } from '../lib/steamPlayerCountGameColors'
import type { SteamPlayerCountAppId } from '../types/steamPlayerCount'
import { ComparisonGridOption } from './ComparisonSelection'
import { SteamPlayerCountGameKey } from './SteamPlayerCountComparisonCharts'

const MODES = [['single', '単独表示'], ['multiple', '複数選択']] as const
type Mode = typeof MODES[number][0]
const allIds = STEAM_PLAYER_COUNT_GAMES.map(game => game.appId)
const defaultId = DEFAULT_STEAM_PLAYER_COUNT_GAME.appId

export function SteamPlayerCountGamePicker({ appIds, onChange }: {
  appIds: readonly SteamPlayerCountAppId[]
  onChange: (ids: SteamPlayerCountAppId[]) => void
}) {
  const [mode, setMode] = useState<Mode>(appIds.length > 1 ? 'multiple' : 'single')
  const lastPicked = useRef(appIds[0])
  const single = mode === 'single'

  function changeMode(next: Mode) {
    setMode(next)
    if (next === 'single' && appIds.length > 1) onChange([lastPicked.current])
  }

  function pick(id: SteamPlayerCountAppId) {
    if (single) {
      lastPicked.current = id
      if (appIds[0] !== id) onChange([id])
    } else if (appIds.includes(id)) {
      const remaining = appIds.filter(item => item !== id)
      if (!remaining.length) return
      if (lastPicked.current === id) lastPicked.current = remaining[0]
      onChange(remaining)
    } else {
      lastPicked.current = id
      onChange(allIds.filter(item => item === id || appIds.includes(item)))
    }
  }

  return <div className="steam-game-picker">
    <div className="steam-game-picker-toolbar">
      <div className="win-rates-view-selector steam-game-modes" role="group" aria-label="ゲームの選び方">
        {MODES.map(([id, label]) => <button type="button" key={id} className="win-rates-button"
          aria-pressed={mode === id} onClick={() => changeMode(id)}>{label}</button>)}
      </div>
      {!single && <div className="steam-player-count-game-actions" role="group" aria-label="ゲーム選択の操作">
        <button type="button" className="win-rates-button" disabled={appIds.length === allIds.length}
          onClick={() => onChange([...allIds])}>全選択</button>
        <button type="button" className="win-rates-button" disabled={appIds.length === 1 && appIds[0] === defaultId}
          onClick={() => {
            lastPicked.current = defaultId
            onChange([defaultId])
          }}>SF6のみ</button>
      </div>}
    </div>
    <div className="comparison-grid-options" role="group" aria-label="ゲーム">
      {allIds.map(id => {
        const name = steamPlayerCountGameLabel(id)
        const selected = appIds.includes(id)
        return <ComparisonGridOption key={id} name={name} buttonLabel={single ? name + 'のみ表示' : undefined}
          selected={selected} locked={!single && selected && appIds.length === 1} showCheck={false}
          marker={<SteamPlayerCountGameKey appId={id} markerOnly />} onClick={() => pick(id)} />
      })}
    </div>
  </div>
}
