import { timestampLabel } from '../lib/dateTime'

const captureDateFormat = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', dateStyle: 'medium' })
const captureTimeFormat = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', timeStyle: 'short' })

export function DistributionCapturePeriod({ start, end }: { start: string; end: string }) {
  if (start === end) return <time dateTime={start}>{timestampLabel(start)}</time>
  const sameDate = captureDateFormat.format(new Date(start)) === captureDateFormat.format(new Date(end))
  return <><time dateTime={start}>{timestampLabel(start).replace(/ JST$/, '')}</time>
    〜<time dateTime={end}>{sameDate ? `${captureTimeFormat.format(new Date(end))} JST` : timestampLabel(end)}</time></>
}
