import { AppShell } from './components/AppShell'
import './App.css'

export default function App() {
  return (
    <AppShell activePage="win-rates" title="勝率分析">
      <section className="analysis-workspace" aria-label="分析データ">
        <p className="workspace-state">データ未接続</p>
      </section>
    </AppShell>
  )
}
