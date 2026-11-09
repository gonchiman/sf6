import { useEffect, useId, useRef, type MouseEvent, type ReactNode } from 'react'
import '../collection-history-dialog.css'

export function CollectionHistoryDialog({ title, subtitle, className, onClose, children }: {
  title: string
  subtitle?: ReactNode
  className?: string
  onClose: () => void
  children: ReactNode
}) {
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

  return <dialog ref={dialogRef} className={className ? `collection-history-dialog ${className}` : 'collection-history-dialog'}
    aria-labelledby={titleId} onCancel={event => { event.preventDefault(); onClose() }}
    onPointerDown={event => { backdropPointerDown.current = isBackdrop(event) }}
    onClick={event => {
      const dismiss = backdropPointerDown.current && isBackdrop(event)
      backdropPointerDown.current = false
      if (dismiss) onClose()
    }}>
    <header className="collection-history-dialog-header">
      <div>
        <h2 ref={titleRef} id={titleId} tabIndex={-1}>{title}</h2>
        {subtitle}
      </div>
      <button type="button" className="win-rates-button" onClick={onClose}>閉じる</button>
    </header>
    {children}
  </dialog>
}
