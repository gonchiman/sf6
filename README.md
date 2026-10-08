# SF6 バランス分析

Bucklerで公開されたStreet Fighter 6の対戦勝率を確認するアプリ。
月・リーグ・操作タイプを選び、キャラごとの公式Totalを百分率へ換算した一覧で表示する。
初期表示はキャラ別・Total降順。見出しから昇順・公式キャラ順に切り替えられる。
「マッチアップ」に切り替えると、キャラクター同士の対戦勝率を公式表記で表示する。
月・リーグ・操作タイプは表示切替で保持する。行列の見出しを固定した表を縦横にスクロールでき、
セルを選ぶと組み合わせと数値を確認できる。
狭い画面では上部バーからメニューを開閉できる。

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

`test` は条件・欠損・少数試合・データ形式・読込キャッシュと再試行、Totalの換算・並び替え・元データ不変を検証する。
`validate:data` は登録済みJSONの条件と行列の完全性を確認する。
`build` はデータ検証、型チェック、本番ビルドを行い、出力を `dist/` に生成する。

## 構成

| 場所 | 役割 |
| --- | --- |
| `src/App.tsx` | アプリの入口。共通レイアウト内に勝率ページを表示 |
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
| `src/lib/winRates.ts` | JSONの検証、条件別読込、失敗時の再試行 |
| `src/types/winRates.ts` | 一覧・条件・行列・公式表示値の型 |
| `public/data/win-rates/` | 条件一覧と、条件ごとの配信用JSON |
| `scripts/validate-win-rate-data.ts` | 公開用JSONの整合性検証 |
| `.github/workflows/pages.yml` | 型チェック・ビルドとGitHub Pagesへの配信 |

## 勝率データ

出典は [Buckler 総合版 対戦ダイアグラム](https://www.streetfighter.com/6/buckler/ja-jp/stats/dia)。
公式の公開表を通常のブラウザーで閲覧し、月・リーグ・操作タイプ・キャラ順を確認して表示値を記録した。
公式APIによる取得ではなく、ゲーム単位などの集計定義や試合数は取得できていない。

現在保存している条件は以下の18件。選択肢は `index.json` に登録された条件から生成する。

- 2026年8月：ROOKIE〜MASTERの8リーグ、合算・操作タイプ別（31キャラ、操作タイプ別は62行列）。
- 2026年7月：MASTERの合算・操作タイプ別（30キャラ、操作タイプ別は60行列）。

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

更新時は条件ごとのJSONを保存し、同じ条件と取得日時の情報を `index.json` に登録してから
`npm run validate:data` と `npm test` を実行し、公式表と照合する。取得・自動更新の処理は未設定。
ブラウザーは保存済みJSONだけを読み込み、必要な条件を読み込んだ後は条件別にキャッシュする。

[公式のサイト利用条件](https://www.capcom-games.com/ja-jp/site/)は、法令で許される範囲を除く無断複製・転載等を制限している。
数値データの自動取得や第三者アプリでの再配布を明示的に認める条件は確認できていない。
保存済みのデータはビルドに含まれ、GitHub Pagesへのデプロイ時に配信される。

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
前作の固有ページ・データセット・分析処理には依存していない。

作業時は [AGENTS.md](AGENTS.md) と該当する参照先を読む。
