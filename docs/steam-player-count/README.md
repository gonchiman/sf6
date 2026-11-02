# Steam同時接続数

Steam版の格闘ゲーム5作品の同時接続数を定期観測し、ゲームを選んで実測推移と日本時間の時間帯別平均を表示する。対象はSteamに接続している利用者。家庭用機、Steamのオフライン利用者、地域別人口、対戦中の人数はこの値から算出しない。

| ゲーム | App ID | 保存キー |
| --- | --- | --- |
| Street Fighter 6 | 1364780 | `sf6` |
| [鉄拳8](https://store.steampowered.com/app/1778820/TEKKEN_8/) | 1778820 | `tekken-8` |
| [GUILTY GEAR -STRIVE-](https://store.steampowered.com/app/1384160/GUILTY_GEAR_STRIVE/) | 1384160 | `ggst` |
| [Granblue Fantasy Versus: Rising](https://store.steampowered.com/app/2157560/Granblue_Fantasy_Versus_Rising/) | 2157560 | `gbvsr` |
| [THE KING OF FIGHTERS XV](https://store.steampowered.com/app/1498570/THE_KING_OF_FIGHTERS_XV/) | 1498570 | `kof-xv` |

対象、API URL、保存先の定義は`src/lib/steamPlayerCountGames.ts`を共用する。SF6の既存履歴は維持し、追加作品は収集開始後の観測だけを蓄積する。

## 出典と時刻

- [Steam公式GetNumberOfCurrentPlayers](https://partner.steamgames.com/doc/webapi/ISteamUserStats#GetNumberOfCurrentPlayers)を使用する。
- 取得先は `https://api.steampowered.com/ISteamUserStats/GetNumberOfCurrentPlayers/v1/?appid=<App ID>`。公開ホストを使用し、APIキーやBucklerの保存認証は使わない。ドキュメント中の`partner.steam-api.com`はpublisher keyが必要な別ホスト。
- [Steam Web API概要](https://partner.steamgames.com/doc/webapi_overview)にあるとおり、公開ホストにはedge cacheがある。`observedAt`は応答の読み取りが完了した時刻で、Steam内部での集計・生成時刻ではない。
- 全保存時刻はUTCのISO 8601、ミリ秒3桁と`Z`を必須にする。画面・日付選択・曜日・時間帯比較は`Asia/Tokyo`。UTC日付のファイル名をJST日付として扱わない。
- 現在値APIなので、収集開始前や取得を逃した過去の人数は復元しない。遅延した実行を予定時刻へ戻したり、欠測を0人で埋めたりしない。

## 取得と配信

`.github/workflows/steam-player-count-dispatch.yml`をmainで動かし、起動役が毎時07・22・37・52分（UTC/JST共通の分）に、単発の`.github/workflows/steam-player-count.yml`を呼び出す。1回の実行で5作品を取得し、作品ごとに1日96観測が目標。通常は合計480 API要求/日となる。取得workflow自身のcronは外し、二重の定期取得を避ける。ゲーム追加で起動役やworkflowを増やさない。

起動役は最大330分（5時間半）だけ動く。毎時11分のcronで次の起動役を補充し、同時に動くのは1つ、交代待ちは最大1つとする。新しい予定起動は交代待ちだけを置き換え、動作中の起動役は中断しない。GitHub-hosted jobの6時間上限より前に通常終了する。起動役・取得処理とも固定リポジトリのmainだけを使う。

[GitHub Actionsのschedule](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)には遅延・取りこぼしがある。2026-11-01の確認では、従来の15分cronで定期実行が4回しかなく、約3〜4時間間隔になっていた。新方式は起動役が動いている間の15分タイマーをcronから分離する。交代する起動役まで届かない場合、runner停止、取得jobの待ち行列、API失敗では欠測し得る。15分間隔を保証するものではなく、欠けた過去の人数を再取得したことにはしない。public repositoryで60日間repository activityがないとcronが停止する仕様もある。

起動役だけに`actions: write`を与え、短命な`GITHUB_TOKEN`で固定の取得workflowを`workflow_dispatch`する。[このイベントはGITHUB_TOKENによる起動にも対応する](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow)。取得jobの`contents: read`、公開jobの`contents: write`とartifactによる受け渡しは既存のまま維持する。個人トークンや新しいSecretは追加しない。

取得処理自体は短いが、起動役は待機中もrunnerを1枠使用する。連続稼働なら約1,440 runner分/日と取得・公開jobの分数がかかる。[公開リポジトリの標準GitHub-hosted runnerは無料](https://docs.github.com/en/billing/concepts/product-billing/github-actions)。非公開化による意図しない待機時間の課金を避けるため、起動役jobは公開リポジトリの場合だけ開始する。

1. `collect`はNode 24の標準`fetch`で5作品を順番に取得する。依存パッケージのインストールやブラウザー起動は不要。作品ごとに実際の応答完了時刻を記録し、全作品を同時刻として扱わない。
2. HTTPと本文読み取りの制限時間は1試行15秒。通信失敗・429・5xxのみ最大3試行。`Retry-After`は秒数・HTTP日付に対応し、5秒を超える待機を要求されたらその回は失敗として終える。429の再試行を使い切った場合や、終了時にサーバーの待機要求が残る場合は、同じホストへの残り作品の要求も行わず`backoff`として記録する。それ以前の成功分は保存する。サーバー指定より早く別作品を要求して待機を回避しない。
3. APIの成功状態と非負の安全な整数を検証する。確認済み0人は正常値。不正JSON・API失敗・取得失敗から0人を作らない。
4. `contents: read`の取得jobが、App ID・出典・検証済み観測、または失敗理由コードを含む`batch.json`をartifactへ保存する。保持は30日。1作品が失敗しても他作品の取得を続け、成功した作品の履歴は公開する。失敗作品の過去履歴は維持し、その回を0人で補完しない。一部または全部が失敗した場合は取得job・runを失敗状態にし、公開jobは保存済みartifactから成功分を取り込む。
5. `contents: write`の公開jobが専用ブランチ`codex/steam-player-count-history`だけへ履歴を保存する。mainやGitHub Pagesのビルド・デプロイはデータ取得ごとには実行しない。
6. 取得jobは並列可能。公開jobだけを専用concurrencyで直列化し、[`queue: max`](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)を使う。上限100件であり、無制限の保管キューではない。起動役の交代待ちは別のconcurrency groupで1件に限定する。

### 起動・停止と確認

- 有効化後はActionsの「Schedule Steam player count every 15 minutes」をmainで手動実行すると起動役が始まり、次の07・22・37・52分から取得する。起動役は長時間`in_progress`のままで正常。各観測の成否は「Collect Steam player count」の短いrunで確認する。
- 起動役を停止するには同workflowを無効化する。動作中の起動役も最大約60秒の確認間隔で無効化を検知して終了する。直ちに止める場合は動作中・交代待ちのrunもキャンセルする。すでに起動済みの取得jobは別runなので必要なら個別に止める。
- 再開は同workflowを有効化し、mainで手動実行する。取得workflowだけが無効化されている場合は、そちらも有効化する。
- スロットは壁時計の固定時刻に合わせる。取得処理にかかった秒数を次の15分に足し込まず、遅れた過去スロットの連続実行もしない。同一スロットの既存起動や実行中の取得がある場合は重複起動を抑止する。
- dispatch応答が失われた場合、実行が届いたか不明なので同じスロットではPOSTを再送しない。認証・権限・workflow不明のエラーは停止し、通信障害などは記録して次の予定時刻を待つ。取得成功の判断は起動役のPOST成功ではなく、取得run・公開runと履歴JSONで行う。

作品ごとの履歴がまだ存在しない最初の公開では、そのmainコミットの同梱履歴をハッシュ・形式検証して初期履歴へコピーし、それから新しい観測を追加する。これにより同梱した初回実測が自動取得へ切り替わる際も残る。既存履歴は同梱データで上書きしない。追加作品の同梱manifestは初期状態では空であり、未取得を0人として扱わない。配信用JSONは`.gitattributes`でLFを固定し、checkout時の改行変換によるハッシュ不一致を防ぐ。

pushが拒否された場合は最大3回まで最新履歴を再取得し、同じartifactを再マージする。生成JSONをforce pushしたり、競合した観測を捨てたりしない。公開失敗時は保持されたartifactから公開jobを再実行する。artifact名は取得jobのoutputを引き継ぐため、公開jobだけの再実行で変わる`GITHUB_RUN_ATTEMPT`に影響されない。保持期間を過ぎたartifactやGitHub側で開始されなかった取得は自動復元できない。

## 配信用形式

SF6は従来の履歴ブランチの`public/index.json`と`public/days/YYYY-MM-DD.json`をそのまま配信する。追加作品は同ブランチの`games/<保存キー>/index.json`と`games/<保存キー>/days/YYYY-MM-DD.json`に分離する。同梱先はSF6が`public/data/steam-player-count`、追加作品が`public/data/steam-player-count-games/<保存キー>`。1観測1ファイルにはしない。`schemaVersion: 1`を維持し、`appId`と`sourceUrl`が選択した作品の定義と一致することを検証する。

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

GitHubでのIDはSF6が従来の`steam-<runId>-<runAttempt>`、追加作品は`steam-<appId>-<runId>-<runAttempt>`。作品別の履歴内で重複判定するため、同じrunの異なる作品の観測は別々に保存できる。ローカル単発取得は実測時刻とUUIDを含む別IDで、実行情報は両方`null`とする。`requestStartedAt <= observedAt`を検証する。再試行が成功した場合は、その成功したHTTP要求の開始・終了時刻を使う。

日別ファイルは`{ schemaVersion, appId, date, observations }`。`date`は`observedAt`のUTC日付で、観測を`observedAt`、`id`の順に並べる。

manifestは`{ schemaVersion, appId, sourceUrl, generatedAt, days }`。各日について`date`、`path`、`sha256`、`observationCount`、`firstObservedAt`、`lastObservedAt`を持つ。`sha256`は配信するUTF-8ファイルの実バイト列から計算する。`generatedAt`は公開用データの生成時刻で、観測日時と区別する。

公開処理は既存のmanifest・全日別ファイル・ハッシュ・観測IDを検証してから、変更対象の1日とindexだけを更新する。同じ観測IDまたは同じGitHub実行回の内容変更は、日付をまたいでも拒否する。同一artifactの再公開は既存ファイルを変更しない。

複数作品のartifactは`{ schemaVersion: 1, runId, runAttempt, results }`。`results`は登録済み5作品をそれぞれ1件だけ含み、成功時はApp ID・出典・観測を持つcapture、失敗時は理由コードを持つ。対象不明、作品の重複・欠落、captureと外側のApp IDの不一致、実行情報の不一致を拒否する。履歴ブランチへのpushは成功した各作品の変更をまとめた1コミットとする。

日別ファイルを先に原子的に置換し、indexを最後に置換する。途中の読込で両者の版がずれても、画面のハッシュ検証で採用しない。indexの置換に失敗したら以前の日別ファイルを復元し、新規の日なら削除する。復元自体に失敗した場合は`.steam-publication-*`内のバックアップと`.public-steam.lock`を残す。プロセス停止でこれらが残った場合も、所有プロセス・indexのハッシュ・バックアップを確認してから復旧し、ロックを無条件に消さない。

## 時間帯比較

- 15分区間は予定cron時刻ではなく`observedAt`で決める。同一区間に複数観測があれば、最も早い実測を1件採用する。元の観測履歴は削除しない。
- 各JST日×時間について4つの15分区間がそろった場合だけ、その4観測の平均を算出する。
- 同じ時間帯の日別平均を、各日を等しく重み付けして平均する。取得回数が多い日を重くしない。
- 有効日数と取得区間数/予定区間数を併記する。4区間未満の時間の平均は欠測扱いで、補間しない。
- 初期期間は原則として昨日までの直近14日。収集初日など完了した日がまだない場合は、ある観測を表示する。時間帯比較に有効な観測がまだなければ、その状態を示す。
- これは離散時点の観測平均で、期間内の厳密な時間積分平均ではない。祝日判定はせず、平日/月〜金と土日を区別する。
- ゲーム選択は読み込み中・未取得・エラー時にも操作できる。作品を変えたら日付範囲はその作品の初期期間に戻し、タブと曜日は維持する。取得・キャッシュ・集計状態を作品ごとに分離し、別作品の数値を新しい作品名の下に表示しない。

## 手元での確認

単発取得は明示した新しい出力ディレクトリへ保存する。既存の`observation.json`は上書きしない。

```sh
node scripts/collect-steam-player-count.ts --collect --output .local/steam-player-count/manual-001
node scripts/publish-steam-player-count.ts --input .local/steam-player-count/manual-001/observation.json --output .local/steam-player-count/preview/public
node scripts/collect-steam-player-count.ts --collect --output .local/steam-player-count/tekken-001 --app-id 1778820
node scripts/publish-steam-player-count.ts --input .local/steam-player-count/tekken-001/observation.json --output .local/steam-player-count/preview/games/tekken-8 --app-id 1778820
node scripts/collect-steam-player-count.ts --collect-all --output .local/steam-player-count/all-001
node scripts/publish-steam-player-count.ts --batch .local/steam-player-count/all-001/batch.json --output .local/steam-player-count/preview-all
node --test scripts/collect-steam-player-count.test.ts scripts/publish-steam-player-count.test.ts scripts/publish-steam-player-count-history.test.ts
node --test scripts/dispatch-steam-player-count.test.ts
```

単発取得・ローカル取り込みは定期取得の有効化や履歴ブランチへのpushを行わない。取得データの公開・履歴ブランチへの書き込みは固定mainのworkflowから呼ぶ`publish-steam-player-count-history.ts`に限定する。起動役のPOSTも固定mainのworkflowから固定の取得workflowだけを対象にする。synthetic testでは実Steam APIやGitHub APIへ接続しない。

既存のLegend取得workflowから、取得と公開の権限分離・artifact受け渡し・専用履歴ブランチの構成を再利用した。Steamの高頻度観測、日別ファイル、SHA-256照合、実時刻の時間帯集計は専用処理として実装する。`arknights_2`の取得コードはtimeout・限定retry・検証後保存の参照元とし、実行時の外部ローカルパス依存は追加しない。
