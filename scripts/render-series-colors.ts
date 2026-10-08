import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { parseCharacterManifest } from '../src/lib/characters.ts'
import { parseWinRateDataset, parseWinRateManifest } from '../src/lib/winRates.ts'
import {
  CHARACTER_SERIES_ALIASES,
  CHARACTER_SERIES_STYLES,
  UNKNOWN_CHARACTER_SERIES_STYLE,
  characterSeriesStyle,
  type CharacterSeriesStyle,
} from '../src/lib/seriesColors.ts'

const project = new URL('../', import.meta.url)
const output = new URL('docs/series-colors/examples/characters.svg', project)
const args = process.argv.slice(2)
assert(args.length === 0 || (args.length === 1 && args[0] === '--check'), 'Use no arguments or --check.')

async function json(path: string): Promise<unknown> {
  return JSON.parse(await readFile(new URL(path, project), 'utf8'))
}

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
  })[character]!)
}

function contrastOnWhite(color: string): number {
  assert.match(color, /^#[0-9a-f]{6}$/i)
  const channels = [1, 3, 5].map((start) => {
    const channel = Number.parseInt(color.slice(start, start + 2), 16) / 255
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  })
  const luminance = channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
  return 1.05 / (luminance + 0.05)
}

const characters = parseCharacterManifest(await json('public/data/characters/index.json')).characters
const manifest = parseWinRateManifest(await json('public/data/win-rates/index.json'))
const winRateIds = new Set<string>()
for (const descriptor of manifest.datasets) {
  const dataset = parseWinRateDataset(await json(`public/data/win-rates/${descriptor.path}`), descriptor)
  for (const fighter of dataset.fighters) winRateIds.add(fighter.characterId)
}

const definitions = Object.entries(CHARACTER_SERIES_STYLES)
assert.deepEqual([...winRateIds].sort(), definitions.map(([id]) => id).sort(), 'Win-rate IDs and styles must cover the same characters.')
const rosterStyles = characters.map(({ id }) => characterSeriesStyle(id))
assert.equal(new Set(rosterStyles).size, definitions.length, 'Each roster character must have its own defined style.')
for (const { id } of characters) {
  assert.notEqual(characterSeriesStyle(id), UNKNOWN_CHARACTER_SERIES_STYLE, `Missing roster character: ${id}`)
}
for (const [alias, canonicalId] of Object.entries(CHARACTER_SERIES_ALIASES)) {
  assert.equal(characterSeriesStyle(alias), characterSeriesStyle(canonicalId), `Alias mismatch: ${alias}`)
}
const signatures = definitions.map(([, value]) => JSON.stringify(value))
assert.equal(new Set(signatures).size, definitions.length, 'Known characters must have distinct styles.')
assert(!signatures.includes(JSON.stringify(UNKNOWN_CHARACTER_SERIES_STYLE)), 'Unknown style must remain separate.')
for (const [id, value] of [...definitions, ['unknown', UNKNOWN_CHARACTER_SERIES_STYLE]] as [string, CharacterSeriesStyle][]) {
  assert(contrastOnWhite(value.color) >= 3, `Insufficient line/marker contrast on white: ${id}`)
  assert(Object.isFrozen(value), `Style must not be mutable: ${id}`)
}
for (const unknown of ['unknown', '', 'toString', '__proto__', 'RYU']) {
  assert.equal(characterSeriesStyle(unknown), UNKNOWN_CHARACTER_SERIES_STYLE)
}
// Lookup must not depend on display order or previous calls.
for (const [id, value] of definitions.toReversed()) assert.equal(characterSeriesStyle(id), value)

function marker(style: CharacterSeriesStyle, x: number, y: number): string {
  const common = `fill="${style.color}" stroke="#ffffff" stroke-width="1.2"`
  switch (style.marker) {
    case 'circle': return `<circle cx="${x}" cy="${y}" r="5.5" ${common}/>`
    case 'square': return `<rect x="${x - 5}" y="${y - 5}" width="10" height="10" ${common}/>`
    case 'triangle': return `<path d="M${x} ${y - 6.5} L${x + 6} ${y + 5} L${x - 6} ${y + 5} Z" ${common}/>`
    case 'diamond': return `<path d="M${x} ${y - 7} L${x + 6} ${y} L${x} ${y + 7} L${x - 6} ${y} Z" ${common}/>`
  }
}

const rows = [
  ...characters.map(({ id, name }) => ({ id, name, style: characterSeriesStyle(id) })),
  { id: 'unknown', name: '未登録のキャラクター', style: UNKNOWN_CHARACTER_SERIES_STYLE },
]
const rowsPerColumn = Math.ceil(rows.length / 2)
const height = 156 + rowsPerColumn * 62
const blocks = rows.map(({ id, name, style }, index) => {
  const column = Math.floor(index / rowsPerColumn)
  const x = 32 + column * 544
  const y = 126 + index % rowsPerColumn * 62
  const dash = style.dashArray ? ` stroke-dasharray="${style.dashArray}"` : ''
  const alias = Object.hasOwn(CHARACTER_SERIES_ALIASES, id)
    ? ` / ${CHARACTER_SERIES_ALIASES[id as keyof typeof CHARACTER_SERIES_ALIASES]}` : ''
  return `  <g>
    <title>${escapeXml(`${name}: ${id}${alias}, ${style.color}, ${style.dashArray ?? 'solid'}, ${style.marker}`)}</title>
    <line x1="${x}" y1="${y + 4}" x2="${x + 86}" y2="${y + 4}" stroke="${style.color}" stroke-width="2.5"${dash}/>
    ${marker(style, x + 43, y + 4)}
    <text x="${x + 110}" y="${y}" class="name">${escapeXml(name)}</text>
    <text x="${x + 110}" y="${y + 23}" class="id">${escapeXml(id + alias)}</text>
    <text x="${x + 490}" y="${y}" class="color">${style.color}</text>
    <line x1="${x}" y1="${y + 42}" x2="${x + 500}" y2="${y + 42}" stroke="#e5e7eb"/>
  </g>`
}).join('\n')

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1120" height="${height}" viewBox="0 0 1120 ${height}" role="img" aria-labelledby="title description">
  <title id="title">SF6 キャラクター別の固定配色・線種・記号</title>
  <desc id="description">共通定義 characterSeriesStyle から生成した${characters.length}キャラクターと未登録IDの見本。線の色、破線パターン、点の形を組み合わせ、名前とともに表示する。</desc>
  <style>
    text { font-family: "Yu Gothic", "Meiryo", sans-serif; fill: #24292f; }
    .name { font-size: 17px; font-weight: 600; }
    .id { font-family: Consolas, monospace; font-size: 12px; fill: #57606a; }
    .color { font-family: Consolas, monospace; font-size: 13px; fill: #57606a; text-anchor: end; }
  </style>
  <rect width="1120" height="${height}" fill="#ffffff"/>
  <text x="32" y="45" font-size="27" font-weight="700">キャラクター別の固定配色・線種・記号</text>
  <text x="32" y="76" font-size="14" fill="#57606a">src/lib/seriesColors.ts から生成 · ラベルと併用する</text>
${blocks}
  <text x="32" y="${height - 18}" font-size="12" fill="#57606a">再生成: node scripts/render-series-colors.ts</text>
</svg>
`

if (args[0] === '--check') {
  assert.equal(await readFile(output, 'utf8'), svg, 'Regenerate the series-color example.')
  console.log(`Series colors verified: ${characters.length} characters, ${manifest.datasets.length} datasets, SVG in sync.`)
} else {
  await mkdir(new URL('./', output), { recursive: true })
  await writeFile(output, svg)
  console.log(`Rendered ${fileURLToPath(output)} (${characters.length} characters).`)
}
