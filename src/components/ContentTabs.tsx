import { useRef, type KeyboardEvent } from 'react'

type Props<T extends string> = {
  id: string
  label: string
  options: readonly (readonly [T, string])[]
  value: T
  onChange: (value: T) => void
  className: string
}

/** Shared tab and keyboard behavior from WinUsageCorrelationPage. */
export function ContentTabs<T extends string>({ id, label, options, value, onChange, className }: Props<T>) {
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  function navigate(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const count = options.length
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? count - 1
      : event.key === 'ArrowLeft' ? (index - 1 + count) % count
        : event.key === 'ArrowRight' ? (index + 1) % count : null
    if (next === null) return
    event.preventDefault()
    onChange(options[next][0])
    window.requestAnimationFrame(() => refs.current[next]?.focus({ preventScroll: true }))
  }
  return <div className={className} role="tablist" aria-label={label}>
    {options.map(([tab, text], index) => <button key={tab} type="button" className="win-rates-button" role="tab"
      id={`${id}-tab-${tab}`} aria-selected={value === tab} aria-controls={`${id}-panel-${tab}`} tabIndex={value === tab ? 0 : -1}
      ref={element => { refs.current[index] = element }} onClick={() => onChange(tab)} onKeyDown={event => navigate(event, index)}>
      {text}
    </button>)}
  </div>
}
