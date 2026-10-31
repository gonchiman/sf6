type Props = {
  value: string
  onChange: (text: string) => void
  error: string | null
  errorId: string
}

export function ParallelFetchIntervalInput({ value, onChange, error, errorId }: Props) {
  return <label><span>取得開始間隔（秒・カンマ区切り）</span>
    <input type="text" aria-label="取得開始間隔" value={value} onChange={event => onChange(event.target.value)}
      autoComplete="off" spellCheck={false} maxLength={128} aria-invalid={!!error} aria-describedby={error ? errorId : undefined} />
  </label>
}
