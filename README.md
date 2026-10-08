# SF6 バランス分析

Bucklerで公開されたStreet Fighter 6の対戦勝率を確認するアプリ。
月・リーグ・操作タイプを選び、キャラごとの公式Totalを百分率へ換算した一覧で表示する。
初期表示はキャラ別・Total降順。見出しから昇順・公式キャラ順に切り替えられる。
「マッチアップ」に切り替えると、キャラクター同士の対戦勝率を公式表記で表示する。
月・リーグ・操作タイプは表示切替で保持する。行列の見出しを固定した表を縦横にスクロールでき、
セルを選ぶと組み合わせと数値を確認できる。
狭い画面では上部バーからメニューを開閉できる。

「キャラ情報」ではキャラ名・英語名・体力と公式の技データを表示する。
クラシック／モダンを選び、技名や入力の検索、カテゴリの絞り込み、発生・硬直差・ダメージの並び替えができる。
「詳細列」で持続・硬直・キャンセルを追加し、技名から入力・補正・ゲージ・属性・備考を確認できる。
`#characters/ryu` のようなURLで直接開ける。

「勝率推移」ではキャラ・リーグ・操作タイプ・開始月・終了月を選び、月別の公式Totalを折れ線と数値表で確認できる。
初期表示はRYU・MASTER・合算・保存済みの直近12か月。表の月、グラフ、月選択のスライダーが連動する。
広い画面ではグラフと月別表を横に、狭い画面では縦に並べる。`#win-rate-history` で直接開ける。

## 開発

Node.js 24とnpmを使用する。

```sh
npm ci
npm run dev
```

開発用URLはViteの起動時に表示される。公開先に合わせて `/sf6/` をベースパスにしている。

```sh
npm run typecheck
npm test
npm run validate:data
npm run build
npm run preview
```

`test` は条件・欠損・少数試合・データ形式・読込キャッシュと再試行、Totalの換算・並び替え・元データ不変に加え、取り込みの条件一致と更新失敗時の復元を検証する。
`validate:data` は登録済み勝率JSONの条件・行列と、キャラJSONの一覧・技データの整合性を確認する。
`build` はデータ検証、型チェック、本番ビルドを行い、出力を `dist/` に生成する。
キャラデータの生表記、操作タイプ、入力変換、欠損・条件付き数値の並び替え、読込の再試行、ルートも検証する。
推移では条件の一致、月抜け、キャラ未掲載、欠損と0%、IDによるTotal結合、並列読込と失敗月の再試行を検証する。

## 構成

