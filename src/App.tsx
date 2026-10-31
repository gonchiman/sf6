import { useCallback, useEffect, useState } from 'react'
import { AppShell } from './components/AppShell'
import { CharactersPage } from './components/CharactersPage'
import { CharacterReleasesPage } from './components/CharacterReleasesPage'
import { CharacterTraitsPage } from './components/CharacterTraitsPage'
import { WinRatesPage } from './components/WinRatesPage'
import { UsageRatesPage } from './components/UsageRatesPage'
import { WinRateHistoryPage } from './components/WinRateHistoryPage'
import { MonthlyWinRateStatisticsPage } from './components/MonthlyWinRateStatisticsPage'
import { MonthlyUsageRateStatisticsPage } from './components/MonthlyUsageRateStatisticsPage'
import { WinUsageCorrelationPage } from './components/WinUsageCorrelationPage'
import { ExpectedMatchesPage } from './components/ExpectedMatchesPage'
import { ControlTypeRatioPage } from './components/ControlTypeRatioPage'
import { BalanceAdjustmentPages } from './components/BalanceAdjustmentPages'
import { BalanceAdjustmentAnalysisPage } from './components/BalanceAdjustmentAnalysisPage'
import { RankDistributionPage } from './components/RankDistributionPage'
import { LegendAnalysisPage } from './components/LegendAnalysisPage'
import { LegendPlayersPage } from './components/LegendPlayersPage'
import { SteamPlayerCountPage } from './components/SteamPlayerCountPage'
import { NewAccountObservationPage } from './components/NewAccountObservationPage'
import { ParallelFetchTestPage } from './components/ParallelFetchTestPage'
import { SampleSurveyPage } from './components/SampleSurveyPage'
import { characterHash, parseHashRoute } from './lib/routes'
import './App.css'

export default function App() {
  const [route, setRoute] = useState(() => parseHashRoute(window.location.hash))
  const updateRoute = useCallback(() => setRoute(parseHashRoute(window.location.hash)), [])

  useEffect(() => {
    const onHashChange = () => setRoute(parseHashRoute(window.location.hash))
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  return (
    <AppShell activePage={route.page === 'balance-adjustment-detail' ? 'balance-adjustments' : route.page} title={route.page === 'steam-player-count' ? 'Steam同時接続数' : route.page === 'adjustment-analysis' ? 'バトル変更分析' : route.page === 'sample-survey' ? '標本調査' : route.page === 'parallel-fetch-test' ? '並列取得テスト' : route.page === 'legend-analysis-2' ? 'レジェンド帯分析2' : route.page === 'legend-analysis' ? 'レジェンド帯分析' : route.page === 'win-usage-correlation' ? '勝率と使用率' : route.page === 'balance-adjustment-detail' ? 'バトル変更詳細' : route.page === 'usage-rates' ? '使用率' : route.page === 'expected-matches' ? 'マスターまでの期待試合数' : route.page === 'character-releases' ? 'キャラ実装日' : route.page === 'characters' ? 'キャラ情報' : route.page === 'character-traits' ? 'キャラ分類' : route.page === 'win-rate-history' ? '勝率推移' : route.page === 'monthly-win-rate-statistics' ? '月別勝率統計' : route.page === 'monthly-usage-rate-statistics' ? '月別使用率統計' : route.page === 'control-type-ratio' ? '操作タイプ比率（推定）' : route.page === 'rank-distribution' ? 'ランク分布' : route.page === 'new-account-observation' ? '新規参入観測' : route.page === 'balance-adjustments' ? 'バトル変更一覧' : '勝率'}>
      {route.page === 'character-releases' ? <CharacterReleasesPage /> : route.page === 'characters'
        ? <CharactersPage characterId={route.characterId} onCharacterChange={(id) => { window.location.hash = characterHash(id) }} />
        : route.page === 'character-traits' ? <CharacterTraitsPage />
          : route.page === 'win-rate-history' ? <WinRateHistoryPage />
            : route.page === 'monthly-win-rate-statistics' ? <MonthlyWinRateStatisticsPage />
              : route.page === 'monthly-usage-rate-statistics' ? <MonthlyUsageRateStatisticsPage />
              : route.page === 'win-usage-correlation' ? <WinUsageCorrelationPage />
              : route.page === 'expected-matches' ? <ExpectedMatchesPage />
                : route.page === 'control-type-ratio' ? <ControlTypeRatioPage />
                  : route.page === 'usage-rates' ? <UsageRatesPage />
                    : route.page === 'rank-distribution' ? <RankDistributionPage />
                      : route.page === 'legend-analysis' ? <LegendAnalysisPage />
                      : route.page === 'legend-analysis-2' ? <LegendPlayersPage />
                      : route.page === 'steam-player-count' ? <SteamPlayerCountPage />
                      : route.page === 'new-account-observation' ? <NewAccountObservationPage />
                      : route.page === 'parallel-fetch-test' ? <ParallelFetchTestPage />
                      : route.page === 'sample-survey' ? <SampleSurveyPage />
                      : route.page === 'adjustment-analysis' ? <BalanceAdjustmentAnalysisPage />
                        : route.page === 'balance-adjustments' || route.page === 'balance-adjustment-detail' ? <BalanceAdjustmentPages route={route} onRouteChange={updateRoute} /> : <WinRatesPage />}
    </AppShell>
  )
}
