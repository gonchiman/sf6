// 公式の使用率ページを開き、DevToolsのConsoleに貼り付けて手動実行する。
// 総合版・マスター版をそれぞれ実行し、表示されたリンクから完全なJSONを保存する。
// scripts/normalize-usage-rate-snapshots.ts で検証・正規化後、既存の使用率 importer へ渡す。
// node scripts/normalize-usage-rate-snapshots.ts usage-rate-snapshots-general.json usage-rate-snapshots-master.json normalized.json
// node scripts/import-usage-rate-data.ts normalized.json
// Escで中止。未完了の取得結果はダウンロードしない。
void (async () => {
  const edition = 'general' // マスター版では 'master' に変更する。
  if (edition !== 'general' && edition !== 'master') throw new Error('版はgeneralまたはmasterを指定してください。')
  const isMaster = edition === 'master'
  const sourceUrl = `https://www.streetfighter.com/6/buckler/ja-jp/stats/${isMaster ? 'usagerate_master' : 'usagerate'}`
  const ranks = isMaster ? ['MASTER', 'HIGH_MASTER', 'GRAND_MASTER', 'ULTIMATE_MASTER']
    : ['ALL', 'ROOKIE', 'IRON', 'BRONZE', 'SILVER', 'GOLD', 'PLATINUM', 'DIAMOND', 'MASTER']
  const controls = isMaster ? ['all'] : ['all', 'classic', 'modern']
  const PANEL_ID = 'sf6-usage-rate-snapshot-download'
  const RUN_KEY = '__sf6UsageRateSnapshotExportRunning'
  const locationMatches = () => location.href === sourceUrl || (location.href.startsWith(`${sourceUrl}/`)
    && /^\d{4}(?:0[1-9]|1[0-2])$/.test(location.href.slice(sourceUrl.length + 1)))
  if (!locationMatches()) throw new Error(`このスクリプトは ${sourceUrl} で実行してください。`)
  if (window[RUN_KEY] || document.getElementById(PANEL_ID)) throw new Error('前の取得・保存欄を終了してから実行してください。')
  window[RUN_KEY] = true
  let cancelled = false
  const cancel = (event) => { if (event.key === 'Escape') cancelled = true }
  document.addEventListener('keydown', cancel)
  const pause = () => new Promise((done) => setTimeout(done, 350))
  function checkRunning() {
    if (cancelled) throw new Error('中止しました。部分的なJSONは保存していません。')
    if (!locationMatches()) throw new Error('対象ページから移動したため中止しました。')
  }
  const optionMonth = (option) => /^\d{4}\.(?:0[1-9]|1[0-2])$/.test(option?.textContent.trim() ?? '') ? option.textContent.trim().replace('.', '-') : null
  function monthSelect() {
    const matches = [...document.querySelectorAll('select')].filter((select) => [...select.options].some((option) => optionMonth(option)))
    if (matches.length !== 1) throw new Error('対象月の選択欄を一意に確認できません。')
    return matches[0]
  }
  const selectedMonth = () => optionMonth(monthSelect().selectedOptions[0])
  function selectedControl() {
    if (isMaster) return 'all'
    const current = [...document.querySelectorAll('li[class*="select_nav_current"]')]
      .map((element) => element.textContent.trim()).filter((text) => ['ALL', 'CLASSIC', 'MODERN'].includes(text))
    if (current.length !== 1) throw new Error('現在の操作タイプを一意に確認できません。')
    return current[0].toLowerCase()
  }
  function capture() {
    checkRunning()
    const month = selectedMonth()
    const controlType = selectedControl()
    const leagues = [...document.querySelectorAll('h2')].flatMap((heading) => {
      const league = (heading.textContent.trim() || heading.querySelector('img')?.getAttribute('alt') || '').trim().replaceAll(' ', '_')
      if (!ranks.includes(league)) return []
      const list = heading.nextElementSibling
      if (list?.tagName !== 'UL') throw new Error(`使用率リストが見つかりません: ${league}`)
      const entries = [...list.children].map((item) => {
        const name = item.querySelector('dt')?.textContent.trim()
        // dd contains a second percentage for the monthly delta. Read only the published usage span.
        const raw = item.querySelector('dd [class*="usagerate_play_rate__"]')?.textContent.trim()
        if (!name || !/^(?:0|[1-9]\d?|100)\.\d{3}%$/.test(raw ?? '')) throw new Error(`使用率が読み込み中です: ${league}/${name ?? '?'}`)
        const text = raw.slice(0, -1)
        const [whole, fraction] = text.split('.')
        const value = Number(whole) * 1000 + Number(fraction)
        if (value > 100000) throw new Error('使用率が範囲外です。')
        return { name, text }
      })
      if (!entries.length || new Set(entries.map((entry) => entry.name)).size !== entries.length) throw new Error(`空または重複した使用率リストです: ${league}`)
      const total = entries.reduce((sum, entry) => sum + Math.round(Number(entry.text) * 1000), 0)
      // Keep questionable values in the raw acquisition artifact for independent verification.
      // Do not create totalMismatch authorization here: the normalizer rejects this until verified.
      const sumDiagnostic = Math.abs(total - 100000) > entries.length * .5
        ? { observedPercentThousandths: total, reason: '通常の丸め誤差を超える掲載値合計。公式ページでの個別再確認が必要。' } : undefined
      return [{ league, entries, ...(sumDiagnostic === undefined ? {} : { sumDiagnostic }) }]
    })
    if (!month || leagues.length !== ranks.length || new Set(leagues.map((item) => item.league)).size !== ranks.length) throw new Error('掲載リーグがすべて揃っていません。')
    return { edition, month, controlType, capturedAt: new Date().toISOString(), sourceUrl, capturedPageUrl: location.href, leagues }
  }
  const fingerprint = (snapshot) => JSON.stringify(snapshot.leagues.map((league) => [league.league,
    league.entries.map((entry) => [entry.name, entry.text]).sort(([a], [b]) => a.localeCompare(b))]).sort(([a], [b]) => a.localeCompare(b)))
  async function ready(month, controlType, previousValues, requireDatedRoute = false) {
    const deadline = Date.now() + 60000
    let prior; let stable = 0; let lastError
    while (Date.now() < deadline) {
      await pause()
      checkRunning()
      try {
        const snapshot = capture()
        const values = fingerprint(snapshot)
        if (snapshot.month !== month || snapshot.controlType !== controlType
          || (requireDatedRoute && snapshot.capturedPageUrl !== `${sourceUrl}/${month.replace('-', '')}`)
          || (previousValues !== undefined && values === previousValues)) throw new Error('対象月の経路・操作タイプ・値の更新待ち')
        stable = values === prior ? stable + 1 : 1
        prior = values
        if (stable >= 3) return snapshot
      } catch (error) { stable = 0; prior = undefined; lastError = error }
    }
    throw new Error(`${month}/${controlType}の更新を確認できませんでした: ${lastError}`)
  }
  async function setControl(month, controlType) {
    if (selectedControl() === controlType) return ready(month, controlType)
    const before = fingerprint(capture())
    const choices = [...document.querySelectorAll('li[class*="select_nav_"]')].filter((item) => item.textContent.trim() === controlType.toUpperCase())
    if (choices.length !== 1) throw new Error('操作タイプの切替を一意に確認できません。')
    choices[0].click()
    return ready(month, controlType, before)
  }
  async function changeMonth(month) {
    const before = await setControl(selectedMonth(), 'all')
    if (before.month === month) return before
    const select = monthSelect()
    const option = [...select.options].find((item) => optionMonth(item) === month)
    if (!option) throw new Error(`公開対象月にありません: ${month}`)
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set
    if (!setter) throw new Error('対象月を変更できません。')
    setter.call(select, option.value)
    select.dispatchEvent(new Event('change', { bubbles: true }))
    // Changing the select may launch a pending SPA route which later resets the controls.
    // Require the dated route AND changed ALL values before touching CLASSIC/MODERN.
    return ready(month, 'all', fingerprint(before), true)
  }
  function offerDownload(bundle) {
    const panel = document.createElement('section')
    panel.id = PANEL_ID
    panel.setAttribute('aria-label', '全期間使用率JSONの保存')
    panel.style.cssText = 'position:fixed;right:16px;top:16px;z-index:2147483647;padding:16px;border:1px solid #aaa;background:#fff;color:#222;font:14px/1.6 sans-serif'
    const url = URL.createObjectURL(new Blob([JSON.stringify(bundle) + '\n'], { type: 'application/json' }))
    const link = document.createElement('a')
    link.href = url; link.download = `usage-rate-snapshots-${edition}.json`
    link.textContent = `${bundle.editions[0].months.length}か月・全${bundle.snapshots.length * ranks.length}分布のJSONを保存`
    link.style.cssText = 'display:block;padding:12px;text-decoration:underline'
    const close = document.createElement('button')
    close.textContent = '保存欄を閉じる'
    close.addEventListener('click', () => { panel.remove(); URL.revokeObjectURL(url) })
    panel.append(link, close); document.body.append(panel); link.focus()
  }
  try {
    const months = [...monthSelect().options].map(optionMonth).filter(Boolean).sort()
    if (months.length < 2 || new Set(months).size !== months.length) throw new Error('全公開月を確認できません。')
    await ready(selectedMonth(), selectedControl())
    // Force a verified month response even if the first target is already selected.
    if (selectedMonth() === months[0]) await changeMonth(months.at(-1))
    const snapshots = []
    for (const month of months) {
      await changeMonth(month)
      for (const controlType of controls) {
        const snapshot = await setControl(month, controlType)
        const live = capture()
        if (live.month !== snapshot.month || live.controlType !== snapshot.controlType || fingerprint(live) !== fingerprint(snapshot)) throw new Error('取得直後に表示が変更されました。')
        snapshots.push(snapshot)
      }
      console.info(`[Buckler usage] ${edition} ${month} (${snapshots.length / controls.length}/${months.length}か月)`)
    }
    if (snapshots.length !== months.length * controls.length) throw new Error('対象月・操作タイプが不足しています。')
    checkRunning()
    offerDownload({ schemaVersion: 1, kind: 'buckler-usage-rate-snapshots', editions: [{ edition, sourceUrl, months }], snapshots })
    const diagnostics = snapshots.flatMap((snapshot) => snapshot.leagues.filter((league) => league.sumDiagnostic)
      .map((league) => ({ month: snapshot.month, controlType: snapshot.controlType, league: league.league, ...league.sumDiagnostic })))
    if (diagnostics.length) console.warn('[Buckler usage] 掲載値の合計に要確認の条件があります。raw JSONは保持しますが、再確認の記録を追加するまで正規化・公開できません。', diagnostics)
    console.info('[Buckler usage] 全公開期間の取得が完了しました。保存リンクからJSONを保存してください。')
  } finally {
    document.removeEventListener('keydown', cancel)
    delete window[RUN_KEY]
  }
})().catch((error) => console.error('[Buckler usage] 中止しました。部分的な取得結果は保存していません。', error))
