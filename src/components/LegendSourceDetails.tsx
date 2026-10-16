import { timestampLabel } from '../lib/dateTime'
import type { LegendAnalysisDataset, LegendAnalysisManifest } from '../types/legendAnalysis'

type Props = {
  manifest: LegendAnalysisManifest
  dataset: LegendAnalysisDataset | null
  previous: LegendAnalysisDataset | null
}
const CHECK_LABELS: Record<string, string> = {
  'conditions-confirmed': '取得条件を確認', 'act-confirmed': 'Actを確認',
  'membership-confirmed': 'レジェンドの掲載判定を確認', 'pagination-confirmed': '対象ページの取得を確認',
  'boundary-confirmed': '対象の境界を確認', 'ordering-confirmed': '掲載順を確認',
  'account-character-unit-confirmed': 'アカウントとキャラの組を確認', 'duplicates-checked': '重複を確認',
  'roster-confirmed': '公式のキャラ一覧を確認',
  'capture-rechecked': '取得後に再確認',
}

export function LegendSourceDetails({ manifest, dataset, previous }: Props) {
  const notes = dataset ? [...new Set([...dataset.source.notes, ...dataset.validation.notes])] : []
  return <details className="win-rates-details">
    <summary>集計方法・取得範囲・出典</summary>
    <div className="win-rates-details-content legend-analysis-evidence">
      <p>集計単位はアカウントとキャラの組です。同じアカウントが複数キャラで掲載される場合は、それぞれを1件として数えます。実人数への統合は行いません。</p>
      <p>キャラ構成比は、そのキャラの掲載数を同じ取得回の掲載総数で割った割合です。対戦回数に基づく使用率や勝率は、このデータからは算出できません。各回で確認できたキャラ一覧を使い、未確認キャラを0件として追加しません。</p>
      <p>MR分布は50 MR刻みで、各階級は下限以上・上限未満です。割合の分母は各取得回の掲載総数です。四分位数と中央値は、元のMRを昇順にした位置（件数−1）×割合を線形補間して求めます。掲載数0件の割合・要約値は「—」です。</p>
      <p>前回比較は、同じAct・集計定義・掲載判定・取得条件で、今回の取得開始より前に取得が終了した直前の記録を対象にします。取得中は一覧が変わり得るため、単一瞬間の名簿とは扱いません。</p>
      <p>差分は各回の掲載集団の比較です。出入りやキャラ変更も含むため、同じエントリーのMR増減や移動人数を示しません。構成比差の単位ppはパーセントポイントです。前回未取得・読込失敗と、検証済みの0件は区別します。</p>
      <dl className="win-rates-source">
        <div><dt>出典</dt><dd><a href={(dataset?.source ?? manifest.source).url} target="_blank" rel="noreferrer">{(dataset?.source ?? manifest.source).title}<span className="win-rates-visually-hidden">（新しいタブ）</span></a></dd></div>
        <div><dt>一覧生成日時</dt><dd><time dateTime={manifest.generatedAt}>{timestampLabel(manifest.generatedAt)}</time></dd></div>
        <div><dt>データ形式</dt><dd>Version {manifest.schemaVersion}</dd></div>
        {manifest.availability && <div><dt>取得状況の確認日時</dt><dd><time dateTime={manifest.availability.checkedAt}>{timestampLabel(manifest.availability.checkedAt)}</time></dd></div>}
        {dataset && <>
          <div><dt>取得回ID</dt><dd>{dataset.id}</dd></div>
          <div><dt>Act</dt><dd>{dataset.act.label}（{dataset.act.id}）</dd></div>
          <div><dt>取得開始</dt><dd><time dateTime={dataset.captureStartedAt}>{timestampLabel(dataset.captureStartedAt)}</time></dd></div>
          <div><dt>取得終了</dt><dd><time dateTime={dataset.captureEndedAt}>{timestampLabel(dataset.captureEndedAt)}</time></dd></div>
          <div><dt>データ生成日時</dt><dd><time dateTime={dataset.generatedAt}>{timestampLabel(dataset.generatedAt)}</time></dd></div>
          <div><dt>対象</dt><dd>{dataset.source.population}</dd></div>
          <div><dt>指標</dt><dd>{dataset.source.metric}</dd></div>
          <div><dt>集計単位</dt><dd>アカウント × キャラ</dd></div>
          <div><dt>地域</dt><dd>{dataset.conditions.region === 'all' ? '全地域' : dataset.conditions.region}</dd></div>
          <div><dt>プラットフォーム</dt><dd>{dataset.conditions.platform === 'all' ? '全プラットフォーム' : dataset.conditions.platform}</dd></div>
          <div><dt>元一覧のユーザー区分</dt><dd>{dataset.conditions.users === 'source-default' ? '取得元の標準条件' : dataset.conditions.users}</dd></div>
          <div><dt>掲載判定</dt><dd>{dataset.membershipRule === 'official-legend-badge' ? '公式のレジェンド表示' : '公式ランキングの取得条件'}</dd></div>
          <div><dt>集計定義</dt><dd>Version {dataset.definitionVersion}</dd></div>
          <div><dt>検証範囲</dt><dd>対象の掲載エントリー全件</dd></div>
          {previous && <div><dt>比較した前回</dt><dd>{previous.id} · <time dateTime={previous.captureEndedAt}>{timestampLabel(previous.captureEndedAt)}</time></dd></div>}
        </>}
      </dl>
      {dataset && dataset.validation.checks.length > 0 && <div><p>検証内容</p><ul>{dataset.validation.checks.map(check => <li key={check}>{CHECK_LABELS[check] ?? check}</li>)}</ul></div>}
      {notes.length > 0 && <ul>{notes.map(note => <li key={note}>{note}</li>)}</ul>}
    </div>
  </details>
}
