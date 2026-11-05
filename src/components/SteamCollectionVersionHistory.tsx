import { useEffect, useId, useRef, useState, type MouseEvent } from 'react'
import { timestampLabel } from '../lib/dateTime'
import { STEAM_COLLECTION_HISTORY, STEAM_COLLECTION_VERSION } from '../lib/steamCollectionVersion'
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
  const titleId = useId()
  const dialogRef = useRef<HTMLDialogElement>(null)
  const titleRef = useRef<HTMLHeadingElement>(null)
  const backdropPointerDown = useRef(false)

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const previousOverflow = document.body.style.overflow
    dialog.showModal()
    document.body.style.overflow = 'hidden'
    titleRef.current?.focus({ preventScroll: true })
    return () => {
      document.body.style.overflow = previousOverflow
      if (dialog.open) dialog.close()
      if (opener?.isConnected) opener.focus({ preventScroll: true })
    }
  }, [])

  const isBackdrop = (event: MouseEvent<HTMLDialogElement>) => {
    if (event.target !== event.currentTarget) return false
    const bounds = event.currentTarget.getBoundingClientRect()
    return event.clientX < bounds.left || event.clientX > bounds.right
      || event.clientY < bounds.top || event.clientY > bounds.bottom
  }

  return <dialog ref={dialogRef} className="steam-collection-dialog" aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); onClose() }}
    onPointerDown={event => { backdropPointerDown.current = isBackdrop(event) }}
    onClick={event => {
      const dismiss = backdropPointerDown.current && isBackdrop(event)
      backdropPointerDown.current = false
      if (dismiss) onClose()
    }}>
    <header className="steam-collection-dialog-header">
      <div>
        <h2 ref={titleRef} id={titleId} tabIndex={-1}>取得処理の変更履歴</h2>
        <span className="steam-collection-dialog-version">実装版 {STEAM_COLLECTION_VERSION}</span>
      </div>
      <button type="button" className="win-rates-button" onClick={onClose}>閉じる</button>
    </header>
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
  </dialog>
}
