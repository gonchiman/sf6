# GitHub Actionsでの小規模取得テスト

ローカルの並列取得テストと同じrunner・ブラウザー読取処理を、GitHub hosted WindowsとEdgeで動かす。実行場所の違いを確認するための手動テストであり、週次取得の設定は変更しない。

## 実行条件

既存の登録済み `rank-distribution-cloud-probe.yml` を、専用ブランチ `codex/buckler-cloud-collection-parallel-20261021` から手動実行する。`main`へのworkflow登録やアプリ配信は不要。

| collection入力 | 対象 | 並列数 | 繰り返し | 通常の読取回数 |
| --- | --- | --- | --- | --- |
| `parallel-serial` | LPの1〜20ページ | 1 | 3回 | 63回（準備3＋測定60） |
| `parallel-compare` | LPの1〜20ページ | 1、2 | 各1回 | 43回（準備3＋測定40） |

全タブ共通で取得開始間隔を5秒に保つ。ロボット認証、ログイン要求、認証表示の確認不能、HTTP 401/403/429などは停止する。HTTP 5xxだけ1回再試行する。読取上限は準備・再試行込み200回、取得処理は10分で中断する。

## 認証と保存

既存の `BUCKLER_WEEKLY_SESSION` Secretを取得ステップだけに渡す。CLIで直ちに環境変数から削除し、既存の検証処理を通した保存状態をメモリ内で一度だけブラウザーへ渡す。新たな認証の送信、ファイルへの保存、自動ログイン、ロボット認証の操作は行わない。

結果は既存のレポート形式で `.local/parallel-fetch/parallel-fetch-cloud-<run_id>-<attempt>-<serial|compare>.json` に保存する。保存と形式検証に成功した単一JSONだけをActions artifactとして7日保持する。停止・失敗した場合も、その時点までの安全な数値と判定を保存する。秘密情報・プレイヤーの名前やID・HTMLは含めない。

## 再利用と検証

`runParallelFetch`、`createParallelFetchBrowserSession`、`parseBucklerWeeklySession`、`parseParallelFetchReport`、`createParallelFetchReportWriter` を再利用する。ローカルとクラウドで停止条件や計測方法を分岐させない。

合成データによる検証:

```sh
node --test src/lib/parallelFetch.test.ts scripts/lib/parallel-fetch-runner.test.ts scripts/lib/parallel-fetch-browser.test.ts scripts/lib/parallel-fetch-service.test.ts scripts/test-parallel-fetch-cloud.test.ts
```

実行結果はActionsの各実行とダウンロードしたJSONで確認する。小規模テストの成功だけで、全巡回や長時間取得の成功を保証しない。
