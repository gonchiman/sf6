# Bucklerの認証・閲覧検証

週次取得の前段階として、手動ログイン後のランキング閲覧と、暗号化保存した状態の別起動での再利用を調べるローカル専用ツール。
アプリの起動、ランク分布の更新、定期実行、GitHub Actionsの設定は行わない。

## 接続設定なしでログインしてから再起動する手順

接続用の設定を付けた専用Edgeでは、取得ツールを接続する前の手動ログインも失敗した。一方、通常のInPrivateではユーザーから「ログインできたと思う」と報告された。この報告は取得ツールによるログイン確認や認証再利用成功とは扱わず、起動設定や環境の違いを調べる手掛かりとする。
専用Edgeを接続設定なしで通常起動し、人間がログインした後に同じ専用プロファイルを接続用に再起動する手順を追加した。

```sh
npm run data:probe-buckler-session -- --open-login-browser
npm run data:probe-buckler-session -- --capture --login-browser
npm run data:probe-buckler-session -- --reuse
```

1. `open-login-browser`で`OPEN`に同意すると、固定の専用プロファイルを使うEdgeを開く。デバッグ用の引数もPlaywrightの接続も付けない。
2. ユーザーがこの専用Edgeで手動ログインし、Bucklerの総合ランキングに戻る。既存のInPrivateや普段のログイン済みブラウザーから認証情報をコピーしない。
3. `capture --login-browser`でログイン完了・再起動・暗号化保存に同意して`SAVE`を入力する。その専用Edgeだけを終了し、同じ専用プロファイルを接続用の設定で起動し直す。
4. 再起動後にログイン済み表示・固定条件のランキングを確認できた場合だけ、既存のStreet Fighter限定DPAPI保存を実行する。未認証なら保存しない。
5. 保存できたら、専用プロファイルを使わない`reuse`で新しい使い捨てEdgeへ暗号化状態を渡し、別起動で取得できるか確認する。

ブラウザーはプロファイルにCookie等を保持する場合がある。保存先・Git管理対象外・クラウドへ送らない条件は下記と同じ。手動ログイン中の専用Edgeだけを終了する場合は`--close-login-browser`を使う。取得ツールが接続用に再起動済みの場合は`--close-manual-browser`を使う。
2026年10月15日に、手動ログイン後の専用プロファイルの再起動、ログイン済み表示の確認、DPAPIによる暗号化保存、同じPC・Windowsユーザーでの別プロセスと新しいEdgeコンテキストへの即時再利用を確認した。同日、別途ユーザーの許可を受けた[クラウド取得検証](cloud-probe.md)でも保存状態の再利用と先頭20件の取得を確認した。1週間後の認証保持、全ランク分布の取得、週次の無人取得は未確認。

## 通常起動した専用Edgeへの接続

Playwrightが起動するEdgeでCAPCOM IDのCloudflare認証が繰り返されるため、通常起動した専用Edgeでユーザーが手動ログインし、完了後に取得ツールを接続する方式を追加した。
Cloudflareの認証を自動で解く処理や、ブラウザーの識別情報を偽装する処理はない。この方式でのログイン成功・認証再利用は実際の操作で確認する必要がある。

```sh
npm run data:probe-buckler-session -- --open-manual-browser
npm run data:probe-buckler-session -- --capture --manual-browser
npm run data:probe-buckler-session -- --reuse
```

1. `open-manual-browser`の説明を確認し、専用プロファイルの利用に同意する場合は`OPEN`を入力する。インストール済みEdgeを通常起動し、この時点ではPlaywrightを接続しない。
2. 開いた専用Edgeで手動ログインし、Bucklerの総合ランキングへ戻る。ID・パスワードやロボット確認はユーザー自身が操作する。
3. `capture --manual-browser`を実行する。接続と暗号化保存に同意する場合に`SAVE`を入力し、その後初めて専用Edgeへ接続する。ログイン済み表示と固定条件の先頭ページを確認できた場合だけ、既存のDPAPI保存処理を実行する。
4. 接続後の検証が終了すると専用Edgeを終了する。`reuse`はこの専用プロファイルを使わず、新しい使い捨てEdgeへ暗号化状態を読み込むため、プロファイル自身のログイン保持と区別できる。

