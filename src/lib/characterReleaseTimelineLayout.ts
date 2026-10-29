import { chartTextWidth } from './chartTextWidth.ts'
import type { CharacterReleaseTimelineDirection, CharacterReleaseTimelineEvent } from '../types/characterReleaseTimeline.ts'

type Anchor = 'start' | 'middle' | 'end'
type Line = { x1: number; y1: number; x2: number; y2: number }

export interface CharacterReleaseTimelineLayoutEntry {
  event: CharacterReleaseTimelineEvent
  x: number
  y: number
  labelX: number
  /** Baseline of the first name line; the date baseline is 18px above this. */
  labelY: number
  anchor: Anchor
  labelWidth: number
  dateLabel: string
  /** Name baselines are spaced 16px apart. */
  labelLines: string[]
  connector: Line
}

export interface CharacterReleaseTimelineLayout {
  width: number
  height: number
  axis: Line
  ticks: { key: string; label: string; x: number; y: number; anchor: Anchor }[]
  entries: CharacterReleaseTimelineLayoutEntry[]
  dateRange: { start: string; end: string } | null
}

type Label = { event: CharacterReleaseTimelineEvent; dateLabel: string; labelLines: string[]; width: number; height: number }
type Tick = { key: string; label: string; day: number }
type Interval = { left: number; right: number }
type Lane = { height: number; intervals: Interval[] }
type VerticalGroup = { day: number; items: { index: number; label: Label }[]; height: number }

const DAY_MS = 86_400_000
const PADDING = 16
const NAME_LINE_HEIGHT = 16
const LABEL_GAP = 16
const VERTICAL_LABEL_GAP = 26
const AXIS_TITLE_SPACE = 30

function wrapName(text: string, width: number): string[] {
  const lines: string[] = []
  for (const paragraph of text.split('\n')) {
    let line = ''
    for (const character of Array.from(paragraph)) {
      if (line && chartTextWidth(line + character) > width) {
        lines.push(line.trimEnd())
        line = ''
      }
      if (line || character.trim()) line += character
    }
    if (line) lines.push(line.trimEnd())
  }
  return lines.length > 0 ? lines : ['—']
}

function prepareLabel(event: CharacterReleaseTimelineEvent, maximumWidth: number): Label {
  const dateLabel = `${event.date.replaceAll('-', '/')}${event.status === 'scheduled' ? '（予定）' : ''}`
  const labelLines = wrapName(event.label, maximumWidth)
  return {
    event, dateLabel, labelLines,
    width: Math.max(chartTextWidth(dateLabel), ...labelLines.map(chartTextWidth)),
    height: 34 + (labelLines.length - 1) * NAME_LINE_HEIGHT,
  }
}

/** Domain endpoints are the filtered events, rather than complete calendar years. */
function fraction(day: number, start: number, end: number): number {
  return start === end ? .5 : (day - start) / (end - start)
}

function dateTicks(start: number, end: number): Tick[] {
  const first = new Date(start * DAY_MS)
  const last = new Date(end * DAY_MS)
  const ticks: Tick[] = []
  const annual = end - start >= 366
  if (annual) {
    for (let year = first.getUTCFullYear(); year <= last.getUTCFullYear(); year++) {
      const day = Date.UTC(year, 0, 1) / DAY_MS
      if (day >= start && day <= end) ticks.push({ key: `${year}-01-01`, label: String(year), day })
    }
  } else {
    const lastMonth = last.getUTCFullYear() * 12 + last.getUTCMonth()
    for (let month = first.getUTCFullYear() * 12 + first.getUTCMonth(); month <= lastMonth; month++) {
      const year = Math.floor(month / 12)
      const monthNumber = month % 12 + 1
      const day = Date.UTC(year, monthNumber - 1, 1) / DAY_MS
      const label = `${year}/${String(monthNumber).padStart(2, '0')}`
      if (day >= start && day <= end) ticks.push({ key: `${label.replace('/', '-')}-01`, label, day })
    }
  }
  if (ticks.length === 0) {
    ticks.push({ key: first.toISOString().slice(0, 10), label: `${first.getUTCFullYear()}/${String(first.getUTCMonth() + 1).padStart(2, '0')}`, day: start })
  }
  return ticks
}

