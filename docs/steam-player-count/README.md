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

起動役は最大330分（5時間半）の取得起動を行い、通常終了時に次の起動役を予約する。引き継ぎ確認は別に最大120秒とし、GitHub-hosted jobの6時間上限より前に終了する。毎時11分のcronは、起動役や引き継ぎが停止した場合の復旧用として残す。起動役・取得処理とも固定リポジトリのmainだけを使う。

同時に動く起動役は1つ、交代待ちは最大1つ。通常終了時に両workflowの有効状態を確認し、既に後続が待機していれば利用する。なければ固定mainの同じ起動workflowを1回だけ`workflow_dispatch`し、後続runを確認する。POST応答が不明な場合も再送せず、run一覧で確認する。確認できなければ引き継ぎ失敗として記録し、Actionsを失敗状態にする。新しい定期起動が交代待ちを置き換えても、動作中の起動役は中断しない。

[GitHub Actionsのschedule](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)には遅延・取りこぼしがある。2026-11-01の確認では、従来の15分cronで定期実行が4回しかなく、約3〜4時間間隔になっていた。15分タイマーを起動役に移した後も、2026-11-02には16:04の通常終了後に後続cronが届かず、16:07〜17:07の5枠が欠測した。自己引き継ぎにより、通常の世代交代をcronだけに依存させない。runner停止、引き継ぎ要求の失敗、待ち行列、API失敗では欠測し得る。15分間隔を保証するものではなく、欠けた過去の人数を再取得したことにはしない。public repositoryで60日間repository activityがないとcronが停止する仕様もある。

起動役だけに`actions: write`を与え、短命な`GITHUB_TOKEN`で固定の取得workflowと後続の起動workflowを`workflow_dispatch`する。[このイベントはGITHUB_TOKENによる起動にも対応する](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow)。取得jobの`contents: read`、公開jobの`contents: write`とartifactによる受け渡しは既存のまま維持する。個人トークンや新しいSecretは追加しない。

自己起動した後続には引き継ぎ元のrun ID・attemptを渡す。後続は開始時に固定リポジトリ・main・起動workflow・attempt・親の完了状態と`Confirm Steam successor reservation`ステップの成功を確認する。親がキャンセルやタイムアウトで終わった場合は、取得も次世代の予約も行わない。途中の観測起動に一時的な失敗があっても、通常時間を完走して引き継ぎ確認に成功した親からは継続できる。過去の取得失敗は引き続きActionsの失敗状態に残す。