専用プロファイルはGit管理対象外の`.local/buckler-auth-probe/manual-browser-profile`固定。
通常のブラウザーと同様に、CAPCOM IDを含むCookie・Local Storage等をブラウザー自身がこのプロファイルに保持する場合がある。暗号化ファイルだけに認証情報が残る方式ではない。
取得ツールが書き出す`private-session.dpapi`は引き続きStreet Fighterサイトの状態だけを含み、CAPCOM IDの状態や入力したパスワードは含めない。専用プロファイルも暗号化ファイルもGitHubやクラウドに送らない。

普段のEdgeプロファイルやCodex内ブラウザーは接続・読み取り・コピーしない。専用Edgeのプロセス・起動時刻・固定プロファイル・このPC内の接続先の一致を確認する。
接続方式は[Edge公式のDevTools Protocol](https://learn.microsoft.com/en-us/microsoft-edge/devtools/protocol/)と[PlaywrightのconnectOverCDP](https://playwright.dev/docs/api/class-browsertype#browser-type-connect-over-cdp)を使用する。

`SAVE`前に中止した場合、取得ツールは未接続で、専用Edgeは開いたまま残る。終了するには次を実行する。プロファイル自身は削除しない。

```sh
npm run data:probe-buckler-session -- --close-manual-browser
```

## 別起動による再利用検証

2026年10月14日に、初回ログイン状態を保存し、完全に終了した後の別Nodeプロセスから再利用する検証用コマンドを追加した。
Windowsの同じユーザーで、次を順に実行する。

```sh
npm run data:probe-buckler-session -- --capture
npm run data:probe-buckler-session -- --reuse
```

`capture`は新しい通常表示のEdgeを開く。公式ページで手動ログインし、認証状態の保存に同意した場合だけターミナルに`SAVE`と入力する。
指定条件の先頭ページとログイン済み表示を確認できた場合に限り、Street FighterサイトのCookie・Local Storageを`.local/buckler-auth-probe/private-session.dpapi`へWindows DPAPI CurrentUserで暗号化保存する。
CAPCOM ID側の状態、入力したパスワード、通信ログを保存しない。認証ファイルをGitHubやクラウドへ送らない。
認証ファイルの保存先は固定で、任意パス・リンク・不正形式を拒否する。既存の`data:probe-buckler-auth`は引き続き認証状態を保存しない。

`capture`が終了し、Edgeも閉じた後、別の起動で`reuse`を実行する。暗号化状態を同じWindowsユーザーで復号し、新しいEdgeへ引き継いで先頭ページを読む。
`reuse`は手動ログインを求めず、保存状態も更新しない。異なるプロセスからログイン済み表示・先頭ページを確認できた場合だけ`separateLaunchReuse: confirmed`となる。
Cookieの内容・ユーザーID等は結果に含めず、件数・状態・起動を区別するメタデータだけ保存する。
暗号ファイルのSHA-256とcaptureの記録を照合し、保存の中断・不一致があれば再利用を拒否する。メタデータもリンク・reparse検査後に一時ファイルから安全に置換する。
起動UUIDを別起動の判定に使い、再利用され得るPIDは補助情報とする。
この検証の成功は、1週間後の期限、毎回の自動ログイン、GitHub Actionsや全ランクの取得成功を示すものではない。
DPAPIファイルを別ユーザーやGitHub Actionsへコピーして使う構成は対象外。

初回の匿名検証では、通常表示のEdgeはサイトを表示したがランキング行・選択欄を確認できなかった。画面を表示しないEdgeではCloudFrontの403・Request blockedを確認した。
この応答をログイン要求や正常取得とは扱わず、ブラウザーの識別情報変更や認証の迂回は行わない。
保存処理の14件のオフラインテスト・型検査、および人工データと仮想ファイルによる実DPAPIの暗号化・復号を確認した。

### 2026年10月15日・通常起動方式の実起動とログイン結果

初回の起動前チェックでは、Nodeから起動したWindows PowerShellが`Get-AuthenticodeSignature`を見つけられず終了した。Edge本体の署名は`Valid`、署名者と製品名も正常だったため、Windows PowerShell付属の`Microsoft.PowerShell.Security`を明示的に読み込むよう修正した。Microsoft署名の検証は維持している。

修正後、公開実行ファイルの署名確認と15件の安全テスト・型検査が成功した。13:28（日本時間）に専用Edgeの通常起動と、専用プロセス・プロファイル・このPC内の接続先の一致を確認した。起動コマンドは正常終了し、Edgeを開いたまま手動ログインを待つ状態まで進んだ。
この時点ではPlaywrightを接続しておらず、認証状態の暗号化保存・別起動での再利用は未検証。専用プロファイルは作成済みで、ブラウザー自身による状態の保持と、取得ツールによる暗号化保存を区別する。

続く手動ログインでは、ユーザーからCloudflareの確認を完了できないと報告された。添付画像は10月14日に提示された既存画像であり、10月15日の新しい画面観測として扱わない。`SAVE`前のcaptureをCtrl+Cで中断し、終了コード1と、`private-session.dpapi`・`session-capture.json`が存在しないことを確認した。Playwright・CDPは未接続で、Cookieの書き出し・DPAPI保存・reuseはいずれも実施していない。作成した専用プロファイルは保持し、ブラウザー自身が残した状態の有無を取得ツールによる認証保存の成功と扱わない。

その後、専用Edgeの終了コマンドが正常終了し、起動メタデータが削除されたことを確認した。専用プロファイル本体は削除していない。

この結果だけでは起動方式だけが失敗原因とは確定できない。同じ方式の試行を反復せず、次の切り分け候補は、デバッグ接続の設定もない通常のブラウザーをユーザー自身が開き、CAPCOM IDへの新規ログインが成立するか確認すること。現在ログインを保持しているブラウザーから、確認のために勝手にログアウトしない。

その後、通常のInPrivateでユーザーから「ログインできたと思う」と報告された。続く検証のため、接続設定なしで同じ専用プロファイルを開く方式を追加し、全404件のテストと型検査を確認した。13:52（日本時間）に`open-login-browser`の専用Edge起動が正常終了した。`capture --login-browser`はユーザーのログイン完了と`SAVE`の同意を待っており、この時点では接続用の再起動・Playwright接続・暗号化保存は実施していない。既存のInPrivateには接続せず、内容もコピーしていない。

`SAVE`後の`capture --login-browser`では、読み込み直後の観測が`anonymous-readable`、表示総件数3,060,454件となり、認証状態は保存しなかった。この結果だけで再起動時にログイン状態が失われたとは断定しない。別途作成した未認証の独立コンテキストでは`signedIn: false`・ランキング行未確認の`unsupported-dom`となり、匿名で正常取得できることも確認していない。

ログイン済み表示を期待するDOM読み取りに`expectSignedIn`を追加した。読み込み途中の`anonymous-readable`・`auth-unconfirmed-readable`で直ちに判定を終えず、最大10秒間ログイン済み表示を待つ。判定基準や保存条件を緩めず、手動ログイン後・保存同意後・reuseの読み取りでこの待機を使う。

修正後の`capture --manual-browser`で`signed-in-readable`・`authenticationStateSaved: true`を確認し、表示総件数は3,060,462件だった。数値・状態だけの結果は`.local/buckler-auth-probe/session-capture-2026-10-15T05-28-09-707Z.json`に記録した。これは実際のログイン済み表示の確認と、Street Fighterサイト限定の暗号化保存までの成功であり、別プロセスの`reuse`はこの時点で未検証。1週間後の期限、GitHub Actionsの認証、全ランク分布の取得成功を示すものではない。

captureと専用Edgeの終了後、14:30（日本時間）に別プロセスの`reuse`が正常終了した。保存時のPIDは4644、再利用時は28652で、起動UUIDによる別起動の判定も成立した。専用プロファイルを使わない新しいEdgeコンテキストへDPAPIの保存状態を読み込み、手動ログインなしで`signed-in-readable`・先頭20行を確認し、`separateLaunchReuse: confirmed`となった。表示総件数は3,060,465件で、保存時との件数変動は認証再利用の成否と区別する。

数値・状態だけの結果は`.local/buckler-auth-probe/session-reuse-2026-10-15T05-30-11-919Z.json`に記録した。この14:30時点のローカル検証では、認証情報をGit管理対象外の`private-session.dpapi`に暗号化保存し、GitHubやクラウドには送信していない。同じPC・Windowsユーザーでの即時再利用までを確認し、1週間後の有効性、GitHub Actionsでの認証、全ランク分布の取得、定期実行は未検証だった。その後の送信許可とクラウドでの取得結果は[クラウド取得検証](cloud-probe.md)に記録する。

### 2026年10月14日の別起動検証の結果

実際にcaptureコマンドを新規の通常表示Edgeで起動し、ユーザーが手動ログインを試した。しかしユーザーから「ロボットチェックを完了できずログインできなかった」と報告された。
保存への同意は受け取っておらず、captureへABORTを入力して終了した。`private-session.dpapi`と`session-capture.json`が作成されていないことを確認した。
認証成立前のため、保存・実Cookieの復号・reuseコマンドによる再起動検証はいずれも未実施。保存・再利用処理の人工テスト成功を、Bucklerの別起動認証成功とは扱わない。
ブラウザーの識別情報変更やロボットチェックの回避は実施していない。現時点では、この方法による週次の無人取得が成立するとは確認できない。

その後のcapture再試行も認証ループで失敗した。提供されたスクリーンショットとユーザー報告から、`auth.cid.capcom.com`の全画面Cloudflareセキュリティ検証とチェックボックスの表示を確認した。captureへCtrl+Cを送り、終了コード1での終了と、`private-session.dpapi`・`session-capture.json`が作成されていないことを確認した。認証状態は保存せず、reuseも実施していない。Playwrightによる起動方式が今回の失敗原因かは未確定。認証URLのクエリやスクリーンショットは保存・転載しない。

[Cloudflareの公式対応環境](https://developers.cloudflare.com/cloudflare-challenges/reference/supported-browsers/)では、本番のチャレンジを解く自動ブラウザー、およびSelenium・Playwright等のブラウザー自動化フレームワークは非対応とされている。この制約と再試行結果を踏まえ、同じ起動方式によるログイン試行の反復は止める。認証の自動突破やブラウザー識別情報の偽装は行わない。

## 実行

Node 24とプロジェクトの依存をインストールしてから、通常の対話ターミナルで実行する。

```sh
npm run data:probe-buckler-auth
```

1. 新しいEdgeウィンドウにBucklerの総合・最大LP・全地域・全プラットフォーム・全ユーザーの先頭ページを開く。
2. メンテナンスの場合は結果を記録して終了する。復旧後に改めて実行する。
3. 公式ページ上で自分でログインし、同じタブのランキング先頭ページに戻る。ID・パスワードはブラウザーにだけ入力する。
4. ターミナルに戻ってEnterを押す。初回表示を確認し、ログイン済みの証拠と完全なランキング表示を確認できた場合だけ、同じコンテキストの新しいタブで再表示する。
5. ブラウザーを閉じ、結果JSONの保存場所をターミナルに表示する。操作を中止する場合はCtrl+C。入力待ちは15分で終了する。

Edgeを利用できない場合は、インストール済みのChromeを指定できる。

```sh
npm run data:probe-buckler-auth -- --browser chrome
```

PlaywrightのChromiumを使う場合は、先に専用ブラウザーを導入する。

```sh
npx playwright install chromium
npm run data:probe-buckler-auth -- --browser chromium
```

Playwrightは表示付きの使い捨てブラウザーコンテキストを使用する。普段のブラウザープロファイルやCodexのログイン状態は引き継がない。
インストール済みEdge/Chromeの利用とブラウザーの導入方法は[Playwright公式ドキュメント](https://playwright.dev/docs/browsers#google-chrome--microsoft-edge)を参照。

## 判定と保存

結果はGit管理対象外の`.local/buckler-auth-probe/probe-日時.json`に保存する。保存する項目は固定出典URL、日時、状態、件数、条件確認の真偽値のみ。
Cookie、パスワード、ブラウザー状態、通信ログ、スクリーンショット、プレイヤーのID・名前、生のエラー文、認証リダイレクトURLを保存しない。
`public/data`は更新しない。

| 状態 | 意味 |
| --- | --- |
| `signed-in-readable` | 表示されているログアウト操作と、条件・件数が一致するランキング表示を確認した |
| `anonymous-readable` | 表示されているログイン操作と、正常なランキング表示を確認した。認証の証明にはならない |
| `auth-unconfirmed-readable` | ランキングは確認できるが、ログイン状態の証拠を確認できない |
| `maintenance` | メンテナンス画面を確認した |
| `login-required` | ログインを要求する画面の見出しを確認した |
| `condition-mismatch` | URLまたは選択欄が指定条件と一致しない |
| `unsupported-dom` | 表示形式、選択欄、カウンター、行数を確認できない。欠損を0件として扱わない |
| `timeout` / `read-failed` | 表示確認の時間切れまたは失敗 |

認証の証拠には表示されている「ログアウト」操作を使う。公開プロフィールへのリンクやログイン操作が見つからないことだけでは、ログイン済みと断定しない。
ログアウト操作がメニュー内に隠れている場合など、証拠を読み取れなければ`auth-unconfirmed-readable`になる。
先頭ページの件数は1〜20件、表示範囲と行数・総件数の一致を検証する。ランキングの自分枠を行数に含めない。

初回・新タブの両方が`signed-in-readable`の場合だけ`sameSessionReuse: confirmed`。その他は未確認または未検証。
終了コードは確認成功が0、記録はできたが認証再利用を確認できない場合が2、起動・操作・保存失敗が1。
総件数の変動は`totalsMatch`として別に記録し、ログイン失敗とは混同しない。ランク分布を集計できたことにはしない。

## 確認範囲

2026年10月13日の実装時点ではBucklerがメンテナンス中だった。メンテナンスの見出しは実画面で確認し、分類・件数・条件・秘密情報を残さない処理はオフラインテストで検証した。
正常時のDOM、ログアウト操作の表示、実際の手動ログイン、新タブでの再利用は復旧後の実行で確認が必要。
正常時DOMの読み取りには既存の通常ページ用エクスポーターのランキング・選択欄・カウンターのセレクターを参考にした。
出典条件の検証は既存の`rankBoundaryPageUrl`を再利用した。前身にも同用途の認証検証処理は見つからず、この診断処理を追加した。

既存の`data:probe-buckler-auth`は、別起動後の認証再利用、毎回の自動ログイン、認証の有効期間、7日後の再利用、GitHub Actions上の認証、深いページの取得を検証しない。
これらの項目は結果にも`not-tested`として残す。同一実行内の成功を、そのまま週次の無人取得成功として扱わない。

### 2026年10月13日・復旧後の実画面検証

17:12〜17:17（日本時間）に、Codexの既存のログイン済みブラウザーを使用し、リポジトリのDOM観測関数と判定処理を接続して確認した。
表示されているログアウト操作、固定条件、先頭ページ20行を確認し、同じブラウザーの新しいタブでも`signed-in-readable`になった。
今回のブラウザーセッション内の再利用は確認済み。ただしPlaywrightのCLIプロセスや使い捨てブラウザーは起動せず、新規の手動ログインも実施していない。

先頭ページの総件数は3,055,294件、新タブでは3,055,303件で、`totalsMatch: false`だった。
新タブの総件数から求めた152,766ページへ到達し、表示範囲3,055,301〜3,055,303と末尾3行の一致を確認した。3行とも0LPだが、ランクID・未ランクの扱いは未確認。
最終ページの到達は確認できたものの、総件数の固定と全35境界の確認は完了しておらず、ランク分布の配信用データは更新していない。

数値・状態だけの記録は`.local/buckler-auth-probe/browser-verification-2026-10-13T08-12-08-636Z.json`へ保存した。
記録には既存ブラウザーを利用したこと、CLI・手動ログインを実施しなかったこと、全分布が未検証であることも残す。
この10月13日の検証では、別起動・自動ログイン・認証の有効期間・GitHub Actions・週次の無人実行は未確認。別起動の即時再利用は、上記の10月15日の検証で別途確認した。

```sh
npm run test:buckler-auth
```
