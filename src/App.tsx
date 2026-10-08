import { useEffect, useState } from 'react'
import { AppShell } from './components/AppShell'
import { CharactersPage } from './components/CharactersPage'
import { WinRatesPage } from './components/WinRatesPage'
import { WinRateHistoryPage } from './components/WinRateHistoryPage'
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
    <AppShell activePage={route.page} title={route.page === 'characters' ? 'キャラ情報' : route.page === 'win-rate-history' ? '勝率推移' : '勝率'}>
      {route.page === 'characters'
        ? <CharactersPage characterId={route.characterId} onCharacterChange={(id) => { window.location.hash = characterHash(id) }} />
        : route.page === 'win-rate-history' ? <WinRateHistoryPage /> : <WinRatesPage />}
    </AppShell>
  )
}
