import type { ParallelFetchErrorCode } from '../types/parallelFetch'
import type { CloudError, CloudMode, CloudServiceStatus, CloudState } from '../types/parallelFetchCloud'

export const numberLabel = (value: number) => new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 1 }).format(value)
export const durationLabel = (value: number | null) => value === null ? '—' : `${numberLabel(value / 1000)} 秒`

export const errorLabels: Record<ParallelFetchErrorCode, string> = {
  cancelled: '停止しました', 'limit-reached': '取得回数・時間の上限', 'out-of-range': '対象ページが範囲外',
  'http-denied': 'アクセス制限', 'server-error': '取得先のサーバーエラー', 'http-error': '取得先の応答エラー',
  maintenance: 'メンテナンス中', 'login-required': 'ログインが必要',
  'authentication-unconfirmed': 'ログイン状態を確認できません', 'human-verification': 'ロボット認証が必要',
  'condition-mismatch': '取得条件が不一致', 'page-mismatch': 'ページ番号が不一致',
  'unsupported-dom': 'ページを読み取れません', timeout: '取得がタイムアウト', 'read-failed': 'ページ取得に失敗',
  'session-unavailable': '保存済みログイン情報を利用できません', 'browser-unavailable': '取得用ブラウザーを起動できません',
  'invalid-request': '取得条件が不正',
}

export const cloudModeLabels: Record<CloudMode, string> = { serial: '直列を3回', compare: '並列1・2を比較', 'interval-compare': '取得間隔 × 並列数' }

export const cloudStateLabels: Record<CloudState, string> = {
  dispatching: '受付中', 'dispatch-unknown': '受付結果を確認中', queued: '待機中', preparing: '環境準備中',
  collecting: '取得中', 'loading-result': '結果を読込中', complete: '完了', failed: '失敗',
  'cancel-requested': '取消を要求済み', cancelled: '中止',
}

export const cloudErrorLabels: Record<CloudError, string> = {
  'dispatch-uncertain': '受付結果が未確認です。再送せず実行状況を確認します。',
  'github-unavailable': 'GitHubとの接続を確認できません', 'workflow-unavailable': 'テスト用ワークフローが利用できません',
  'workflow-failed': 'Actionsの実行に失敗しました', 'artifact-missing': '結果ファイルがありません',
  'artifact-expired': '結果ファイルの保存期限が切れています', 'artifact-download-failed': '結果ファイルを取得できません',
  'invalid-report': '結果ファイルの形式が不正です', 'state-save-failed': '実行記録を保存できません',
  'state-invalid': '保存した実行記録を読み取れません', 'run-ambiguous': '対応するActionsの実行を特定できません',
  'cancel-failed': '取消を確認できません', 'already-running': '実行中のテストがあります',
  'invalid-request': '実行条件が不正です', forbidden: 'この画面から操作を送信できません', 'service-closed': '取得サービスは終了しています',
}

export const readinessLabels: Record<CloudServiceStatus['readiness'], string> = {
  checking: 'GitHub接続を確認中', ready: 'GitHub接続済み', 'gh-unavailable': 'GitHub CLIを利用できません',
  'github-unavailable': 'GitHub認証・接続を確認できません', 'workflow-unavailable': 'テスト用ワークフローが利用できません',
}
