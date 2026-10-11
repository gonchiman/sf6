import { useId, useRef, useState, type KeyboardEvent } from 'react'
import { createExpectedMatchConfig, DEFAULT_EXPECTED_MATCH_SETTINGS } from '../lib/expectedMatchModel'
import { EXPECTED_MATCH_RANK_THRESHOLDS } from '../lib/expectedMatches'
import { EXPECTED_MATCH_RULE_REFERENCE } from '../lib/expectedMatchRuleReference'
import { leagueLabel } from '../lib/winRateConditions'
import type { ExpectedMatchSettings } from '../types/expectedMatchData'

type Props = {
  settings: ExpectedMatchSettings | null
  calculatedSettings: ExpectedMatchSettings | null
  stale: boolean
}
type Tab = 'rules' | 'model'

const format = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 0 })
const plus = (value: number) => `+${format.format(value)}`
const dateLabel = (value: string) => value.replaceAll('-', '/')
// Probabilities do not affect LP transitions; use the existing config builder for the reference.
const referenceRanks = EXPECTED_MATCH_RANK_THRESHOLDS.map(rank => ({ ...rank, winProbability: 0 }))

function ModelRules({ settings, label }: { settings: ExpectedMatchSettings; label: string }) {
  const config = createExpectedMatchConfig(settings, referenceRanks)
  const platinumSplit = config.ranks.some(rank => rank.id === 'PLATINUM_STAR_3_5')
  return <>
    <div className="data-table-scroll" role="region" tabIndex={0} aria-label={`${label}のLPルール・スクロール領域`}>
      <table className="data-table expected-matches-lp-model-table">
        <caption className="win-rates-visually-hidden">{label}のランク別LPルール</caption>
        <thead><tr><th scope="col">ランク</th><th scope="col">基本勝利LP</th><th scope="col">敗北LP</th><th scope="col">連勝の追加LP</th><th scope="col">敗北時の下限LP</th></tr></thead>
        <tbody>{config.ranks.map((rank, index) => {
          const bonuses = rank.winStreakBonuses
          const lowRank = index < 5
          return <tr key={rank.id}>
            <th scope="row">{rank.id === 'PLATINUM_STAR_3_5' ? 'PLATINUM ★3〜5'
              : rank.id === 'PLATINUM' && platinumSplit ? 'PLATINUM ★1〜2' : leagueLabel(rank.id)}</th>
            <td>{plus(config.winLp)}</td>
            <td>{(rank.lossLp ?? config.lossLp) === 0 ? '0' : `−${format.format(rank.lossLp ?? config.lossLp)}`}</td>
            {(!lowRank || index === 0) && <td rowSpan={lowRank ? 5 : undefined} className="expected-matches-lp-bonus-cell">
              {!bonuses ? 'なし（+0）' : lowRank ? <>
                3連勝 {plus(bonuses[3])}<br />1勝ごとに {plus(settings.lowRankBonusStep)}<br />10連勝以上 {plus(bonuses[10])}
              </> : bonuses[10] === 0 ? '+0（除外）' : <>10連勝以上 {plus(bonuses[10])}</>}
            </td>}
            <td>{format.format(rank.lossFloorLp ?? 0)}</td>
          </tr>
        })}</tbody>
      </table>
    </div>
    <dl className="expected-matches-lp-model-summary">
      <div><dt>開始条件</dt><dd>{format.format(settings.startLp)} LP・{config.startWinStreak}連勝</dd></div>
      <div><dt>ランクの判定</dt><dd>試合直前のLPで勝利確率・ボーナスを選ぶ</dd></div>
      <div><dt>連勝の引継ぎ</dt><dd>{settings.useWinStreakBonus ? '昇格・降格時も継続、敗北で0。10連勝以上は10として扱う' : '連勝ボーナスを計算しない'}</dd></div>
      {platinumSplit && <div><dt>PLATINUM ★3</dt><dd>15,400 LPから追加LPを切替。★1〜2と同じ勝利確率を使用</dd></div>}
      <div><dt>降格保護</dt><dd>1回の保護は計算に含めない</dd></div>
      <div><dt>その他の除外</dt><dd>相手とのLP差・別キャラでのMASTER達成ボーナス・認定戦</dd></div>
    </dl>
    <details className="win-rates-details expected-matches-lp-example">
      <summary>連勝数と獲得LPの例（{label}・ROOKIE〜GOLD）</summary>
      <StreakExample settings={settings} />
    </details>
    {settings.useWinStreakBonus && [settings.platinumStreakBonus, settings.platinumUpperStreakBonus, settings.diamondStreakBonus].includes(0) &&
      <p>高ランクの追加LP「0（除外）」は計算に含めない設定です。ゲームのボーナスが0という意味ではありません。</p>}
  </>
}

