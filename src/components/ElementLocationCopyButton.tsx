import { useLayoutEffect, useRef, useState } from 'react'
import './ElementLocationCopyButton.css'

export function ElementLocationCopyButton({ segments }: { segments: readonly string[] }) {
  const location = segments.join(' / ')
  const [copying, setCopying] = useState(false)
  const [result, setResult] = useState<'copied' | 'failed' | null>(null)
  const pending = useRef(false)
  const revision = useRef(0)

  useLayoutEffect(() => {
    setResult(null)
    return () => { revision.current++ }
  }, [location])

  async function copyLocation() {
    if (pending.current || !location) return
    const locationRevision = revision.current
    pending.current = true
    setCopying(true)
    setResult(null)
    try {
      await navigator.clipboard.writeText(`〈${location}〉`)
      if (revision.current === locationRevision) setResult('copied')
    } catch {
      if (revision.current === locationRevision) setResult('failed')
    } finally {
      pending.current = false
      setCopying(false)
    }
  }

  return <>
    <button type="button" className="output-icon-button element-location-copy-button"
      aria-label={location ? `${location}の場所をコピー` : '場所をコピー'}
      aria-busy={copying} aria-disabled={copying || !location} disabled={!location}
      data-copy-state={copying ? 'copying' : result ?? 'idle'} onClick={() => void copyLocation()}>
      <span className="output-icon-face" aria-hidden="true">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" focusable="false">
          {result === 'copied' ? <path d="m5 12 4 4L19 6" />
            : result === 'failed' ? <path d="M12 3 2 21h20L12 3Zm0 6v5m0 3h.01" />
            : <><rect x="8" y="8" width="12" height="12" rx="1.5" /><path d="M16 8V4H4v12h4" /></>}
        </svg>
      </span>
    </button>
    <span className="win-rates-visually-hidden" role="status" aria-live="polite">
      {result === 'copied' && `${location}の場所をコピーしました。`}
      {result === 'failed' && `${location}の場所をコピーできませんでした。`}
    </span>
  </>
}
