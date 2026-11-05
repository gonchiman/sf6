// Shared by the browser and collection CLI. Keep this module free of Node APIs.
// Update the history and docs/steam-player-count/CHANGELOG.md when collection behavior changes.
export const STEAM_COLLECTION_VERSION = 'v2'

export interface SteamCollectionChange {
  readonly committedAt: string
  readonly summary: string
  readonly commitSha: string
}

export interface SteamCollectionRelease {
  readonly version: string
  readonly retrospective: boolean
  readonly changes: readonly SteamCollectionChange[]
}

// Dates are implementation commit dates (JST), not deployment or run start dates.
// Versions before v2 were assigned retrospectively on 2026-11-05.
export const STEAM_COLLECTION_HISTORY: readonly SteamCollectionRelease[] = [
  {
    version: 'v2', retrospective: false,
    changes: [
      {
        committedAt: '2026-11-05T18:42:49+09:00',
        summary: 'スキップ前の状態再確認と詳細ログを追加',
        commitSha: 'c07e354099fb67a730ac2090132d4263a93ee8ef',
      },
      {
        committedAt: '2026-11-05T19:28:01+09:00',
        summary: '処理版の共通定義と実行時の版記録を追加',
        commitSha: '95a35bf6730b401c873fa8242eae8e06bf5b17c5',
      },
    ],
  },
  {
    version: 'v1', retrospective: true,
    changes: [{
      committedAt: '2026-11-02T17:31:21+09:00',
      summary: '後続の起動役を予約・確認して引き継ぐ',
      commitSha: '528819d55051361b998f4e9621ccafbc487ca459',
    }],
  },
  {
    version: 'v0.3', retrospective: true,
    changes: [{
      committedAt: '2026-11-02T13:32:22+09:00',
      summary: '対象を5ゲームに拡張し、成功したゲームを個別に保存',
      commitSha: '6fe802d2050bbfcbf901104b5775f57361f1b80f',
    }],
  },
  {
    version: 'v0.2', retrospective: true,
    changes: [{
      committedAt: '2026-11-01T12:32:43+09:00',
      summary: '起動役のタイマーで15分間隔に変更',
      commitSha: 'dd50d5672e483747c88a1e8d7cf258b1e7b33fd8',
    }],
  },
  {
    version: 'v0.1', retrospective: true,
    changes: [{
      committedAt: '2026-10-31T19:33:09+09:00',
      summary: 'SF6の取得・検証・履歴保存を追加。15分cronで起動',
      commitSha: '14b0e36eafffa80adf2c0fabcdca6c07705354e8',
    }],
  },
]
