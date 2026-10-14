import { createHash } from 'node:crypto'
import { parseBalanceAdjustmentDetails } from '../../src/lib/balanceAdjustmentDetails.ts'
import type { BalanceAdjustmentChange, BalanceAdjustmentDetailsCatalog } from '../../src/types/balanceAdjustmentDetails.ts'
import type { CharacterManifest } from '../../src/types/characters.ts'
import type { BalanceAdjustmentCatalog } from '../../src/types/balanceAdjustments.ts'
import { decodeCharacterInput } from './character-snapshot.ts'

/** An offline record of the official all-character page; HTML is parsed as data. */
export interface BalanceAdjustmentSnapshot { url: string; capturedAt: string; html: string }

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`公式調整取得記録が不正です: ${field}`)
  return value as Record<string, unknown>
}

function text(value: unknown, field: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim())) throw new Error(`公式調整取得記録の文字列が不正です: ${field}`)
  return value
}

function array(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`公式調整取得記録の配列が不正です: ${field}`)
  return value
}

function entities(value: string): string {
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' }
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (_, entity: string) => {
    if (entity.startsWith('#')) {
      const code = /^#x/i.test(entity) ? parseInt(entity.slice(2), 16) : Number(entity.slice(1))
      if (code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)) return String.fromCodePoint(code)
    } else if (named[entity]) return named[entity]
    throw new Error(`未対応のHTML文字参照があります: ${entity}`)
  })
}