| 場所 | 役割 |
| --- | --- |
| `src/App.tsx` | hash URLに応じて共通レイアウト内のページを切り替える |
| `src/components/AppShell.tsx` | サイドバー、上部バー、ページ領域を組み合わせる共通レイアウト |
| `src/components/AppSidebar.tsx` | ナビゲーションとモバイルメニュー |
| `src/lib/navigation.ts` | 実在するページのナビゲーション定義 |
| `src/navigation.css` | 共通レイアウトと画面幅に応じた表示 |
| `src/components/WinRatesPage.tsx` | 表示切替、条件選択、読込・失敗状態、出典の表示 |
| `src/components/TotalWinRateTable.tsx` | キャラ別Totalの百分率表示と並び替え |
| `src/components/WinRateTable.tsx` | 対戦勝率の行列表とセル選択 |
| `src/table.css` | 外枠・縦横罫線など共通テーブルの基準 |
| `src/total-win-rates.css` | Total一覧の列幅と見出し操作 |
| `src/lib/totalWinRates.ts` | 保存済みTotalの整数換算、欠損を区別した安定ソート |
| `src/components/WinRateHistoryPage.tsx`、`src/win-rate-history.css` | 推移の条件選択、読込状態、グラフと月別表の配置・選択連動 |
| `src/components/WinRateHistoryChart.tsx`、`src/components/MonthlyWinRateTable.tsx` | 月別の折れ線、欠損区間、50%基準、月の選択と数値表 |
| `src/lib/winRateHistory.ts`、`src/types/winRateHistory.ts` | 同条件の月別読込、暦月を維持したTotal抽出、状態と型 |
| `src/components/DataLoadState.tsx` | 勝率・推移・キャラ情報で共用する読込中・失敗・再試行の表示 |
| `src/lib/winRates.ts` | JSONの検証、条件別読込、失敗時の再試行 |
| `src/types/winRates.ts` | 一覧・条件・行列・公式表示値の型 |
| `public/data/win-rates/` | 条件一覧と、条件ごとの配信用JSON |
| `scripts/validate-win-rate-data.ts` | 公開用JSONの整合性検証 |
| `scripts/export-buckler-snapshots.js` | 通常閲覧した公式表から月別の入力JSONを書き出す手動用スクリプト |
| `scripts/update-win-rate-data.ts` | 単月・期間・保存済み全月の取り込みコマンド |
| `scripts/lib/` | 公式表の正規化、対象範囲の検証、公開用データの反映・復元 |
| `src/components/CharactersPage.tsx`、`src/characters.css` | キャラ概要、技検索・分類・並べ替え、技詳細 |
| `src/lib/characters.ts`、`src/types/characters.ts` | キャラJSONの検証・読込、検索、安定ソート、型 |
| `src/lib/routes.ts` | キャラの直接URLとページ切替 |
| `public/data/characters/` | キャラ一覧とキャラ別の配信用JSON |
| `scripts/export-character-snapshot.js` | 選択中の公式フレーム表をDOMから記録する読取スクリプト |
| `scripts/import-character-data.ts`、`scripts/lib/character-snapshot.ts` | 保存記録の検証、入力アイコンの文字変換、配信用JSON生成 |
| `scripts/validate-character-data.ts` | 一覧との対応・技ID・出典・取得日時などの検証 |
| `.github/workflows/pages.yml` | 型チェック・ビルドとGitHub Pagesへの配信 |

## 勝率データ

