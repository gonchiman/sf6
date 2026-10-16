# ランク分布の週次取得

更新日: 2026-10-16。設定を有効化済みで、手動起動した同じ週次処理で保存済み認証の再利用・全ランク取得・履歴保存に成功した。実際の定期起動と7日後の認証再利用はまだ未検証。

## 現在の設定と確認状況

[週次workflow](https://github.com/gonchiman/sf6/actions/workflows/rank-distribution-weekly.yml)を標準ブランチ`main`で有効化し、公開集計用の専用ブランチ`codex/rank-distribution-history`を作成した。取得・保存処理はレビュー済みコミット`accd559597f5cedc149e15b65fc02c16db18ad18`に固定している。

週次用Secret`BUCKLER_WEEKLY_SESSION`は継続保管の明示許可を受けて送信済み。認証状態の元の保存日時は2026年10月15日14:28:41 JST（`2026-10-15T05:28:41.313Z`）、送信日時は10月16日13:57:01 JST（`2026-10-16T04:57:01.544Z`）。単発検証用の`BUCKLER_CLOUD_PROBE_SESSION`は削除済みで、週次用とは保持期間と削除操作を分ける。

[初回の手動確認](https://github.com/gonchiman/sf6/actions/runs/38853314940)と[1回の再試行](https://github.com/gonchiman/sf6/actions/runs/38853621670)は、どちらも先頭ページの取得でHTTP 503になった。両実行とも保存jobは成功し、前回の正常データとcheckpointを保持して失敗記録を残した。

その後の[再確認](https://github.com/gonchiman/sf6/actions/runs/38861770850)は、取得job・保存jobとも成功した。10月15日14:28:41 JSTに保存した同じ認証を使い、手動ログインなしで先頭ページのログイン済み表示と完全な一覧を確認できた。`initialSignInConfirmed`は`true`で、保存から約25時間（90,242秒）のため`reuseAfterSevenDays`は`pending`。取得途中のブラウザー再起動でも同じ保存状態を使い、認証の再取得やSecret更新はしていない。

取得期間は10月16日15:32:43〜16:09:45 JST。439回の取得試行中438回成功、サーバーエラーからの再読1回、ブラウザー再起動1回で全35境界を新しく確認した。ログイン済み表示のないページを許容した読み取りは0回。新規36区分の件数合計と終了時総数は3,063,094件、観測最小総数3,063,020件、最大総数3,063,094件で、取得期間中の概数として保存した。

初回の定期実行予定は2026年10月22日（木）22:30 JST。元の保存から約176時間経過するため、取得元が応答し初回ログイン済み一覧を確認できた場合に7日後の再利用を判定できる。手動起動で同じ取得・保存処理が成功したことと、予定時刻の自動起動・7日後の認証再利用が成功したことは区別する。

## 実行と保存

`.github/workflows/rank-distribution-weekly.yml`をリポジトリの標準ブランチへ登録済みで、毎週木曜22:30 JST（UTC 13:30）にGitHub hosted WindowsとEdgeで取得する設定になっている。PCとローカルアプリの起動は不要。`workflow_dispatch`による動作確認も同じ処理を使う。GitHub側の混雑などで予定時刻から遅れる場合がある。

定期workflowは標準ブランチの固定ファイルに限り、取得・保存処理はレビューしたコミットSHAに固定する。PRや任意ブランチからの取得は許可しない。取得jobはリポジトリの読み取りだけ、保存jobだけがデータ専用ブランチへ書き込める。認証Secretは取得ステップだけへ渡す。

取得・保存コードを変更した場合は、必要なテストと型検査を通したコードを先に`main`へコミットし、その検証済みコミットSHAへ`rank-distribution-weekly.yml`の取得job・保存jobの2か所の`ref`を揃えて更新する。`main`のコード変更だけでは週次実行に反映されない。現在の固定SHA`accd559597f5cedc149e15b65fc02c16db18ad18`は今回変更しない。

取得条件と概数の意味は[取得仕様](README.md)と[取得処理](collection.md)を引き継ぐ。過去のcheckpointは探索候補にだけ使い、全35境界を今回の実行で新しく確認できた場合に36区分の集計を追加する。対象はランキング掲載ファイターアカウントで、実人数やアクティブ人口とは扱わない。

保存先は公開リポジトリ`gonchiman/sf6`の専用ブランチ`codex/rank-distribution-history`。保存するファイルは次に限定する。

- `data/index.json`と日付付き`data/max-lp-*.json`: 検証を通過した分布の履歴。新規取得は`max-lp-estimate-*.json`で、既存の厳密取得データも保持できる。
- `checkpoint.json`: 次回の探索候補となるランク境界の数値と観測日時。
- `runs/run-<run_id>-<attempt>.json`: 実行日時、取得結果、認証の再利用判定などの安全な記録。

失敗した場合は前回の正常な分布を保持する。検証できた部分checkpointと失敗の記録を保存できる場合は残すが、一部取得を完全集計として登録しない。保存先や出力を検証できない場合はartifactの出力も停止する。

同じ安全なファイルを診断用artifactとして90日保持する。履歴の継続保存には専用ブランチを使うので、artifactの期限切れで次回の探索候補が失われる構成にはしない。データ保存からアプリの公開や自動配信には接続しない。

## 認証状態の保持と7日後の確認

単発検証の`BUCKLER_CLOUD_PROBE_SESSION`とは別に、固定Secret`BUCKLER_WEEKLY_SESSION`を使う。保存済みのStreet Fighterサイト用認証状態と、その実際の保存日時・送信日時を一つのSecretとして暗号化送信する。DPAPIファイルや専用ブラウザーの全プロファイルは送らない。

週次用Secretは利用を止めるか認証を更新するまでGitHubに保持する。送信ツールは同名Secretを上書きせず、自動ログイン、認証状態の自動更新、ロボット認証の操作を行わない。

```powershell
node scripts/send-buckler-cloud-session.ts --upload-weekly
# 表示された保存先と継続保持の説明を確認し、UPLOAD WEEKLY と入力する。

node scripts/send-buckler-cloud-session.ts --cleanup-weekly
# このツールの週次用送信記録に対応するSecretだけを削除する。
```

再利用の確認は、クラウドの新しいブラウザーで初回のランキング先頭ページを開き、ログイン済み表示と完全な一覧を確認できたかで判定する。元の保存日時から168時間未満なら`pending`、168時間以上経過して初回確認に成功した場合だけ`confirmed`とする。失敗時は`unconfirmed`で、メンテナンス・通信・描画の問題を認証の期限切れと断定しない。

手動確認で成功しても、定期実行が動いた証拠にはしない。run記録の`event`で手動実行と定期実行を区別する。初回手動確認では新しいクラウド環境での再利用を確認し、翌週以降の定期実行で元の保存から168時間以上経過した認証の再利用を確認する。

認証が失効した場合はユーザーが手動ログインしてローカルの保存状態を更新し、週次Secretをcleanupして再送信する。その場合、7日間の経過判定は新しい保存日時からやり直す。

## 結果の確認とローカルへの取り込み

GitHub Actionsの`Collect weekly rank distribution`から実行結果を確認する。成功時も取得期間中の概数として扱う。定期実行の成功と、データ専用ブランチへの保存成功を両方確認する。

ローカルへは専用ブランチの`data/`をダウンロードし、既存の`data:import-rank-distribution`で取り込む。手動取り込みの詳細は[取得処理](collection.md)を参照。アプリとの自動同期は今回の対象に含めていない。

停止する場合はGitHub Actionsで週次workflowを無効にし、上の`--cleanup-weekly`で認証Secretを削除する。既に保存した集計履歴は残る。

## GitHubの定期実行の制約

定期実行は標準ブランチにあるworkflowが対象で、混雑時には遅延・欠落の可能性がある。公開リポジトリでは60日間活動がないと定期実行が無効化される。予定時刻と実際の実行日時を区別し、長期間記録が増えない場合はActionsの状態を確認する。[GitHub公式仕様](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)

artifactには保持期限があるため、長期の分布履歴は専用ブランチに保存する。[GitHub公式説明](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/download-workflow-artifacts)