function horizontalAnchor(x: number, labelWidth: number, width: number): Anchor {
  return x - labelWidth / 2 < PADDING ? 'start'
    : x + labelWidth / 2 > width - PADDING ? 'end' : 'middle'
}

function interval(x: number, width: number, anchor: Anchor): Interval {
  const left = x - (anchor === 'end' ? width : anchor === 'middle' ? width / 2 : 0)
  return { left, right: left + width }
}

function horizontalLayout(labels: Label[], width: number, start: number, end: number): CharacterReleaseTimelineLayout {
  const x1 = 24
  const x2 = width - 24
  const lanes: [Lane[], Lane[]] = [[], []]
  const placed = labels.map((label, index) => {
    const x = x1 + fraction(label.event.day, start, end) * (x2 - x1)
    const anchor = horizontalAnchor(x, label.width, width)
    const bounds = interval(x, label.width, anchor)
    const side = index % 2
    const sideLanes = lanes[side]
    let lane = sideLanes.findIndex(candidate => candidate.intervals.every(other => bounds.left >= other.right + LABEL_GAP
      || bounds.right + LABEL_GAP <= other.left))
    if (lane < 0) {
      lane = sideLanes.length
      sideLanes.push({ height: 0, intervals: [] })
    }
    sideLanes[lane].height = Math.max(sideLanes[lane].height, label.height)
    sideLanes[lane].intervals.push(bounds)
    return { label, x, anchor, lane, side }
  })
  const extent = (side: number) => lanes[side].reduce((sum, lane) => sum + lane.height, 0)
    + Math.max(0, lanes[side].length - 1) * LABEL_GAP
  const axisY = PADDING + Math.max(84, 28 + extent(0))
  const height = axisY + Math.max(84, 20 + extent(1)) + PADDING + AXIS_TITLE_SPACE
  const entries = placed.map(({ label, x, anchor, lane, side }): CharacterReleaseTimelineLayoutEntry => {
    const offset = lanes[side].slice(0, lane).reduce((sum, item) => sum + item.height + LABEL_GAP, 0)
    const labelY = side === 0 ? axisY - 32 - offset - (label.labelLines.length - 1) * NAME_LINE_HEIGHT : axisY + 50 + offset
    return {
      event: label.event, x, y: axisY, labelX: x, labelY, anchor,
      labelWidth: label.width, dateLabel: label.dateLabel, labelLines: label.labelLines,
      connector: { x1: x, y1: axisY, x2: x, y2: side === 0 ? axisY - 24 - offset : axisY + 16 + offset },
    }
  })
  const ticks: CharacterReleaseTimelineLayout['ticks'] = []
  let previousRight = -Infinity
  for (const tick of dateTicks(start, end)) {
    const x = x1 + fraction(tick.day, start, end) * (x2 - x1)
    const textWidth = chartTextWidth(tick.label)
    const anchor = horizontalAnchor(x, textWidth, width)
    const bounds = interval(x, textWidth, anchor)
    if (bounds.left < previousRight + 12) continue
    ticks.push({ key: tick.key, label: tick.label, x, y: axisY + 16, anchor })
    previousRight = bounds.right
  }
  return { width, height, axis: { x1, y1: axisY, x2, y2: axisY }, entries, ticks, dateRange: null }
}

