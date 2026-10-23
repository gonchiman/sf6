# GitHub Actionsでの小規模取得テスト

ローカルの並列取得テストと同じrunner・ブラウザー読取処理を、GitHub hosted WindowsとEdgeで動かす。実行場所の違いを確認するための手動テストであり、週次取得の設定は変更しない。

## 実行条件

現在は `parallel-fetch-test.yml` を `main` から手動実行する。アプリの「GitHub Actions」で開始すると、実行番号の照合と結果の取り込みまで行う。取得コードの変更をクラウドで試すには、先にmainへ取り込み、pushする必要がある。
現行workflowの `mode` は `serial`、`compare`、`interval-compare`。初期検証用 `rank-distribution-cloud-probe.yml` の `collection` 入力 `parallel-serial` と `parallel-compare` は、それぞれ `serial` と `compare` に対応する。

| mode入力 | 対象 | 並列数 | 繰り返し | 通常の読取回数 |
| --- | --- | --- | --- | --- |
| `serial` | LPの1〜20ページ | 1 | 3回 | 63回（準備3＋測定60） |
| `compare` | LPの1〜20ページ | 1、2 | 各1回 | 43回（準備3＋測定40） |
| `interval-compare`（初期値） | LPの1〜20ページ | 1、2 | 間隔5秒・3秒で各1回 | 86回（準備6＋測定80） |

`interval-compare` は `intervals`（例 `5000,3000`、単位ms）、`concurrencies`（`1` または `1,2`）、`repetitions`（`1` または `3`）を受け取る。間隔は10000・5000・3000msから重複なく選び、長い順に正規化する。既存の2モードは5秒固定で、追加入力を設定変更には使用しない。
全条件を1ジョブで順次実行し、取得開始間隔を全タブで共有する。ロボット認証、ログイン要求、認証表示の確認不能、HTTP 401/403/429などは全条件を停止する。HTTP 5xxだけ1回再試行する。読取上限は準備・再試行込み200回、取得処理は10分で中断する。間隔による待ち時間だけで10分以上になる比較設定は認証情報を読み込む前に拒否する。

## 認証と保存

既存の `BUCKLER_WEEKLY_SESSION` Secretを取得ステップだけに渡す。CLIで直ちに環境変数から削除し、既存の検証処理を通した保存状態をメモリ内で一度だけブラウザーへ渡す。新たな認証の送信、ファイルへの保存、自動ログイン、ロボット認証の操作は行わない。

結果は `.local/parallel-fetch/parallel-fetch-cloud-<run_id>-<attempt>-<mode>.json` に保存する。間隔比較はschema v2、それ以外は従来のschema v1を使用する。保存と形式検証に成功した単一JSONだけをActions artifactとして7日保持する。停止・失敗した場合も、その時点までの安全な数値と判定を保存する。秘密情報・プレイヤーの名前やID・HTMLは含めない。
アプリはdispatch前に選択条件を保存し、再起動後もその条件とrun ID・attempt・modeを使って結果を照合する。異なる条件の結果は取り込まない。

停止前後の表示変化と分類済みの通信失敗も同じJSONに含む。認証確認不能で停止した場合は、取得を再開せず最大30秒の追加観察を行う。詳しい記録項目・上限は [停止前後の診断記録](README.md#停止前後の診断記録) を参照。ローカルとActionsで同じ記録処理を使う。

## 再利用と検証

`runParallelFetch`、`createParallelFetchBrowserSession`、`parseBucklerWeeklySession`、`parseParallelFetchReport`、`createParallelFetchReportWriter` を再利用する。ローカルとクラウドで停止条件や計測方法を分岐させない。

合成データによる検証:

```sh
node --test src/lib/parallelFetch.test.ts scripts/lib/parallel-fetch-runner.test.ts scripts/lib/parallel-fetch-browser.test.ts scripts/lib/parallel-fetch-service.test.ts scripts/test-parallel-fetch-cloud.test.ts
```

実行結果はActionsの各実行とダウンロードしたJSONで確認する。小規模テストの成功だけで、全巡回や長時間取得の成功を保証しない。

## 2026年10月21日の直列テスト

[Actions実行 39543719551](https://github.com/gonchiman/sf6/actions/runs/39543719551) はコミット `90179f2` の `parallel-serial` を実行した。クラウド上でも合成テスト50件に合格したあと、保存済み認証で実際の取得を開始した。

取得期間は13:23:30〜13:28:10 JST（約4分39秒）。準備を含む50回の試行中48回成功し、すべての成功読取でログアウト表示を確認した。測定対象は45ページ、準備は3ページ。

| 周回 | 成功した測定ページ | 結果 |
| --- | --- | --- |
| 1 | 20/20 | 完了 |
| 2 | 20/20 | 9ページ目でHTTP 502。1回の再取得で回復し完了 |
| 3 | 5/20 | 6ページ目でHTTP 200だが `authentication-unconfirmed` により停止 |

停止時は `authenticationEvidence=login-control`、`loginRequiredHeading=false`、`rankingReadable=false`。ログイン済み表示と完全なランキング一覧を確認できなかった。認証期限切れやサーバー側の判定理由までは確定できない。この実行で `human-verification` の検出はなかった。

結果JSONは `parallel-fetch-cloud-39543719551-1-serial` artifactに保存した。PCにダウンロードしたコピーは `.local/parallel-fetch/cloud-39543719551/parallel-fetch-cloud-39543719551-1-serial.json` にある。

同じ設定のローカル直列テストは41回中40回成功したあと、2周目19ページ目でHTTP 405・`human-verification` になった。今回のクラウド実行はそれより先まで読めたが、予定した3周は完了していない。実行時刻や認証状態などは完全には揃えておらず、実行場所だけによる差とは断定しない。直列テストが未完了のため、この時点では `parallel-compare` を実行していない。