取得処理自体は短いが、起動役は待機中もrunnerを1枠使用する。連続稼働なら約1,440 runner分/日と取得・公開jobの分数がかかる。[公開リポジトリの標準GitHub-hosted runnerは無料](https://docs.github.com/en/billing/concepts/product-billing/github-actions)。非公開化による意図しない待機時間の課金を避けるため、起動役jobは公開リポジトリの場合だけ開始する。

1. `collect`はNode 24の標準`fetch`で5作品を順番に取得する。依存パッケージのインストールやブラウザー起動は不要。作品ごとに実際の応答完了時刻を記録し、全作品を同時刻として扱わない。
2. HTTPと本文読み取りの制限時間は1試行15秒。通信失敗・429・5xxのみ最大3試行。`Retry-After`は秒数・HTTP日付に対応し、5秒を超える待機を要求されたらその回は失敗として終える。429の再試行を使い切った場合や、終了時にサーバーの待機要求が残る場合は、同じホストへの残り作品の要求も行わず`backoff`として記録する。それ以前の成功分は保存する。サーバー指定より早く別作品を要求して待機を回避しない。
3. APIの成功状態と非負の安全な整数を検証する。確認済み0人は正常値。不正JSON・API失敗・取得失敗から0人を作らない。
4. `contents: read`の取得jobが、App ID・出典・検証済み観測、または失敗理由コードを含む`batch.json`をartifactへ保存する。保持は30日。1作品が失敗しても他作品の取得を続け、成功した作品の履歴は公開する。失敗作品の過去履歴は維持し、その回を0人で補完しない。一部または全部が失敗した場合は取得job・runを失敗状態にし、公開jobは保存済みartifactから成功分を取り込む。
5. `contents: write`の公開jobが専用ブランチ`codex/steam-player-count-history`だけへ履歴を保存する。mainやGitHub Pagesのビルド・デプロイはデータ取得ごとには実行しない。
6. 取得jobは並列可能。公開jobだけを専用concurrencyで直列化し、[`queue: max`](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)を使う。上限100件であり、無制限の保管キューではない。起動役の交代待ちは別のconcurrency groupで1件に限定する。

### 起動・停止と確認

処理の版と変更内容は [変更履歴](CHANGELOG.md) で管理する。Actionsの各jobの「Record Steam collection process version」とサマリーで、起動役・取得・履歴保存それぞれの版とコミットを確認できる。ローカルでの版確認は `node scripts/lib/steam-collection-version.ts --version`。

ページ上部には「取得処理：実装版」と「変更履歴」を表示する。ゲーム別・ゲーム比較の共通部分に置き、観測データの読み込み中や失敗時にも利用できる。履歴ダイアログには版・コミット日時（JST）・変更内容・コミットへのリンクを新しい順に表示し、後付けの版名を区別する。Escape、閉じるボタン、背景クリックで閉じ、開いたボタンへフォーカスを戻す。これはページに同梱した実装の版であり、稼働中のActionsや最新観測の取得版を表さない。取得CLIと画面は `src/lib/steamCollectionVersion.ts` の定義を共有し、観測JSONの形式は変更しない。

- 有効化後はActionsの「Schedule Steam player count every 15 minutes」をmain・`mode: standard`で手動実行すると起動役が始まり、次の07・22・37・52分から取得する。引き継ぎ元ID・attemptは手動起動では空欄にする。起動役は長時間`in_progress`のままで正常。各観測の成否は「Collect Steam player count」の短いrunで確認する。
- 起動役を停止するには同workflowを無効化する。動作中の起動役も最大約60秒の確認間隔で無効化を検知して終了する。直ちに止める場合は動作中・交代待ちのrunもキャンセルする。すでに起動済みの取得jobは別runなので必要なら個別に止める。
- 再開は同workflowを有効化し、mainで手動実行する。取得workflowだけが無効化されている場合は、そちらも有効化する。
- スロットは壁時計の固定時刻に合わせる。取得処理にかかった秒数を次の15分に足し込まず、遅れた過去スロットの連続実行もしない。同一スロットの既存起動や実行中の取得がある場合は重複起動を抑止する。
- 過去スロットの最新runが未完了の場合は、5秒待って1回だけ再確認する。起動役・取得workflowの有効状態、該当runの詳細、最新run一覧を順に読む。詳細が完了済みでも、同一run ID・attempt・作成時刻であることと、一覧が詳細より新しい更新を持たないことを確認できた場合だけ、一覧の古い未完了表示を解除する。別run・再実行・状態の食い違いは見送り、同じスロットや未来スロットは完了済みでも二重起動しない。
- 再確認の待機とAPI処理は、予定時刻から60秒の猶予と起動役全体の実行予算の両方に収める。無効化・確認失敗・猶予切れでは起動せず、次の予定時刻を維持する。再確認はGitHubのGETのみで、取得を起動するPOSTの再送は追加しない。
- dispatch応答が失われた場合、実行が届いたか不明なので同じスロットではPOSTを再送しない。認証・権限・workflow不明のエラーは停止し、通信障害などは記録して次の予定時刻を待つ。取得成功の判断は起動役のPOST成功ではなく、取得run・公開runと履歴JSONで行う。
- 引き継ぎの単発検証はmainを`mode: handoff-check`で起動する。2分で通常終了して後続を予約し、後続は必ず通常の330分モードへ戻る。検証時間を次世代へ引き継がない。既に起動役が動いていれば検証runは待機する。切り替える場合は検証runの待機を確認してから旧runだけをキャンセルし、検証runの正常終了・後続の開始・次の取得と保存を順に確認する。
- 起動役のログには引き継ぎ要求・確認・失敗と後続run IDを記録し、成功時のActionsサマリーにも後続IDを残す。無効化・認証拒否・レート制限などで通常時間より前に停止した場合や、親の確認に失敗した場合は後続を自動予約しない。
- `collection-state`・`collection-recheck`・`collection-recheck-cleared`で判定前後のrun ID・attempt・状態・作成/更新時刻を記録する。`slot-skipped`は`active-run`・`current-slot`・`future-slot`・`run-changed`・`late`・`attempt-limit`・`budget-exhausted`を区別する。`slot-failed`・`request-failed`には固定の処理段階、HTTP番号、通信/timeout/JSON/サイズ/形式エラーの分類を残し、予定時刻・遅延・試行数と照合できるようにする。認証情報・ヘッダー・レスポンス本文・任意の例外メッセージは記録しない。

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
- 初期期間は今日を含む直近7日。「今日・昨日・直近7日・直近30日・全期間・日付指定」のボタンで切り替える。7日・30日は今日を終端とした暦日数であり、直近168時間・720時間ではない。「日付指定」のときだけ開始日・終了日を表示する。
- 「今日」「昨日」「直近7日」「直近30日」は既存の5分更新とタブ復帰時にJSTの日付から再計算する。「全期間」はそのゲームの保存履歴の最古日〜最新日を使い、履歴追加に追従する。日付指定は固定する。
- 表示期間とデータ範囲を分けて表示する。指定期間が履歴より前でも別の日へ自動で移動せず、対象の観測がなければ未取得として示す。欠測を0人として補完しない。日付入力は未来日を今日へ補正し、開始日と終了日が逆転した場合は反対側の境界を合わせる。
- 時間帯比較の日数・予定区間は、表示期間のうち保存履歴の最古JST日以降を対象にする。履歴より前の日を予定区間に加えない。表示期間全体が履歴より前なら対象日数・予定区間は0、平均は算出不可とする。最古の観測時刻を取得処理の開始時刻とはみなさず、その日の欠けた区間や以降の欠測は残す。
- これは離散時点の観測平均で、期間内の厳密な時間積分平均ではない。祝日判定はせず、平日/月〜金と土日を区別する。
- ゲーム・期間・曜日の選択は読み込み中・未取得・エラー時にも操作できる。作品を変えても期間の種類、指定した日付、タブ、曜日を維持する。「全期間」の実際の日付だけは各作品の履歴に合わせる。取得・キャッシュ・集計状態を作品ごとに分離し、別作品の数値を新しい作品名の下に表示しない。
- 表示条件は既存の`StatisticsPanel`、選択操作は`WinRatesPage`の`win-rates-view-selector`・`aria-pressed`ボタンを再利用する。狭い画面では期間ボタンを3列2段にし、開始日・終了日は必要に応じて縦に並べる。

## ゲーム比較

「ゲーム別」と「ゲーム比較」を切り替え、ゲーム比較では初期状態で5作品を選択する。期間・曜日は両表示で共用し、比較作品は最低1作品を維持する。比較画面は次の3タブで構成する。

- **時間帯比較**：24時間の平均をゲームごとの折れ線で重ねる。人数と「各ゲーム平均＝100」を切り替える。指数は時間帯平均÷そのゲームの期間平均×100で、期間平均が0の場合は算出不可。
- 人数表示の縦軸は全選択ゲームで共通の0起点とし、表示中の時間帯平均の最大値に5%の余白を加え、目安7区間となる読みやすい整数刻み（1・2・2.5・5の10倍系列）で上限を切り上げる。ゲーム・期間・曜日の変更で再計算し、0のみ・全欠測の範囲は0〜1とする。
- **期間比較**：「期間平均の同時接続数」または「期間内の観測最大同時接続数」を横棒で比較する。値の降順、欠測は末尾。横軸は0から始め、人数を直接表示する。
- **時間帯一覧**：ゲームごとの時間帯平均、共通有効日数、共通取得区間数/予定区間数をテーブルで表示する。

比較では選択中の全作品に観測がある15分区間を求め、4区間すべてがそろったJST日×時間だけを採用する。期間平均は、採用した時間の平均を日ごとに求めてから各日を等しく重み付けして平均する。観測最大もこの共通の日時に含まれる個々の実測値から求める。期間中のユニーク利用者数ではない。全作品で観測がそろわない日時は比較値から除き、欠測を0人で補完しない。実測0人は有効値として扱う。

「共通データ範囲」は全選択作品の保存履歴の日付範囲の重なり。「全期間」はこの範囲を使う。それ以外の期間ボタンは同じ暦日範囲を全作品へ適用し、予定区間の計算は全作品の収集開始日以降とする。グラフ下の共通日数・時間数・区間数は比較値に採用した完全な時間だけを数える。時間帯一覧の取得区間数には、4区間未満でも全作品に存在する共通区間を含む。

配色・線種・記号はApp IDに対応する`steamPlayerCountGameColors.ts`で固定する。ゲーム選択、折れ線、横棒、凡例、テーブルの対応を揃え、選択順や平均の大小で色を変えない。欠測をまたぐ折れ線は接続せず、時刻選択時だけ各系列の記号を表示する。

期間入力は`SteamPlayerCountFilters`、作品選択は既存の`ComparisonSelection`、パネルとグラフ操作は既存のSteam表示部品を再利用する。取得データは既存feedの検証・キャッシュを作品別に使い、全作品をまとめて表示へ反映する。一部作品の更新が失敗した場合は前回の検証済みデータ全体を維持し、更新失敗を表示する。作品・期間を切り替えた直後に以前の条件の値を表示しない。

集計は`steamPlayerCountComparison.ts`、読込管理は`steamPlayerCountComparisonFeed.ts`・`useSteamPlayerCountComparison.ts`、表示は`SteamPlayerCountComparisonView.tsx`・`SteamPlayerCountComparisonCharts.tsx`で扱う。

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

単発取得・ローカル取り込みは定期取得の有効化や履歴ブランチへのpushを行わない。取得データの公開・履歴ブランチへの書き込みは固定mainのworkflowから呼ぶ`publish-steam-player-count-history.ts`に限定する。起動役のPOSTも固定mainのworkflowから固定の取得workflow・起動workflowだけを対象にする。synthetic testでは実Steam APIやGitHub APIへ接続しない。

既存のLegend取得workflowから、取得と公開の権限分離・artifact受け渡し・専用履歴ブランチの構成を再利用した。Steamの高頻度観測、日別ファイル、SHA-256照合、実時刻の時間帯集計は専用処理として実装する。`arknights_2`の取得コードはtimeout・限定retry・検証後保存の参照元とし、実行時の外部ローカルパス依存は追加しない。
