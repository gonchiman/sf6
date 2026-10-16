# Bucklerのクラウド取得検証

GitHubが用意するWindows環境でEdgeを起動し、Bucklerの総合・最大LPランキングを読む単発検証。先頭ページでの認証再利用と、全35境界からのランク分布の概数取得を確かめる。

2026年10月15日に、クラウドで全35境界・36ランク区分の概数取得とArtifacts保存が成功した。手元へダウンロードし、既存のローカルアプリへ取り込み、帯別・★別の実表示も確認した。週次実行とアプリの公開は設定していない。

## 検証の順序

1. 認証情報を送らず、クラウドのWindowsと表示付きEdgeで先頭ページの表示を確認する。
2. 送信先と保存方法を確認し、認証状態のクラウド送信に同意してから、認証付きの検証を行う。
3. 実行環境への認証状態の受け渡しを確認し、不要になった検証用のGitHub Secretを削除する。

既存の[認証と閲覧の検証](auth-probe.md)はこのPC内だけで認証情報を扱う。その動作は維持し、クラウドへの送信には専用コマンドを使う。

## 認証情報の扱い

送信先は`gonchiman/sf6`のGitHub Actions用Secret `BUCKLER_CLOUD_PROBE_SESSION`。リポジトリは公開だが、Secretの値は公開ファイルとして保存されない。認証状態を使えるのは、このSecretを読み取れるワークフローである。

ローカル送信コマンドは、明示的な同意の後にDPAPIの保存状態をこのPC内で復号し、Street Fighterサイトだけの状態か検証する。48KiB未満のJSONをGitHub CLIの標準入力へ渡し、GitHub CLIによる公開鍵暗号化でSecretを登録する。平文ファイル、コマンド引数、ログには認証状態を残さない。

クラウドでは検証ステップだけにSecretを渡し、プログラムが読み取った直後に環境変数から削除する。復元した状態をメモリ内で新しいEdgeコンテキストに渡し、ブラウザーの子プロセスにはSecretの環境変数を継承させない。

Cookie、Local Storage、CAPCOM IDの状態、プレイヤー名・ID、画面画像、通信記録を結果に含めない。CAPCOM IDへの自動ログインやロボット確認の操作は実施しない。失敗時に同じ要求を繰り返さない。

## 実行方法

検証用ブランチは`codex/buckler-cloud-probe-20261015`。登録済みの`.github/workflows/pages.yml`をそのブランチの内容で手動実行する。`buckler_probe`の既定値は`off`で、通常のテスト・ビルドは従来どおり動作する。検証ジョブは`codex/buckler-cloud-probe`で始まるブランチの明示的な手動実行に限定する。

認証なしの実行:

```powershell
gh workflow run pages.yml --repo gonchiman/sf6 --ref codex/buckler-cloud-probe-20261015 -f deploy_pages=false -f buckler_probe=anonymous -f buckler_headless=false
```

認証状態の送信は、このPCで次を実行して説明を確認し、`UPLOAD`に同意した場合だけ行う。既存の同名Secretは上書きしない。

```powershell
node scripts/send-buckler-cloud-session.ts --upload
```

送信後の認証付き実行:

```powershell
gh workflow run pages.yml --repo gonchiman/sf6 --ref codex/buckler-cloud-probe-20261015 -f deploy_pages=false -f buckler_probe=saved-session -f buckler_headless=false
```

使用後の削除:

```powershell
node scripts/send-buckler-cloud-session.ts --cleanup
```

クラウドの検証コマンドは`node scripts/probe-buckler-cloud.ts --anonymous`または`--saved-session`。既定は表示付きのEdgeで、必要な比較時だけ`--headless`を追加する。

## 結果の読み方

安全な判定結果だけをクラウドの`.local/buckler-cloud-probe/result.json`とActionsログに出力する。認証ファイル、ブラウザープロファイル、スクリーンショット等の成果物はアップロードしない。

`cloudAuthentication: confirmed`は、認証付き方式で、GitHubホスト環境の実行とログイン済み表示・条件・件数の一致を確認できた場合だけ記録する。プログラム内の環境変数の判定は、実際のActionsの実行記録と併せて確認する。

