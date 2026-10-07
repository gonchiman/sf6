import { AppShell } from './components/AppShell'
import { WinRatesPage } from './components/WinRatesPage'
import './App.css'

export default function App() {
  return (
    <AppShell activePage="win-rates" title="勝率">
      <WinRatesPage />
    </AppShell>
  )
}
