export function timestampLabel(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : `${new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo', dateStyle: 'medium', timeStyle: 'short',
  }).format(date)} JST`
}
