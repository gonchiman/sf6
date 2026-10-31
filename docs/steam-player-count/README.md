# Steam同時接続数

Steam版Street Fighter 6（App ID `1364780`）の同時接続数を定期観測し、実測推移と日本時間の時間帯別平均を表示する。対象はSteamに接続している利用者。家庭用機、Steamのオフライン利用者、地域別人口、対戦中の人数はこの値から算出しない。

## 出典と時刻

- [Steam公式GetNumberOfCurrentPlayers](https://partner.steamgames.com/doc/webapi/ISteamUserStats#GetNumberOfCurrentPlayers)を使用する。
- 取得先は `https://api.steampowered.com/ISteamUserStats/GetNumberOfCurrentPlayers/v1/?appid=1364780`。公開ホストを使用し、APIキーやBucklerの保存認証は使わない。ドキュメント中の`partner.steam-api.com`はpublisher keyが必要な別ホスト。
- [Steam Web API概要](https://partner.steamgames.com/doc/webapi_overview)にあるとおり、公開ホストにはedge cacheがある。`observedAt`は応答の読み取りが完了した時刻で、Steam内部での集計・生成時刻ではない。
- 全保存時刻はUTCのISO 8601、ミリ秒3桁と`Z`を必須にする。画面・日付選択・曜日・時間帯比較は`Asia/Tokyo`。UTC日付のファイル名をJST日付として扱わない。
- 現在値APIなので、収集開始前や取得を逃した過去の人数は復元しない。遅延した実行を予定時刻へ戻したり、欠測を0人で埋めたりしない。

## 取得と配信

`.github/workflows/steam-player-count.yml`をmainで動かす。cronは`7,22,37,52 * * * *`、1日96回の予定。毎時00分を避けるが、[GitHub Actionsのschedule](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)には遅延・取りこぼしがあり、15分間隔を保証しない。public repositoryで60日間repository activityがないとscheduleが停止する仕様もある。

1. `collect`はNode 24の標準`fetch`で1観測を取得する。依存パッケージのインストールやブラウザー起動は不要。
2. HTTPと本文読み取りの制限時間は1試行15秒。通信失敗・429・5xxのみ最大3試行。`Retry-After`は秒数・HTTP日付に対応し、5秒を超える待機を要求されたらその回は失敗として終える。サーバー指定より早く再試行しない。
3. APIの成功状態と非負の安全な整数を検証する。確認済み0人は正常値。不正JSON・API失敗・取得失敗から0人を作らない。
4. `contents: read`の取得jobが`observation.json`だけをartifactへ保存する。保持は30日。失敗時は公開履歴を書き換えず、Actionsのjobを失敗状態にする。
5. `contents: write`の公開jobが専用ブランチ`codex/steam-player-count-history`だけへ履歴を保存する。mainやGitHub Pagesのビルド・デプロイはデータ取得ごとには実行しない。
6. 取得jobは並列可能。公開jobだけを専用concurrencyで直列化し、[`queue: max`](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)を使う。上限100件であり、無制限の保管キューではない。

履歴ブランチがまだ存在しない最初の公開では、そのmainコミットの`public/data/steam-player-count`をハッシュ・形式検証して初期履歴へコピーし、それから新しい観測を追加する。これにより同梱した初回実測が自動取得へ切り替わる際も残る。既存の履歴ブランチは同梱データで上書きしない。配信用JSONは`.gitattributes`でLFを固定し、checkout時の改行変換によるハッシュ不一致を防ぐ。

pushが拒否された場合は最大3回まで最新履歴を再取得し、同じartifactを再マージする。生成JSONをforce pushしたり、競合した観測を捨てたりしない。公開失敗時は保持されたartifactから公開jobを再実行する。artifact名は取得jobのoutputを引き継ぐため、公開jobだけの再実行で変わる`GITHUB_RUN_ATTEMPT`に影響されない。保持期間を過ぎたartifactやGitHub側で開始されなかった取得は自動復元できない。

## 配信用形式

履歴ブランチの`public/index.json`と`public/days/YYYY-MM-DD.json`を配信する。1観測1ファイルにはしない。`schemaVersion: 1`、`appId: 1364780`を固定する。

観測は次のフィールドを持つ。

```ts
{
  id: string,
  requestStartedAt: string,
  observedAt: string,
  playerCount: number,
  runId: string | null,
  runAttempt: number | null
}
```

GitHubでのIDは`steam-<runId>-<runAttempt>`。ローカル単発取得は実測時刻とUUIDを含む別IDで、実行情報は両方`null`とする。`requestStartedAt <= observedAt`を検証する。再試行が成功した場合は、その成功したHTTP要求の開始・終了時刻を使う。

日別ファイルは`{ schemaVersion, appId, date, observations }`。`date`は`observedAt`のUTC日付で、観測を`observedAt`、`id`の順に並べる。

manifestは`{ schemaVersion, appId, sourceUrl, generatedAt, days }`。各日について`date`、`path`、`sha256`、`observationCount`、`firstObservedAt`、`lastObservedAt`を持つ。`sha256`は配信するUTF-8ファイルの実バイト列から計算する。`generatedAt`は公開用データの生成時刻で、観測日時と区別する。

公開処理は既存のmanifest・全日別ファイル・ハッシュ・観測IDを検証してから、変更対象の1日とindexだけを更新する。同じ観測IDまたは同じGitHub実行回の内容変更は、日付をまたいでも拒否する。同一artifactの再公開は既存ファイルを変更しない。

日別ファイルを先に原子的に置換し、indexを最後に置換する。途中の読込で両者の版がずれても、画面のハッシュ検証で採用しない。indexの置換に失敗したら以前の日別ファイルを復元し、新規の日なら削除する。復元自体に失敗した場合は`.steam-publication-*`内のバックアップと`.public-steam.lock`を残す。プロセス停止でこれらが残った場合も、所有プロセス・indexのハッシュ・バックアップを確認してから復旧し、ロックを無条件に消さない。

## 時間帯比較

- 15分区間は予定cron時刻ではなく`observedAt`で決める。同一区間に複数観測があれば、最も早い実測を1件採用する。元の観測履歴は削除しない。
- 各JST日×時間について4つの15分区間がそろった場合だけ、その4観測の平均を算出する。
- 同じ時間帯の日別平均を、各日を等しく重み付けして平均する。取得回数が多い日を重くしない。
- 有効日数と取得区間数/予定区間数を併記する。4区間未満の時間の平均は欠測扱いで、補間しない。
- 初期期間は原則として昨日までの直近14日。収集初日など完了した日がまだない場合は、ある観測を表示する。時間帯比較に有効な観測がまだなければ、その状態を示す。
- これは離散時点の観測平均で、期間内の厳密な時間積分平均ではない。祝日判定はせず、平日/月〜金と土日を区別する。

## 手元での確認

単発取得は明示した新しい出力ディレクトリへ保存する。既存の`observation.json`は上書きしない。

```sh
node scripts/collect-steam-player-count.ts --collect --output .local/steam-player-count/manual-001
node scripts/publish-steam-player-count.ts --input .local/steam-player-count/manual-001/observation.json --output .local/steam-player-count/preview/public
node --test scripts/collect-steam-player-count.test.ts scripts/publish-steam-player-count.test.ts scripts/publish-steam-player-count-history.test.ts
```

単発取得・ローカル取り込みは定期取得の有効化や履歴ブランチへのpushを行わない。ネットワークへの書き込みは固定mainのworkflowから呼ぶ`publish-steam-player-count-history.ts`に限定する。synthetic testでは実Steam APIへ接続しない。

既存のLegend取得workflowから、取得と公開の権限分離・artifact受け渡し・専用履歴ブランチの構成を再利用した。Steamの高頻度観測、日別ファイル、SHA-256照合、実時刻の時間帯集計は専用処理として実装する。`arknights_2`の取得コードはtimeout・限定retry・検証後保存の参照元とし、実行時の外部ローカルパス依存は追加しない。