/** Preserve line breaks, command symbols and inline terms without importing HTML. */
export function balanceAdjustmentHtmlText(value: string): string {
  let result = ''
  const lists: { ordered: boolean; next: number }[] = []
  const spans: { marker: string; block: boolean }[] = []
  const links: string[] = []
  const newline = () => { if (result && !result.endsWith('\n')) result += '\n' }
  const attributes = (tag: string) => new Map([...tag.matchAll(/([a-z-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)]
    .map((match) => [match[1].toLowerCase(), match[2] ?? match[3]]))
  for (const part of value.split(/(<[^>]*>)/g)) {
    if (!part.startsWith('<')) { result += part; continue }
    const tag = part
    if (/^<br\s*\/?\s*>$/i.test(tag)) { result += '\n'; continue }
    if (/^<\/?div\b[^>]*>$/i.test(tag)) continue // Official inline glossary term.
    if (/^<span\b/i.test(tag)) {
      const attrs = attributes(tag)
      const marker = attrs.get('class')?.split(/\s+/).includes('battle_change_through') ? '取消線'
        : attrs.get('class')?.split(/\s+/).includes('battle_change_caution') || /font-weight\s*:\s*bold/i.test(attrs.get('style') ?? '') ? '強調' : ''
      const block = /display\s*:\s*block/i.test(attrs.get('style') ?? '')
      spans.push({ marker, block })
      if (block) newline()
      if (marker) result += `【${marker}】`
      continue
    }
    if (/^<\/span\s*>$/i.test(tag)) {
      const span = spans.pop()
      if (span?.marker) result += `【/${span.marker}】`
      if (span?.block) newline()
      continue
    }
    if (/^<(?:ul|ol)\b/i.test(tag)) {
      newline()
      lists.push({ ordered: /^<ol\b/i.test(tag) || /list-style\s*:\s*decimal/i.test(attributes(tag).get('style') ?? ''), next: 0 })
      continue
    }
    if (/^<\/(?:ul|ol)\s*>$/i.test(tag)) { lists.pop(); newline(); continue }
    if (/^<li\b/i.test(tag)) {
      newline()
      const list = lists.at(-1)
      if (!list) throw new Error('調整本文の箇条書きの種類を確認できません。')
      list.next += 1
      result += list.ordered ? `${list.next}. ` : '・'
      continue
    }
    if (/^<\/(?:li|p)\s*>$/i.test(tag) || /^<p\b/i.test(tag)) { newline(); continue }
    if (/^<a\b/i.test(tag)) {
      const href = attributes(tag).get('href')
      if (!href) throw new Error('調整本文のリンク先を確認できません。')
      const url = new URL(entities(href), 'https://www.streetfighter.com/6/buckler/ja-jp/battle_change/')
      if (url.protocol !== 'https:' || url.username || url.password) throw new Error('調整本文のリンク先が不正です。')
      links.push(url.href)
      continue
    }
    if (/^<\/a\s*>$/i.test(tag)) { const url = links.pop(); if (url) result += `（${url}）`; continue }
    if (/^<\/?(?:strong|em|b|i)\b[^>]*>$/i.test(tag)) continue
    if (/^<img\b/i.test(tag)) {
      const attrs = attributes(tag)
      const alt = attrs.get('alt')
      if (alt?.trim()) { result += alt; continue }
      const filename = attrs.get('src')?.split('/').pop()
      if (filename) {
        const decoded = decodeCharacterInput([`@${filename}`])
        if (!decoded.startsWith('［')) { result += decoded; continue }
      }
      throw new Error('代替表記を確認できないコマンド画像があります。')
    }
    throw new Error(`未対応の調整本文HTMLがあります: ${tag}`)
  }
  return entities(result).replaceAll('\r\n', '\n').trim()
}

function changes(value: unknown, owner: string, translations: Record<string, unknown>): BalanceAdjustmentChange[] {
  const seen = new Map<string, number>()
  return array(value, `${owner}.detail`).flatMap((entry, index) => {
    const detail = record(entry, `${owner}.detail[${index}]`)
    const target = balanceAdjustmentHtmlText(text(detail.title, `${owner}.target`, true))
    const body = array(detail.body, `${owner}.body`)
    if (!body.length) throw new Error(`空の調整本文があります: ${owner} / ${target}`)
    return body.map((entry) => {
      const item = record(entry, `${owner}.body`)
      const category = text(item.category, `${owner}.category`, true)
      const categoryMatch = /^(調整|不具合修正|調整・不具合修正|共通調整)([23])?$/.exec(category)
      if (category !== '' && !categoryMatch) throw new Error(`未対応の公式分類があります: ${category}`)
      let categoryLabel = category
      if (categoryMatch?.[2]) {
        const marker = categoryMatch[2] === '2' ? '取消線' : '強調'
        const translated = text(translations[`[t]${category}`], `category translation: ${category}`)
        if (balanceAdjustmentHtmlText(translated) !== `【${marker}】${categoryMatch[1]}【/${marker}】`) {
          throw new Error(`公式分類の表示を確認できません: ${category}`)
        }
        categoryLabel = `${categoryMatch[1]}（${marker}）`
      }
      const description = balanceAdjustmentHtmlText(text(item.text, `${owner}.text`))
      const hash = createHash('sha256').update(JSON.stringify([target, categoryLabel, description])).digest('hex').slice(0, 20)
      const occurrence = (seen.get(hash) ?? 0) + 1
      seen.set(hash, occurrence)
      return { id: `${owner}-${hash}${occurrence > 1 ? `-${occurrence}` : ''}`, target, categoryLabel, description }
    })
  })
}

export function balanceAdjustmentDetailsFromSnapshot(
  value: unknown, manifest: CharacterManifest, generatedAt = new Date().toISOString(),
  history?: BalanceAdjustmentCatalog,
): BalanceAdjustmentDetailsCatalog {
  const snapshot = record(value, 'snapshot')
  const url = text(snapshot.url, 'url')
  const capturedAt = text(snapshot.capturedAt, 'capturedAt')
  const html = text(snapshot.html, 'html')
  const match = /^https:\/\/www\.streetfighter\.com\/6\/buckler\/ja-jp\/battle_change\/(\d{6}(?:\d{2})?)$/.exec(url)
  if (!match) throw new Error('公式日本語の全キャラ調整ページを指定してください。')
  const version = match[1]
  const scripts = [...html.matchAll(/<script\b[^>]*\bid="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/g)]
  if (scripts.length !== 1) throw new Error('公式の静的ページデータを確認できません。')
  const next = record(JSON.parse(scripts[0][1]), 'NEXT_DATA')
  const props = record(record(next.props, 'props').pageProps, 'pageProps')
  const query = record(next.query, 'query')
  const common = record(props.common, 'pageProps.common')
  const adjust = record(props.adjust, 'pageProps.adjust')
  if (next.isFallback !== false || props.__lang !== 'ja-jp' || common.statusCode !== 200 || common.isError !== false
    || query.version !== version || query.character_id !== undefined || adjust.current_version !== version
    || adjust.current_fighter !== '') {
    throw new Error('取得したページの言語・日付・対象が指定と一致しません。')
  }
  const versionTitle = text(adjust.title, 'adjust.title')
  const titleDate = /^(\d{4})\.(\d{1,2})\.(\d{1,2}) update$/.exec(versionTitle)
  const titleVersion = titleDate ? `${titleDate[1]}${titleDate[2].padStart(2, '0')}${titleDate[3].padStart(2, '0')}`
    : /^(\d{6}) Ver\.$/.exec(versionTitle)?.[1]
  if (titleVersion !== version) throw new Error('公式リストのタイトルと指定バージョンが一致しません。')
  const event = history?.events.find((item) => item.source.url === url)
  if ((history && !event) || (version.length === 6 && !event)) throw new Error('公式リストに対応する履歴の日付を確認できません。')
  const date = event?.date ?? `${version.slice(0, 4)}-${version.slice(4, 6)}-${version.slice(6)}`
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/.exec(html)
  if (!titleMatch) throw new Error('公式ページのタイトルがありません。')
  const title = balanceAdjustmentHtmlText(titleMatch[1])
  const roster = array(adjust.fighter_list, 'fighter_list').map((entry) => record(entry, 'fighter_list entry'))
  const fighters = array(adjust.fighter, 'fighter').map((entry) => record(entry, 'fighter entry'))
  const policies = array(adjust.policy, 'policy').map((entry) => record(entry, 'policy entry'))
  const policiesById = new Map<string, string[]>()
  const overallPolicies: string[] = []
  const rosterIds = new Set(roster.map((entry) => text(entry.fighter_id, 'fighter_id')))
  for (const policy of policies) {
    const title = text(policy.title, 'policy.title', true)
    const body = balanceAdjustmentHtmlText(text(policy.text, 'policy.text'))
    if (rosterIds.has(title)) {
      if (!roster.some((entry) => entry.fighter_id === title && entry.exist === true)) {
        throw new Error(`未掲載キャラに調整方針があります: ${title}`)
      }
      policiesById.set(title, [...(policiesById.get(title) ?? []), body])
    } else {
      overallPolicies.push(title && title !== '全体コンセプト' ? `${balanceAdjustmentHtmlText(title)}\n${body}` : body)
    }
  }
  const translations = props.__namespaces ? record(record(props.__namespaces, '__namespaces').adjust, '__namespaces.adjust') : {}
  const rosterBySlug = new Map(roster.map((entry) => [text(entry.fighter_url_name, 'fighter_url_name'), entry]))
  const fightersBySlug = new Map(fighters.map((entry) => [text(entry.fighter_url_name, 'fighter_url_name'), entry]))
  if (!roster.length || rosterBySlug.size !== roster.length || fightersBySlug.size !== fighters.length) {
    throw new Error('公式取得記録に重複するキャラ・方針があります。')
  }
  const expectedSlugs = new Set(manifest.characters.map(({ id }) => id === 'ehonda' ? 'honda' : id))
  for (const [slug, entry] of rosterBySlug) {
    if (typeof entry.exist !== 'boolean' || (entry.exist && !expectedSlugs.has(slug))) {
      throw new Error(`対象キャラ一覧との対応を確認できません: ${slug}`)
    }
  }
  if (fighters.length !== roster.filter((entry) => entry.exist === true).length) throw new Error('掲載キャラの詳細が不足しています。')
  const characters = manifest.characters.map((character) => {
    const slug = character.id === 'ehonda' ? 'honda' : character.id
    const entry = rosterBySlug.get(slug)
    const fighter = fightersBySlug.get(slug)
    if (!entry) throw new Error(`キャラの掲載状況を確認できません: ${character.id}`)
    if (entry.exist === false) {
      if (fighter) throw new Error(`未掲載キャラに詳細があります: ${character.id}`)
      return { characterId: character.id, name: character.name, status: 'unlisted' as const, source: null, policy: '', changes: [] }
    }
    const officialName = character.id === 'ed' ? 'エド' : character.name
    if (!fighter || fighter.fighter_id !== officialName || fighter.fighter_tool_name !== entry.fighter_tool_name) {
      throw new Error(`掲載キャラと詳細が一致しません: ${character.id}`)
    }
    const characterChanges = changes(fighter.detail, `${version}-${character.id}`, translations)
    if (!characterChanges.length) throw new Error(`掲載キャラの調整本文が空です: ${character.id}`)
    const policy = policiesById.get(text(entry.fighter_id, 'fighter_id'))?.join('\n\n') ?? ''
    const alpha = text(entry.fighter_alpha, 'fighter_alpha')
    return {
      characterId: character.id, name: character.name, status: 'ready' as const,
      source: { url: `${url}/${slug}`, title: `${alpha}-${title}` },
      policy, changes: characterChanges,
    }
  })
  const commonChanges = changes(adjust.common, `${version}-common`, translations)
  if (!commonChanges.length && !characters.some((character) => character.changes.length)) throw new Error('公式リストに調整本文がありません。')
  return parseBalanceAdjustmentDetails({
    schemaVersion: 1, generatedAt,
    patches: [{ adjustmentId: event?.id ?? `battle-change-${version}`, date, capturedAt, source: { url, title },
      common: { policy: overallPolicies.join('\n\n'), changes: commonChanges }, characters }],
  }, history, manifest)
}