認証なしでランキングが読めても、認証再利用の成功とは扱わない。アクセス拒否や表示形式の不一致も、認証が失効したという結論と区別する。成功しても、1週間後の有効性、全ランク分布の集計、週次取得は別途検証する。

## 実行記録

2026年10月15日15:14〜15:15（日本時間）に、[認証なしのActions実行](https://github.com/gonchiman/sf6/actions/runs/38691231183)を確認した。対象コミットは`7bc0c7c5105aeae79ac296b7b4ed7bf43c2ecdd3`。検証用ジョブだけが実行され、ビルドと公開のジョブはスキップされた。

GitHubのWindows環境で表示付きEdgeの起動とページへの到達は確認できたが、文書のHTTPステータスは403で、条件選択・ランキング行・件数を確認できなかった。結果は`unsupported-dom`・`cloudExecution: true`・`cloudAuthentication: not-tested`。既知の拒否画面を見出しから特定できていないため、CloudFrontやCloudflareが原因とは断定しない。

この実行では認証情報を送信・使用していない。403という結果を、保存済み認証の失効や認証付きクラウド取得の失敗とは扱わない。

同日、ユーザーの明示的な許可を受けて、Street Fighterサイト用の保存状態を一時Secretへ送信した。16:02（日本時間）の[認証付きActions実行](https://github.com/gonchiman/sf6/actions/runs/38696037892)は、同じコミット`7bc0c7c5105aeae79ac296b7b4ed7bf43c2ecdd3`で正常終了した。検証用ジョブだけが実行され、ビルドと公開のジョブはスキップされた。

認証付きの実ページ読み取りは07:02:11.019〜07:02:20.177 UTC。GitHubのWindows環境と表示付きEdgeで、手動ログインなしにログイン済み表示・固定条件・先頭20行を確認した。HTTPステータスは200、表示総件数は3,060,643件、`signed-in-readable`・`cloudExecution: true`・`cloudAuthentication: confirmed`となった。先の匿名403とは実行時刻・環境が異なるため、応答の差だけから403の原因を認証の有無と断定しない。

実行後、送信用コマンドの`--cleanup`が正常終了し、GitHubのSecret一覧から固定対象が消えたことを確認した上でローカルの送信記録も削除した。元のDPAPI保存と専用プロファイルはこのPC内に保持している。認証付きの数値・状態だけの記録は`.local/buckler-cloud-probe/cloud-authenticated-2026-10-15T07-02-11-019Z.json`に保存する。

この16:02の検証で確認できたのは、保存済み認証を使い、取得処理をGitHub側で実行して先頭20件を読めることまで。全ランク分布の集計は後述の別実行で確認した。1週間後の認証保持、週次実行、クラウドからローカルアプリへの継続的な取り込みは未検証または未設定。

ローカルでは、既存の認証検証を含む全445件のテストと、新規クラウド検証・送信コマンドのstrict型検査が成功した。人工データによるテストの成功は、実サイトでの認証再利用成功とは分けて扱う。

## 全ランクの単発検証

ローカルでは全35境界の探索位置を保存できたが、同じ取得期間で全境界を再確認する前に描画待ちで停止した。全体取得には同じ取得本体を使い、`collect-rank-distribution-cloud.ts`からGitHubのWindows環境で単発実行する。既存の登録済み`pages.yml`の`buckler_probe: rank-distribution`から、`rank-distribution-cloud-probe.yml`を呼ぶ。対象は`codex/buckler-cloud-collection`で始まる検証ブランチの手動実行だけで、ビルド・配信・先頭ページだけの旧ジョブは実行しない。

検証ブランチは`codex/buckler-cloud-collection-20261015`。取得本体とラッパーは`1f555418e8a487e42e9a7972404b8a3a726b826e`まで反映している。先頭のログイン確認と、後続の正常なランキング表示の扱いは[ローカル取得と同じ条件](collection.md#実行)を使い、認証表示を確認できなかった正常ページの回数もレポートへ記録する。認証の確認待ちと描画未完了は区別し、既存の1回だけの再読へ接続している。

このPC内の認証状態は、送信するデータ・送信先・単発検証の目的についてユーザーの同意がある場合だけ送る。同じ範囲で既に得た許可は引き継ぎ、送信先や利用範囲を広げる場合は新たに確認する。送信先は前述の固定Secretで、実行後に削除する。元のDPAPI保存やブラウザープロファイル自体は送らない。新しい取得処理もSecretを直ちに環境変数から削除し、Edgeの子プロセスには引き継がない。

`buckler_rank_resume: true`と`buckler_rank_checkpoint`へ、認証や個別行を含まないcheckpoint JSONを渡せる。JSONは固定環境変数`BUCKLER_CLOUD_RANK_CHECKPOINT`を通して検証し、探索位置のヒントとしてだけ使う。クラウドでも全35境界の件数・時刻を新しく確認する。取得期間・総数の変動はクラウド実行で新しく記録する。

結果は固定の`rank-distribution-cloud-output/`に準備し、完成した概数JSON・その一覧・数値と固定判定だけのレポート・検証済みcheckpointをActions Artifactsへ7日間保存する。認証、プロファイル、通信記録、画面画像、`.local/`全体はアップロードしない。Artifactsの保存には[公式のupload-artifact v7.0.2](https://github.com/actions/upload-artifact/releases/tag/v7.0.2)の確認済みコミットを固定する。

レポートの`publicationTarget: artifact-staging`と`published`は成果物用の準備を指し、ローカルアプリへの取り込みや公開を意味しない。`appImported`・`deployed`はfalse、`artifactUploaded`もスクリプト内では未確認のfalseとし、実際のアップロードはActionsの実行結果で確認する。失敗時は途中保存とレポートを残し、部分取得を完成データへ昇格しない。

checkpointの書き込みが途中で失敗した場合は`artifactReady: false`として、Artifacts全体のアップロードを抑止する。不完全なJSONを再開用ファイルとして送らず、安全な診断はActionsログから確認する。

同日21:54:38 JST（12:54:38 UTC）、ユーザーから許可された送信先・認証状態・単発検証の範囲で一時Secretを登録し、[全ランク分布のActions実行](https://github.com/gonchiman/sf6/actions/runs/38738293951)を開始した。対象は上記コミットで、保存済み35境界の位置をヒントに全境界を新しく確認した。ビルド・配信・旧先頭ページ検証の3ジョブはスキップされ、取得ジョブは21分12秒で正常終了した。

取得ステップの開始を確認した後、`send-buckler-cloud-session.ts --cleanup`が正常終了し、固定Secretの削除とローカル送信記録の削除を確認した。開始済みの取得処理はメモリへ渡した状態で続行し、元のDPAPI保存はこのPC内に保持する。

実際の取得期間は21:55:47.523〜22:15:49.224 JST（12:55:47.523〜13:15:49.224 UTC）。230回中229回のページ読み取りが成功し、HTTP 5xxを示す`server-error`1回は既存の限定再読で復帰した。全35境界を今回のクラウド実行で確認し、36区分の件数合計と終了時総数は3,061,539件で一致した。開始・最小総数は3,061,476件、最大・終了時総数は3,061,539件。取得期間中の概数であり、この63件の総数差を誤差上限とは扱わない。

`readableWithoutSignInReadCount`は0で、ログイン表示を確認できなかったページを受理する補助条件は今回使わなかった。`sessionRefreshCount`も0。手動ログイン・CAPCOM ID操作は実施していない。別環境での同日内の認証再利用と全体取得を実証したもので、認証の固定有効期間は確定しない。

`rank-distribution-cloud-38738293951-1`（5,221バイト）のアップロード成功をActionsで確認し、`.local/rank-distribution/cloud-38738293951/`へ取得した。保存された集計とcheckpointは既存パーサーで再検証した。完成データ`max-lp-estimate-2026-10-15T12-55-47-523Z`を既存importerで`public/data/rank-distribution/`へ取り込み、全35境界の新しい探索位置もローカルの固定checkpointへ反映した。アプリでは8ランク帯・DIAMONDの★別5行・全体分母の割合・累積割合・取得期間・総数範囲を確認した。関連110件のテスト、実データを含む`validate:data`、型検査とViteのビルドも成功している。

1週間後の認証再利用と週次運用は未実証・未設定。