出典は [Buckler 総合版 対戦ダイアグラム](https://www.streetfighter.com/6/buckler/ja-jp/stats/dia)。
公式の公開表を通常のブラウザーで閲覧し、月・リーグ・操作タイプ・キャラ順を確認して表示値を記録した。
公式APIによる取得ではなく、ゲーム単位などの集計定義や試合数は取得できていない。

現在保存している条件は2023年6月〜2026年8月の39か月・624件。
各月にROOKIE〜MASTERの8リーグ、合算・操作タイプ別を保存している。
選択肢は `index.json` に登録された条件から生成し、キャラ構成は月ごとの公式表に従う。
2023年6月は18キャラ、2026年8月は31キャラで、操作タイプ別ではそれぞれ36・62行列になる。
2026年9月も公式の選択肢にはあるが、今回の環境では数値を確認できなかったため保存していない。

`text` は公式の小数3桁、`-`、`-.---` を文字列で保持する。保存値は百分率へ書き換えず、欠損を0にしない。
`lowSample` は公式表の少数試合の印を保持し、キャラIDと操作タイプを別の項目で識別する。
キャラ別では `rows[].total.text` を表示時だけ百分率に換算する（`5.058` → `50.58%`）。
小数3桁の文字列を整数化し、百分率の0.01単位として扱うことで浮動小数の再丸めを避ける。
`0.000` は `0.00%`、`10.000` は `100.00%`。欠損2種類は元の記号のまま表示する。
合算では1キャラ1行、操作タイプ別ではキャラと操作タイプの組ごとに1行表示する。
同値は公式キャラ順、欠損は昇順・降順とも末尾。Total一覧用の行だけを並べ替え、行列の列順は変更しない。
マッチアップの数値と少数試合の印は公式表記を維持し、Totalには独自の少数試合の印を追加しない。

尺度は [公式ページが読み込む2026年8月の公開JSON](https://www.streetfighter.com/6/buckler/api/ja-jp/stats/dia/202608)
の744行で `total` が `_win_rate × 10` の小数3桁表示と一致することを確認した。
保存済みTotalからの換算は元の `_win_rate` の精度を復元する処理ではない。
元の勝数・試合数、Totalの集計方法、ミラー戦・引き分け・切断等の扱いは未確認で、画面の開閉できる補足に記載する。
各JSONの `source.notes` は取得当時の保存値の注記として保持し、画面では表示方法の説明と分けて掲載する。
各JSONに出典・対象月・取得日時・生成日時・形式のバージョンを保存している。

ブラウザーは保存済みJSONだけを読み込み、必要な条件を読み込んだ後は条件別にキャッシュする。

推移は各月の `characterId` と操作タイプから `fighterId` を探し、その行のTotalを表示する。
月ごとに同じリーグ・操作モードを厳密に選び、別の条件への代替や月次勝率の平均は行わない。
クラシックとモダンは同じ操作タイプ別JSONを使う。キャラだけの変更では月別ファイルを読み直さない。
各月の読込は最大4件ずつ行い、成功分は既存のキャッシュで再利用する。
途中の未登録月も暦月として残し、未掲載・公式欠損・未登録・読込失敗では線を切る。0%は数値として描画する。
読込失敗がある場合は失敗月数を表示し、再読み込みできる。選択変更前の読込結果は現在の条件として表示しない。
縦軸は50%と表示値を含む自動範囲。取得日時・保存データの注記は選択中の月の情報を表示する。
別ページへ移動して戻った場合は、既存ページと同じく初期条件から表示する。

## 過去データの取り込みと手動更新

この環境では公式JSONへの通常のHTTPアクセスが403で拒否されたため、公式ページを通常閲覧し、
表示された表を書き出して取り込む方法を採用している。APIの自動取得と定期更新は設定していない。
直接取得できたことにしたり、未取得の条件を欠損値で埋めたりはしない。

新しく取得するときは、次の手順を使う。

1. [公式の対戦ダイアグラム](https://www.streetfighter.com/6/buckler/ja-jp/stats/dia)をブラウザーで開く。
2. `scripts/export-buckler-snapshots.js` 冒頭の `targetMonths` を対象月に変更し、全体をブラウザーのDevToolsのConsoleで実行する。単月は `['2026-08']`、期間は `['2023-06..2026-08']`。`['ALL']` は公式の全選択肢を対象にするため、未掲載の月があると完了しない。実行中はページの条件を手で変更せず、Escで中止できる。
3. 全対象月の取得に成功するとページ右上に保存リンクが出る。月別の `YYYY-MM.json` を同じフォルダーへ保存し、次のコマンドで取り込む。

```sh
npm run data:update -- --month 2026-08 --input-dir "C:/path/to/snapshots"
npm run data:update -- --from 2023-06 --to 2026-08 --input-dir "C:/path/to/snapshots"
npm run data:update -- --all --input-dir "C:/path/to/snapshots"
```

`--all` は入力フォルダーに存在する月だけを対象にする。期間を漏れなく取り込む場合は `--from` と `--to` を指定する。
`--input-dir` を省くと `.cache/win-rates/snapshots/` に置いた入力JSONを使う。
保存済み入力の再取り込みは取得日時を更新しない。生成日時だけを更新する。
入力JSONはGitに含めず、検証済みの公開用JSONを `public/data/win-rates/` に保存する。

各月16条件の重複・不足、月や操作タイプの不一致、キャラ構成、行列、値の形式を検証する。
選んだ全月が成功するまで公開用データは変更せず、対象外の月は保持する。
作業用データと更新履歴は `.cache/win-rates/publication/` に置き、失敗時は元のデータへ戻す。
更新途中でプロセスが終了した場合は、次回の取り込みで記録から復元する。
別の更新処理や復旧処理が残っている場合は停止し、同時更新を続行しない。

取り込み後は `npm run build` を実行する。配信は既存のGitHub Pagesの手順を使う。

[公式のサイト利用条件](https://www.capcom-games.com/ja-jp/site/)は、法令で許される範囲を除く無断複製・転載等を制限している。
数値データの自動取得や第三者アプリでの再配布を明示的に認める条件は確認できていない。
保存済みのデータはビルドに含まれ、GitHub Pagesへのデプロイ時に配信される。

## キャラ・技データ

出典は [公式フレームデータ](https://www.streetfighter.com/6/ja-jp/character/ryu/frame)。
2026年10月8日に通常のブラウザーで公開表と操作タイプを確認し、31キャラのクラシック・モダンを保存した。
公式一覧にはアルジュンもあるが、フレーム表はキャラ紹介へ移動し未公開だったため収録していない。
ゲームのパッチ番号は確認できず `gameVersion: null` としている。勝率の対象月と技データの取得日は別の情報。

発生・持続・硬直・硬直差・キャンセル・ダメージ・補正・ゲージ・属性・備考の文字列を保持する。
空欄は空文字のまま保存し、画面で「—」と表示する。ゼロ・ダウンを示す `D`・条件式とは区別する。
持続の `4-6` は公式の発生フレーム範囲であり、持続時間の `3F` に書き換えない。
数字だけで比較できる値を安定ソートし、条件付き値や空欄は昇降順とも末尾に置く。
クラシックとモダンの技を区別し、別の操作タイプの性能や未掲載の入力を推定しない。
入力画像は目視確認して文字へ変換した。未登録画像が増えた場合はファイル名のマーカーを残す。
キャラ画像・公式サイトの画像・SVGは配信に含めない。

更新時は公式表の各操作タイプを選んで `scripts/export-character-snapshot.js` をDevToolsで実行し、
JSONを `.local/character-snapshots/<id>.json` と `<id>.modern.json` に保存する。
`roster.json` に取得できた公式キャラ順の `{ "id": "ryu", "url": "https://www.streetfighter.com/6/ja-jp/character/ryu/frame" }` の配列を保存する。
取得記録はGitの管理対象から除外している。英語名のSVGに説明文がない4キャラは、公式英語ページの標題を確認した名前を使う。

```sh
npm run data:import-characters
npm run validate:data
npm test
npm run build
```

importは全記録を検証してからキャラJSONと一覧を生成する。取得日時は操作タイプ別の記録のうち最後の時刻。
アプリは保存済みJSONだけを読み込む。自動取得・自動更新は設定していない。

## GitHub Pages

Viteの `base` は `/sf6/`。配信を開始するときはリポジトリのSettings → PagesでSourceをGitHub Actionsに設定する。
Actionsはpull requestでビルドを確認し、mainへのpushまたはmain上での手動実行で `dist/` を配信する。

設定方法は [Viteの配信ガイド](https://vite.dev/guide/static-deploy.html#github-pages) を参照。
ローカルで初期構成を保存しただけでは公開されない。

## 前作からの継承

`arknights_2` の起動構成、TypeScriptの設定分割、基礎CSS、Pages配信の構成を参照している。
サイドバーの見た目、1140px以下でのメニュー表示、Esc・背景クリック・閉じるボタンによる開閉、
フォーカス復帰、背景の操作・スクロール抑止も前作から採用している。
モバイルメニュー内のTab移動はこのプロジェクトで追加した。
主要な依存バージョンは前作のlockfileに揃え、`package-lock.json` で固定する。
勝率表では、前作の表のスクロール領域、固定見出し、薄い縦横罫線、読込・再試行の振る舞いを採用している。
キャラ別・マッチアップの二択表示と見出しボタンによる並び替えも前作の操作方式を採用している。
JSONの条件別Promiseキャッシュと失敗後の再試行は、前作のマップ詳細読込を参考にしている。
推移の幅への追従・選択位置のガイド・月別表との連動は、前作のSurtrDurationChartとSurtrDurationTimelineTableを参考にした。
月軸・Totalの尺度・欠損区間はSF6用に実装し、前作のHP計算やスキルのイベントは取り込んでいない。
前作の固有ページ・データセット・分析処理には依存していない。

作業時は [AGENTS.md](AGENTS.md) と該当する参照先を読む。