function StreakExample({ settings }: { settings: ExpectedMatchSettings }) {
  const rank = createExpectedMatchConfig(settings, referenceRanks).ranks[0]
  return <div className="data-table-scroll" role="region" tabIndex={0} aria-label="連勝数と獲得LPの例・スクロール領域">
    <table className="data-table expected-matches-lp-example-table">
      <caption className="win-rates-visually-hidden">勝利後の連勝数ごとの基本LP、追加LP、合計獲得LP</caption>
      <thead><tr><th scope="col">勝利後の連勝数</th><th scope="col">基本LP</th><th scope="col">追加LP</th><th scope="col">合計獲得LP</th></tr></thead>
      <tbody>{[1, 3, 4, 5, 6, 7, 8, 9, 10].map(streak => {
        const bonus = rank.winStreakBonuses?.[streak] ?? 0
        return <tr key={streak}><th scope="row">{streak === 1 ? '1〜2' : streak === 10 ? '10以上' : streak}</th>
          <td>{plus(settings.winLp)}</td><td>{plus(bonus)}</td><td>{plus(settings.winLp + bonus)}</td></tr>
      })}</tbody>
    </table>
  </div>
}

function GameRules() {
  const reference = EXPECTED_MATCH_RULE_REFERENCE
  return <>
    <div className="data-table-scroll" role="region" tabIndex={0} aria-label="LP増減の仕様と確認状況・スクロール領域">
      <table className="data-table expected-matches-lp-rules-table">
        <caption className="win-rates-visually-hidden">LP増減に関する参照情報と出典</caption>
        <thead><tr><th scope="col">項目</th><th scope="col">参照情報</th><th scope="col">確認状況・出典</th></tr></thead>
        <tbody>{reference.rows.map(row => <tr key={row.item}><th scope="row">{row.item}</th><td>{row.description}</td><td>
          {row.status}<br /><a href={reference.sources[row.source].url} target="_blank" rel="noreferrer">
            {row.source === 'official' ? '公式資料' : '参考資料'}<span className="win-rates-visually-hidden">（新しいタブ）</span>
          </a>
        </td></tr>)}</tbody>
      </table>
    </div>
    <details className="win-rates-details expected-matches-lp-example">
      <summary>連勝数と獲得LPの例（参考情報・ROOKIE〜GOLD）</summary>
      <StreakExample settings={{ ...DEFAULT_EXPECTED_MATCH_SETTINGS, ...reference.example, useWinStreakBonus: true }} />
    </details>
    <dl className="expected-matches-lp-sources">
      {Object.entries(reference.sources).map(([key, source]) => <div key={key}>
        <dt>{key === 'official' ? '公式資料' : '参考資料'}</dt><dd><a href={source.url} target="_blank" rel="noreferrer">{source.title}<span className="win-rates-visually-hidden">（新しいタブ）</span></a>
          {' · '}<time dateTime={source.publishedAt}>{dateLabel(source.publishedAt)}</time>{key === 'official' ? '公開' : '更新'}</dd>
      </div>)}
      <div><dt>資料確認日</dt><dd><time dateTime={reference.checkedAt}>{dateLabel(reference.checkedAt)}</time></dd></div>
    </dl>
    <p>公式資料の記載は公開時点の情報です。高ランクの追加LPは参考資料に基づく暫定値として計算の初期設定に採用しています。参考情報を現行仕様の確定値として扱いません。勝率の対象月と資料確認日は別です。</p>
  </>
}

export function ExpectedMatchLpReference({ settings, calculatedSettings, stale }: Props) {
  const id = useId()
  const [tab, setTab] = useState<Tab>('rules')
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([])

  function changeTab(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? 1
      : event.key === 'ArrowLeft' || event.key === 'ArrowRight' ? 1 - index : null
    if (next === null) return
    event.preventDefault()
    setTab(next === 0 ? 'rules' : 'model')
    tabRefs.current[next]?.focus()
  }

  return <details className="win-rates-details expected-matches-lp-reference">
    <summary>LP増減の仕様</summary>
    <div className="win-rates-details-content">
      <div className="expected-matches-lp-tabs" role="tablist" aria-label="LP増減の参照内容">
        {(['rules', 'model'] as const).map((value, index) => <button key={value} type="button" className="win-rates-button" role="tab"
          id={`${id}-tab-${value}`} aria-selected={tab === value} aria-controls={`${id}-panel-${value}`} tabIndex={tab === value ? 0 : -1}
          ref={element => { tabRefs.current[index] = element }} onClick={() => setTab(value)} onKeyDown={event => changeTab(event, index)}>
          {value === 'rules' ? 'ゲームの仕様' : 'この計算の設定'}
        </button>)}
      </div>
      <div id={`${id}-panel-rules`} role="tabpanel" aria-labelledby={`${id}-tab-rules`} tabIndex={0} hidden={tab !== 'rules'}>
        <GameRules />
      </div>
      <div id={`${id}-panel-model`} role="tabpanel" aria-labelledby={`${id}-tab-model`} tabIndex={0} hidden={tab !== 'model'}>
        <div className="expected-matches-lp-setting-status"><span>入力中の設定</span>{stale && <span role="status">未反映</span>}</div>
        {settings ? <ModelRules settings={settings} label="入力中の設定" /> : <p role="status">入力未確定・LP設定の入力値を確認してください。</p>}
        {calculatedSettings && stale && <details className="win-rates-details expected-matches-lp-calculated">
          <summary>計算結果に使った設定</summary>
          <div className="win-rates-details-content"><ModelRules settings={calculatedSettings} label="計算済みの設定" /></div>
        </details>}
      </div>
    </div>
  </details>
}