function verticalLayout(labels: Label[], width: number, start: number, end: number): CharacterReleaseTimelineLayout {
  const axisX = width / 2
  const sides: [VerticalGroup[], VerticalGroup[]] = [[], []]
  for (const [index, label] of labels.entries()) {
    const groups = sides[index % 2]
    let group = groups.at(-1)
    if (!group || group.day !== label.event.day) {
      group = { day: label.event.day, items: [], height: 0 }
      groups.push(group)
    }
    if (group.items.length > 0) group.height += LABEL_GAP
    group.items.push({ index, label })
    group.height += label.height
  }

  let axisLength = start === end ? 160 : 600
  for (const groups of sides) {
    for (let index = 1; index < groups.length; index++) {
      const previous = groups[index - 1]
      const current = groups[index]
      const needed = (previous.height + current.height) / 2 + LABEL_GAP
      axisLength = Math.max(axisLength, needed * (end - start) / (current.day - previous.day))
    }
  }
  const groups = sides.flat()
  const top = AXIS_TITLE_SPACE + Math.max(PADDING, PADDING - Math.min(...groups.map(group => fraction(group.day, start, end) * axisLength - group.height / 2)))
  const bottom = Math.max(PADDING, PADDING + Math.max(...groups.map(group => fraction(group.day, start, end) * axisLength + group.height / 2 - axisLength)))
  const height = top + axisLength + bottom
  const entries: CharacterReleaseTimelineLayoutEntry[] = []
  for (const [side, sideGroups] of sides.entries()) {
    for (const group of sideGroups) {
      const y = top + fraction(group.day, start, end) * axisLength
      let offset = -group.height / 2
      for (const { index, label } of group.items) {
        const labelX = axisX + (side === 0 ? -VERTICAL_LABEL_GAP : VERTICAL_LABEL_GAP)
        const labelY = y + offset + 30
        entries[index] = {
          event: label.event, x: axisX, y, labelX, labelY, anchor: side === 0 ? 'end' : 'start',
          labelWidth: label.width, dateLabel: label.dateLabel, labelLines: label.labelLines,
          connector: { x1: axisX, y1: y, x2: labelX + (side === 0 ? 8 : -8), y2: y + offset + label.height / 2 },
        }
        offset += label.height + LABEL_GAP
      }
    }
  }
  const ticks: CharacterReleaseTimelineLayout['ticks'] = []
  let previousY = -Infinity
  for (const tick of dateTicks(start, end)) {
    const y = top + fraction(tick.day, start, end) * axisLength
    if (y < previousY + 28 || entries.some(entry => Math.abs(entry.y - y) < 18)) continue
    ticks.push({ key: tick.key, label: tick.label, x: axisX, y, anchor: 'middle' })
    previousY = y
  }
  return { width, height, axis: { x1: axisX, y1: top, x2: axisX, y2: top + axisLength }, entries, ticks, dateRange: null }
}

/** Lay out one straight calendar axis; label collision handling never moves event points. */
export function buildCharacterReleaseTimelineLayout(
  events: readonly CharacterReleaseTimelineEvent[], direction: CharacterReleaseTimelineDirection, availableWidth: number,
): CharacterReleaseTimelineLayout {
  const width = Math.max(320, Number.isFinite(availableWidth) ? availableWidth : 320)
  const ordered = [...events].sort((first, second) => first.day - second.day)
  if (ordered.length === 0) {
    return { width, height: 180, axis: direction === 'horizontal'
      ? { x1: 24, y1: 90, x2: width - 24, y2: 90 }
      : { x1: width / 2, y1: 24, x2: width / 2, y2: 156 }, entries: [], ticks: [], dateRange: null }
  }
  const start = ordered[0].day
  const end = ordered.at(-1)!.day
  const maximumLabelWidth = direction === 'vertical' ? width / 2 - PADDING - VERTICAL_LABEL_GAP : Math.min(160, width - PADDING * 2)
  const labels = ordered.map(event => prepareLabel(event, maximumLabelWidth))
  const layout = direction === 'vertical' ? verticalLayout(labels, width, start, end) : horizontalLayout(labels, width, start, end)
  layout.dateRange = { start: ordered[0].date, end: ordered.at(-1)!.date }
  return layout
}
