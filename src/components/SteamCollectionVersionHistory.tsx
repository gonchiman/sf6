import { useState } from 'react'
import { timestampLabel } from '../lib/dateTime'
import { STEAM_COLLECTION_HISTORY, STEAM_COLLECTION_VERSION } from '../lib/steamCollectionVersion'
import { CollectionHistoryDialog } from './CollectionHistoryDialog'
import '../steam-collection-version.css'

export function SteamCollectionVersionHistory() {
  const [open, setOpen] = useState(false)
  return <div className="steam-collection-version">
    <span>取得処理：<strong>実装版 {STEAM_COLLECTION_VERSION}</strong></span>
    <button type="button" className="win-rates-button" aria-haspopup="dialog" onClick={() => setOpen(true)}>変更履歴</button>
    {open && <SteamCollectionVersionDialog onClose={() => setOpen(false)} />}
  </div>
}

export function SteamCollectionVersionDialog({ onClose }: { onClose: () => void }) {
  return <CollectionHistoryDialog title="取得処理の変更履歴" onClose={onClose}
    subtitle={<span className="steam-collection-dialog-version">実装版 {STEAM_COLLECTION_VERSION}</span>}>
    <div className="data-table-scroll steam-collection-history-scroll" role="region" aria-label="取得処理の変更履歴" tabIndex={0}>
      <table className="data-table steam-collection-history-table">
        <caption className="win-rates-visually-hidden">取得処理の版・コミット日時・変更内容</caption>
        <thead><tr><th scope="col">版</th><th scope="col">コミット日時（JST）</th><th scope="col">変更内容</th></tr></thead>
        <tbody>{STEAM_COLLECTION_HISTORY.flatMap(release => [...release.changes].reverse().map(change =>
          <tr key={change.commitSha}>
            <th scope="row">{release.version}{release.retrospective && <span className="steam-collection-history-retrospective">後付けの版名</span>}</th>
            <td><time dateTime={change.committedAt}>{timestampLabel(change.committedAt).replace(/ JST$/, '')}</time></td>
            <td><span>{change.summary}</span><a className="steam-collection-history-commit"
              href={`https://github.com/gonchiman/sf6/commit/${change.commitSha}`} target="_blank" rel="noreferrer">
              {change.commitSha.slice(0, 7)}<span className="win-rates-visually-hidden"> の変更内容（新しいタブ）</span>
            </a></td>
          </tr>))}</tbody>
      </table>
    </div>
  </CollectionHistoryDialog>
}
