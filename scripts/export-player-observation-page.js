/** Run in DevTools on the ordinary Buckler league ranking page, then save in .local/. */
(() => {
  const url = new URL(location.href)
  const expectedParameters = {
    league_rank: '0', character_filter: '2', platform: '1', user_status: '1',
    home_filter: '1', home_category_id: '0', home_id: '0',
  }
  if (url.protocol !== 'https:' || url.hostname !== 'www.streetfighter.com'
    || url.pathname !== '/6/buckler/ja-jp/ranking/league' || url.username || url.password || url.hash
    || [...url.searchParams.keys()].some(key => ![...Object.keys(expectedParameters), 'character_id', 'page'].includes(key))
    || Object.entries(expectedParameters).some(([key, value]) => url.searchParams.get(key) !== value)) {
    throw new Error('総合・最大LP・全地域・全プラットフォームを適用したランキングページで実行してください。')
  }
  const pageText = url.searchParams.get('page')
  if (!pageText || !/^[1-9]\d*$/.test(pageText) || !Number.isSafeInteger(Number(pageText))) {
    throw new Error('表示中のページ番号を確認できません。')
  }
  const page = Number(pageText)
  const visible = element => element.getBoundingClientRect().width > 0
    && element.getBoundingClientRect().height > 0
  const selects = [...document.querySelectorAll('select')].filter(visible)
  if (selects.length < 5 || selects.slice(0, 4).map(select => select.value).join(',') !== '0,2,0,1'
    || selects.slice(4).some(select => Number(select.value) !== page)) {
    throw new Error('選択欄と実際のページが一致しません。フィルターやページ移動の完了を確認してください。')
  }
  const counters = [...new Set([...document.querySelectorAll('p')].filter(visible)
    .map(element => element.innerText.trim()).filter(text => /^\d+\s*-\s*\d+\s*\/\s*\d+$/.test(text)))]
  if (counters.length !== 1) throw new Error('ランキングの表示範囲を一意に確認できません。')
  const match = counters[0].match(/^(\d+)\s*-\s*(\d+)\s*\/\s*(\d+)$/)
  const range = { from: Number(match[1]), to: Number(match[2]), total: Number(match[3]) }
  const lists = [...document.querySelectorAll('ul[class*="ranking_ranking_list"]:not([class*="ranking__my__list"])')].filter(visible)
  const rows = lists.flatMap(list => [...list.querySelectorAll('a[href*="/profile/"]')].map(link => {
    const cfnId = link.getAttribute('href')?.match(/\/profile\/(\d+)$/)?.[1]
    const rankText = link.querySelector('dt')?.innerText.trim().match(/^(\d+)位$/)
    const lpText = link.querySelector('dd')?.innerText.trim().match(/^(\d+)LP$/)
    if (!cfnId || !rankText || !lpText) throw new Error('ランキング行のID・順位・LPを確認できません。')
    return { cfnId, rank: Number(rankText[1]), lp: Number(lpText[1]) }
  }))
  if (range.from !== (page - 1) * 20 + 1 || range.to !== Math.min(page * 20, range.total)
    || range.to < range.from || rows.length !== range.to - range.from + 1
    || new Set(rows.map(row => row.cfnId)).size !== rows.length
    || rows.some(row => !Number.isSafeInteger(row.lp) || !Number.isSafeInteger(row.rank) || row.rank < 1)) {
    throw new Error('ページ位置・行数・重複の検証に失敗しました。取得記録は作成しません。')
  }
  const capture = {
    page, capturedAt: new Date().toISOString(), url: url.toString(),
    conditions: { league: 'all', character: 'max-lp', region: 'all', platform: 'all', users: 'all' },
    range, rows,
  }
  const blob = new Blob([JSON.stringify({ schemaVersion: 1, capture }, null, 2) + '\n'], { type: 'application/json' })
  const downloadUrl = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = downloadUrl
  link.download = 'player-observation-page-' + page + '-' + capture.capturedAt.replace(/[:.]/g, '-') + '.json'
  link.click()
  setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000)
  console.info('ランキング本体の取得記録を保存しました。初観測数・新規参入人数はまだ算出していません。')
})()
