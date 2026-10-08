import { useEffect, useState } from 'react'
import { AppShell } from './components/AppShell'
import { CharactersPage } from './components/CharactersPage'
import { CharacterTraitsPage } from './components/CharacterTraitsPage'
import { WinRatesPage } from './components/WinRatesPage'
import { WinRateHistoryPage } from './components/WinRateHistoryPage'
import { MonthlyWinRateStatisticsPage } from './components/MonthlyWinRateStatisticsPage'
import { characterHash, parseHashRoute } from './lib/routes'
import './App.css'

export default function App() {
  const [route, setRoute] = useState(() => parseHashRoute(window.location.hash))

  useEffect(() => {
    const onHashChange = () => setRoute(parseHashRoute(window.location.hash))
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  return (
    <AppShell activePage={route.page} title={route.page === 'characters' ? 'キャラ情報' : route.page === 'character-traits' ? 'キャラ分類' : route.page === 'win-rate-history' ? '勝率推移' : route.page === 'monthly-win-rate-statistics' ? '月別勝率統計' : '勝率'}>
      {route.page === 'characters'
        ? <CharactersPage characterId={route.characterId} onCharacterChange={(id) => { window.location.hash = characterHash(id) }} />
        : route.page === 'character-traits' ? <CharacterTraitsPage />
          : route.page === 'win-rate-history' ? <WinRateHistoryPage />
            : route.page === 'monthly-win-rate-statistics' ? <MonthlyWinRateStatisticsPage /> : <WinRatesPage />}
    </AppShell>
  )
}
