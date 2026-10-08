export function DataLoadState({ loading = false, message, onRetry }: {
  loading?: boolean
  message: string
  onRetry?: () => void
}) {
  return <div className="win-rates-load-state" role={onRetry ? 'alert' : 'status'} aria-busy={loading || undefined}>
    <p>{message}</p>
    {onRetry && <button className="win-rates-button" type="button" onClick={onRetry}>再読み込み</button>}
  </div>
}
