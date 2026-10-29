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

`interval-compare` は `interval_seconds`（例 `5,3`、単位秒）、`interval_scope`（`global` / `per-tab`、初期値 `global`）、`concurrencies`（1〜8の整数を1つ以上、カンマ区切り、初期値 `1,2`）、`repetitions`（`1` または `3`）を受け取る。間隔は0〜60秒を0.1秒単位で最大3種類指定し、重複を拒否して長い順に正規化する。0秒は間隔待ちなし。並列数は前後の空白を許容して小さい順に正規化し、空入力・重複・範囲外を拒否する。例えば `--interval-seconds=5 --concurrencies=1,3,5,8 --repetitions=1 --interval-scope=per-tab` は準備を含め97回の読取を予定する。`--interval-seconds=10 --concurrencies=4 --repetitions=3 --interval-scope=per-tab` は並列4だけを3回確認し、準備を含め72回、間隔による最短待ち時間150秒となる。並列1を含めない場合、直列比は算出しない。既存の2モードは全タブ共通の5秒固定で、追加入力を設定変更には使用しない。CLIは旧 `--intervals=5000,3000`（ms）も受け付け、適用範囲を省略した場合は `global` とする。
全条件を1ジョブで順次実行する。`global` は全タブ共通、`per-tab` は各タブの取得開始から次の取得開始までの間隔を制御する。準備・測定・再試行とも共通の制御処理を使う。ロボット認証、ログイン要求、認証表示の確認不能、HTTP 401/403/429などは全条件を停止する。HTTP 5xxだけ全体を5秒間待機して1回再試行する。読取上限は準備・再試行込み200回、取得処理は10分で中断する。選択した適用範囲の間隔による待ち時間だけで10分以上になる比較設定は認証情報を読み込む前に拒否する。

workflowの数値リストと適用範囲は環境変数で渡し、shellのコードへ直接展開しない。Secretを渡す取得ステップより前に、CLIとローカル画面が使う共通の検証処理で数値、適用範囲と全条件合計の上限を確認する。個々の値が範囲内でも、取得回数や待ち時間が上限を超える組み合わせは実行できない。

## 認証と保存

既存の `BUCKLER_WEEKLY_SESSION` Secretを取得ステップだけに渡す。CLIで直ちに環境変数から削除し、既存の検証処理を通した保存状態をメモリ内で一度だけブラウザーへ渡す。新たな認証の送信、ファイルへの保存、自動ログイン、ロボット認証の操作は行わない。

結果は `.local/parallel-fetch/parallel-fetch-cloud-<run_id>-<attempt>-<mode>.json` に保存し、全モードで適用範囲を含むschema v3を使用する。保存と形式検証に成功した単一JSONだけをActions artifactとして7日保持する。停止・失敗した場合も、その時点までの安全な数値と判定を保存する。秘密情報・プレイヤーの名前やID・HTMLは含めない。
アプリはdispatch前に適用範囲を含む選択条件を保存し、再起動後もその条件とrun ID・attempt・modeを使って結果を照合する。異なる条件の結果は取り込まない。旧schema v1・v2および適用範囲のない旧履歴は全タブ共通として照合し、保存形式の違いだけで拒否しない。

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
