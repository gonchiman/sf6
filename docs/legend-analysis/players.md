# レジェンド帯分析2：プレイヤー一覧

`#legend-analysis-2` の初期構成は「順位・プレイヤー名・キャラ・MR」のテーブル。1行はアカウント×掲載キャラで、同じ名前や同順位も別行として保持する。初期順は順位昇順。各列を昇降順で並べ替えられる。キャラは既存の日本語台帳を利用する。

取得区間（JST）、Act、地域・プラットフォーム、出典、掲載件数を表示する。取得記録が1回分でも取得日の選択欄を表示し、記録が増えると切り替えられる。取得記録がない場合は選択欄を表示しない。未取得・検証待ち・取得失敗・読込失敗・検証済み0件は区別する。既存 `#legend-analysis` の集計とグラフは変更しない。

## データと保存

- 既存の集計JSONからプレイヤー一覧は復元できない。最初の実取得までは `public/data/legend-players/index.json` を未取得として扱う。
- `--players` を明示した取得に限り、通常のランキング巡回で見える名前も読み取り、全件検証後に `public/players/index.json` と `legend-*.json` を別出力する。
- 名前は2026-10-28に実画面で確認した、ランキング行内の `span[class*="ranking_name__"]` を読む。称号やコメントを名前に混ぜず、欠損は取得失敗とする。プロフィール成績や戦歴の追加巡回はしない。
- 一覧JSONは `players: [{ id, playerName, characterId, rank, masterRating }]` と出典・取得区間・Act・条件・検証情報を持つ。`id` は取得回内の連番であり、アカウント識別子ではない。名前で同一人物を判定しない。
- プロフィールID・URL・一時照合ハッシュ・認証情報は保存しない。表示名は文字列として扱い、HTMLとして実行しない。
- 公式Legend表示・末尾・先頭・重複・MR順・Actなどの既存検証、5秒の取得開始間隔、アクセス拒否やCAPTCHAでの停止条件を再利用する。完全取得の失敗を部分一覧や0件で代替しない。
- 通常の `data:collect-legend-analysis` は集計専用。日次workflowの一覧出力は明示的な設定で有効化し、最初は手動単発で確認する。

## Actionsでの単発確認と日次運用

既存の `Collect daily Legend analysis` を利用する。実行はmainのコード・GitHub hosted Windows・既存の保存認証に限定する。プレイヤー名は同じランキングDOMから読み、個別プロフィールへの追加巡回はしない。

1. mainへ反映後、手動実行の `include_players` を `true` にして単発取得する。初期値は `false`。この手動入力はその1回だけに適用される。
2. 取得・検証・Artifact・履歴保存とページ表示の成功を確認する。
3. 成功後にリポジトリ変数 `LEGEND_PLAYERS_DAILY_ENABLED` を文字列 `true` に設定すると、以後のscheduleで一覧も保存する。未設定または `true` 以外なら日次は集計専用のまま。

取得jobと履歴保存jobには、同一の厳密な真偽値を渡す。一覧を有効化したのにファイルがない、無効なのに一覧が含まれる、集計と一覧の取得回が一致しない場合はアップロードや保存を止める。

Artifactは検証した集計JSONと `public/players/index.json`・`public/players/legend-*.json` だけ。認証を受け取らない保存jobで両方を再検証し、既存の `codex/legend-analysis-history` ブランチへまとめて保存する。各データ種別は既存の厳密なvalidatorと不変履歴publisherを使い、両方を組み立ててから履歴ディレクトリを入れ替える。一覧を無効化した日の集計更新でも過去の一覧を保ち、取得失敗では失敗状況と以前の正常な一覧を保持する。

診断ログの `attemptFailures` に、全体の取り直し前の試行番号・段階・ページ番号・エラー分類・検証項目・再確認差分の分類を保存する。`humanVerification` はWAFヘッダーの確認有無・分類と可視DOMの人間認証検出結果を持ち、未観測と非検出を区別する。本文・認証値・個別プレイヤー値は診断ログに入れない。CAPTCHAやアクセス拒否の停止条件は維持する。

## 操作

```powershell
# このチェックアウトに既存の保存認証がある場合の単発取得
npm run data:collect-legend-players
# 表示された取得回の public/players を指定
npm run data:import-legend-players -- .local/legend-analysis-daily/captures/<取得回>/public/players
npm run validate:legend-players
npm run test:legend-analysis
npm run build
```

取り込み先は `public/data/legend-players/`。既存集計の取り込みと同じ、検証・不変の取得ID・作業フォルダーからの入れ替えを再利用する。一覧の取り込みに失敗しても以前の正常データを保つ。公開リポジトリへのプッシュやデプロイは別の操作。

ページの読込は共通の `usePublishedData` と `createPublishedDataFeed` を再利用し、起動時・表示中5分ごと・タブへ戻ったときに確認する。一覧の配信元は既存履歴ブランチの `public/players/`。そこに完全な検証済みデータがない間は同梱JSONを使う。ページを開く操作はBuckler取得を開始しない。

## 再利用

SF6の `LegendCharacterTable` のソートとアクセシビリティ、`table.css`、`StatisticsPanel`、取得記録・配信読込・不変履歴の検証を利用する。兄弟プロジェクトの一覧を参照したが、今回の4列表にはSF6の既存部品を優先する。
