# ランク分布の週次取得

更新日: 2026-10-16。実装準備中。設定の有効化・クラウドでの手動確認・初回の定期実行は別々に記録する。

## 実行と保存

`.github/workflows/rank-distribution-weekly.yml`をリポジトリの標準ブランチへ登録し、毎週木曜22:30 JST（UTC 13:30）にGitHub hosted WindowsとEdgeで取得する。PCとローカルアプリの起動は不要。`workflow_dispatch`による動作確認も同じ処理を使う。GitHub側の混雑などで予定時刻から遅れる場合がある。

定期workflowは標準ブランチの固定ファイルに限り、取得・保存処理はレビューしたコミットSHAに固定する。PRや任意ブランチからの取得は許可しない。取得jobはリポジトリの読み取りだけ、保存jobだけがデータ専用ブランチへ書き込める。認証Secretは取得ステップだけへ渡す。

取得条件と概数の意味は[取得仕様](README.md)と[取得処理](collection.md)を引き継ぐ。過去のcheckpointは探索候補にだけ使い、全35境界を今回の実行で新しく確認できた場合に36区分の集計を追加する。対象はランキング掲載ファイターアカウントで、実人数やアクティブ人口とは扱わない。

保存先は公開リポジトリ`gonchiman/sf6`の専用ブランチ`codex/rank-distribution-history`。保存するファイルは次に限定する。

- `data/index.json`と日付付き`data/max-lp-estimate-*.json`: 検証を通過した分布の履歴。
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

手動確認で成功しても、定期実行が動いた証拠にはしない。run記録の`event`で手動実行と定期実行を区別する。初回に同日再利用を確認し、翌週以降の定期実行で7日後の確認を行う。

認証が失効した場合はユーザーが手動ログインしてローカルの保存状態を更新し、週次Secretをcleanupして再送信する。その場合、7日間の経過判定は新しい保存日時からやり直す。

## 結果の確認とローカルへの取り込み

GitHub Actionsの`Collect weekly rank distribution`から実行結果を確認する。成功時も取得期間中の概数として扱う。定期実行の成功と、データ専用ブランチへの保存成功を両方確認する。

ローカルへは専用ブランチの`data/`をダウンロードし、既存の`data:import-rank-distribution`で取り込む。手動取り込みの詳細は[取得処理](collection.md)を参照。アプリとの自動同期は今回の対象に含めていない。

停止する場合はGitHub Actionsで週次workflowを無効にし、上の`--cleanup-weekly`で認証Secretを削除する。既に保存した集計履歴は残る。

## GitHubの定期実行の制約

定期実行は標準ブランチにあるworkflowが対象で、混雑時には遅延・欠落の可能性がある。公開リポジトリでは60日間活動がないと定期実行が無効化される。予定時刻と実際の実行日時を区別し、長期間記録が増えない場合はActionsの状態を確認する。[GitHub公式仕様](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)

artifactには保持期限があるため、長期の分布履歴は専用ブランチに保存する。[GitHub公式説明](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/download-workflow-artifacts)
