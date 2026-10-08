// Run in DevTools on the official Japanese frame-data page, after choosing
// CLASSIC or MODERN. Save the printed JSON; this script does not change the page.
(() => {
  const url = new URL(location.href)
  const match = /^\/6\/ja-jp\/character\/([^/]+)\/frame$/.exec(url.pathname)
  if (!match || url.hostname !== 'www.streetfighter.com') throw new Error('公式の日本語フレームデータを開いてください。')
  const id = match[1]
  const selectedIcon = document.querySelector('[class*="movelist_tabs"] li[class*="active"] img')?.getAttribute('src')
  const controlType = selectedIcon?.endsWith('/logo-modern.png') ? 'modern'
    : selectedIcon?.endsWith('/logo-classic.png') ? 'classic' : null
  if (!controlType) throw new Error('選択中の操作タイプを確認できません。')
  const confirmedEnglishNames = { ed: 'ED', gouki_akuma: 'AKUMA', vega_mbison: 'M. BISON', terry: 'TERRY' }
  const englishName = document.querySelector('h1 desc')?.textContent?.trim() || confirmedEnglishNames[id]
  if (!englishName) throw new Error('公式の英語名を確認してください。')
  const tokens = (element) => element ? Array.from(element.childNodes).flatMap(function walk(node) {
    if (node.nodeType === 3) return node.textContent.trim() ? [node.textContent.trim()] : []
    if (node.nodeType !== 1) return []
    if (node.tagName === 'IMG') return ['@' + node.getAttribute('src').split('/').pop()]
    return Array.from(node.childNodes).flatMap(walk)
  }) : []
  const rows = Array.from(document.querySelectorAll('#framearea table tr')).map((row) => {
    const cells = Array.from(row.querySelectorAll('th,td'))
    const nameCell = cells[0]
    return {
      cells: cells.map((cell) => cell.innerText.trim()),
      name: nameCell?.querySelector('span')?.textContent.trim() ?? null,
      classicInputTokens: tokens(nameCell?.querySelector('p[class*="classic"]')),
      modernInputTokens: tokens(nameCell?.querySelector('p[class*="modern"]')),
    }
  })
  if (!rows.some((row) => row.cells.length === 15)) throw new Error('フレーム表がありません。')
  const snapshot = {
    id, controlType, url: `${url.origin}${url.pathname}`, title: document.title,
    healthText: document.body.innerText.match(/体力\s*\d+/)?.[0] ?? '',
    englishName, capturedAt: new Date().toISOString(), rows,
  }
  console.log(JSON.stringify(snapshot, null, 2))
  return snapshot
})()
