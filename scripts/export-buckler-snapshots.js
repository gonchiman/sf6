// 通常の公式ページを開き、DevToolsのConsoleへ全体を貼り付けて手動実行する。
// 対象月は ['2026-08']、['2023-06..2026-08']、または ['ALL']。Escで中止。
void (async () => {
  const targetMonths = ['2026-08']

  const SOURCE_URL = 'https://www.streetfighter.com/6/buckler/ja-jp/stats/dia'
  const LEAGUES = ['ROOKIE', 'IRON', 'BRONZE', 'SILVER', 'GOLD', 'PLATINUM', 'DIAMOND', 'MASTER']
  const MODE_LABELS = { combined: '操作タイプ合算', separate: '操作タイプ別' }
  const CELL = /^(?:[0-9]\.\d{3}|10\.000|-|-\.---)$/
  const NUMERIC_CELL = /^(?:[0-9]\.\d{3}|10\.000)$/
  const WAIT_MS = 350
  const TIMEOUT_MS = 20000
  const MONTH_TIMEOUT_MS = 60000
  const PANEL_ID = 'sf6-buckler-snapshot-downloads'
  const RUN_KEY = '__sf6BucklerSnapshotExportRunning'
  const isSourceLocation = () => location.origin === 'https://www.streetfighter.com'
    && /^\/6\/buckler\/ja-jp\/stats\/dia(?:\/\d{4}(?:0[1-9]|1[0-2]))?\/?$/.test(location.pathname)
  if (!isSourceLocation()) {
    throw new Error(`このスクリプトは ${SOURCE_URL} で実行してください。`)
  }
  if (window[RUN_KEY]) throw new Error('書き出し処理が実行中です。')
  if (document.getElementById(PANEL_ID)) throw new Error('前回のJSON保存欄を閉じてから再実行してください。')
  window[RUN_KEY] = true
  let cancelled = false
  const cancel = (event) => { if (event.key === 'Escape') cancelled = true }
  document.addEventListener('keydown', cancel)
  const pause = () => new Promise((resolve) => setTimeout(resolve, WAIT_MS))
  const assertRunning = () => {
    if (cancelled) throw new Error('中止しました。途中のJSONは保存していません。')
    if (!isSourceLocation()) {
      throw new Error('公式の対象ページから移動したため中止しました。')
    }
  }
  const root = () => {
    const element = document.querySelector('#dia')
    if (!element) throw new Error('対戦ダイアグラムが見つかりません。')
    return element
  }
  const optionMonth = (option) => {
    const text = option?.textContent.trim()
    return /^\d{4}\.(?:0[1-9]|1[0-2])$/.test(text ?? '') ? text.replace('.', '-') : null
  }
  const monthSelect = () => {
    const matches = [...document.querySelectorAll('select')].filter((select) => [...select.options].some((option) => optionMonth(option)))
    if (matches.length !== 1) throw new Error('対象月の選択欄を一意に確認できません。')
    return matches[0]
  }
  const selectedMonth = () => optionMonth(monthSelect().selectedOptions[0])
  const hasNumericTable = () => [...root().querySelectorAll('table tbody td')].some((element) => NUMERIC_CELL.test(element.textContent.trim()))
  function selectMonth(month) {
    const select = monthSelect()
    const option = [...select.options].find((item) => optionMonth(item) === month)
    if (!option) throw new Error(`対象月が公式の選択肢にありません: ${month}`)
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set
    if (!setter) throw new Error('対象月を変更できません。')
    setter.call(select, option.value)
    select.dispatchEvent(new Event('change', { bubbles: true }))
  }

  function expandMonths(available) {
    if (!Array.isArray(targetMonths) || targetMonths.length === 0) throw new Error('targetMonthsに対象月を指定してください。')
    if (targetMonths.length === 1 && targetMonths[0] === 'ALL') return [...available].sort()
    const result = []
    for (const request of targetMonths) {
      if (typeof request !== 'string') throw new Error('対象月は文字列で指定してください。')
      const match = /^(\d{4}-(?:0[1-9]|1[0-2]))(?:\.\.(\d{4}-(?:0[1-9]|1[0-2])))?$/.exec(request)
      if (!match) throw new Error(`対象月の指定が不正です: ${request}`)
      const start = match[1]
      const end = match[2] ?? start
      if (!available.includes(start) || !available.includes(end) || start > end) throw new Error(`公式の選択肢にない期間です: ${request}`)
      const [year, month] = start.split('-').map(Number)
      const [endYear, endMonth] = end.split('-').map(Number)
      for (let index = year * 12 + month - 1; index <= endYear * 12 + endMonth - 1; index += 1) {
        const value = `${Math.floor(index / 12)}-${String(index % 12 + 1).padStart(2, '0')}`
        if (!available.includes(value) || result.includes(value)) throw new Error(`未提供または重複した対象月です: ${value}`)
        result.push(value)
      }
    }
    return result
  }

  function uiState() {
    const element = root()
    const leagueNav = element.querySelector('img[alt="ROOKIE"]')?.closest('ul')
    const position = leagueNav?.className.match(/league_nav_pos_([1-8])__/)?.[1]
    const activeMode = [...element.querySelectorAll('li')].find((item) => item.className.includes('select_nav_current'))?.textContent.trim()
    return {
      month: selectedMonth(),
      league: position ? LEAGUES[Number(position) - 1] : undefined,
      operationMode: Object.keys(MODE_LABELS).find((mode) => MODE_LABELS[mode] === activeMode),
      order: element.querySelector('li[class*="dia_toggle"]')?.className.includes('dia_ci_sort__') ? 'character' : 'win-rate',
    }
  }

  function identity(element) {
    const images = [...element.querySelectorAll('img')]
    const card = images.find((image) => image.getAttribute('src')?.includes('/card_'))?.getAttribute('src')?.match(/\/card_([a-z0-9_]+)\.jpg$/)?.[1]
    const control = images.find((image) => image.getAttribute('src')?.includes('icon_controltype'))?.getAttribute('src')?.match(/icon_controltype([01])\.png$/)?.[1]
    if (!card) throw new Error('キャラクターIDを確認できません。')
    return { characterId: card, controlType: control === undefined ? null : control === '0' ? 'classic' : 'modern' }
  }

  function cell(element) {
    if (!element) throw new Error('数値セルが不足しています。')
    const text = element.textContent.trim()
    if (!CELL.test(text)) throw new Error(`数値の読み込みが完了していません: ${text}`)
    return { text, lowSample: [...element.classList].some((name) => /^dia_sf__/.test(name)) }
  }

  function capture() {
    const table = root().querySelector('table')
    if (!table) throw new Error('勝率表が見つかりません。')
    const state = uiState()
    const snapshot = {
      snapshotVersion: 1, sourceUrl: SOURCE_URL, ...state,
      readyCharacterCount: Number(table.getAttribute('data-character')),
      columns: [...table.querySelectorAll('thead th[data-col]')].slice(1).map(identity),
      rows: [...table.querySelectorAll('tbody tr')].map((row) => {
        const head = row.querySelector('th')
        const values = [...row.querySelectorAll('td')]
        const name = head?.querySelector('[class*="dia_name__"]')?.textContent.trim()
        if (!head || !name) throw new Error('行見出しが読み込まれていません。')
        return { ...identity(head), name, total: cell(values[0]), cells: values.slice(1).map(cell) }
      }),
      capturedAt: new Date().toISOString(),
    }
    validateSnapshot(snapshot)
    return snapshot
  }

  const identityKey = ({ characterId, controlType }) => `${characterId}/${controlType ?? 'combined'}`
  function validateSnapshot(snapshot) {
    const count = snapshot.columns.length
    if (!snapshot.month || !LEAGUES.includes(snapshot.league) || !Object.hasOwn(MODE_LABELS, snapshot.operationMode)
      || count === 0 || snapshot.readyCharacterCount !== count || snapshot.rows.length !== count) {
      throw new Error('表の条件・行列数が一致していません。')
    }
    const columnKeys = new Set(snapshot.columns.map(identityKey))
    if (columnKeys.size !== count || new Set(snapshot.rows.map(identityKey)).size !== count) throw new Error('行または列のキャラクターが重複しています。')
    const allowedControls = snapshot.operationMode === 'combined' ? [null] : ['classic', 'modern']
    for (let index = 0; index < count; index += 1) {
      const row = snapshot.rows[index]
      if (!columnKeys.has(identityKey(row)) || !allowedControls.includes(row.controlType) || row.cells.length !== count
        || (snapshot.order === 'character' && identityKey(row) !== identityKey(snapshot.columns[index]))) {
        throw new Error('操作タイプ、行見出し、列見出しが一致していません。')
      }
    }
    if (!snapshot.rows.some((row) => [row.total, ...row.cells].some((value) => NUMERIC_CELL.test(value.text)))) {
      throw new Error('表の数値が読み込まれていません。')
    }
  }

  const matrixKey = (snapshot) => JSON.stringify([snapshot.columns, snapshot.rows])
  const totalKey = (snapshot) => JSON.stringify(snapshot.rows.map((row) => [identityKey(row), row.total.text]).sort(([left], [right]) => left.localeCompare(right)))
  const matches = (snapshot, expected) => Object.entries(expected).every(([key, value]) => snapshot[key] === value)
  async function waitForSnapshot(expected, previousTotals, timeoutMs = TIMEOUT_MS) {
    const deadline = Date.now() + timeoutMs
    let previous = null
    let stableSamples = 0
    let lastError = '画面更新待ち'
    while (Date.now() < deadline) {
      assertRunning()
      await pause()
      try {
        const snapshot = capture()
        const key = matrixKey(snapshot)
        if (!matches(snapshot, expected) || (previousTotals !== undefined
          && (totalKey(snapshot) === previousTotals || !snapshot.rows.some((row) => NUMERIC_CELL.test(row.total.text))))) {
          throw new Error('表示条件または数値の更新待ち')
        }
        stableSamples = key === previous ? stableSamples + 1 : 1
        previous = key
        if (stableSamples >= 3) return snapshot
      } catch (error) {
        previous = null
        stableSamples = 0
        lastError = error instanceof Error ? error.message : String(error)
      }
    }
    throw new Error(`${JSON.stringify(expected)} の更新を${timeoutMs / 1000}秒以内に確認できませんでした（${lastError}）。`)
  }

  async function setCondition(month, league, operationMode) {
    let lastError
    for (let attempt = 0; attempt < 3; attempt += 1) {
      assertRunning()
      try {
        const state = uiState()
        if (state.month !== month) throw new Error('操作中に対象月が変わりました。')
        if (state.league !== league) {
          const leagueButton = root().querySelector(`img[alt="${league}"]`)?.closest('li')
          if (!leagueButton) throw new Error('リーグの切替が見つかりません。')
          leagueButton.click()
          await pause()
        }
        const modeButton = [...root().querySelectorAll('li')].find((item) => item.textContent.trim() === MODE_LABELS[operationMode])
        if (!modeButton) throw new Error('操作タイプの切替が見つかりません。')
        if (uiState().operationMode !== operationMode) {
          modeButton.click()
          await pause()
        }
        const toggle = root().querySelector('li[class*="dia_toggle"]')
        if (!toggle) throw new Error('キャラクター順の切替が見つかりません。')
        if (!toggle.className.includes('dia_ci_sort__')) {
          toggle.click()
          await pause()
        }
        return await waitForSnapshot({ month, league, operationMode, order: 'character' })
      } catch (error) {
        lastError = error
      }
    }
    throw lastError
  }

  async function changeMonth(month) {
    const current = selectedMonth()
    if (current === month) return
    // Keep the same filters before and after the monthly response, which can
    // reset the official UI to MASTER / separate. Filter changes alone must
    // never count as evidence that the new month's values have arrived.
    const before = await setCondition(current, 'MASTER', 'separate')
    selectMonth(month)
    // Compare every Total with its fighter identity. A changed select value,
    // changed sort order, or loading placeholders are not sufficient.
    // Identical monthly Totals cause a timeout rather than an assumed success.
    await waitForSnapshot({ month, league: 'MASTER', operationMode: 'separate' }, totalKey(before), MONTH_TIMEOUT_MS)
  }

  function validateMonth(month, snapshots) {
    const conditions = new Set()
    const combined = snapshots.find((item) => item.operationMode === 'combined')?.columns.map((item) => item.characterId)
    if (!combined || snapshots.length !== 16) throw new Error(`${month}の16条件が揃っていません。`)
    const expectedCharacters = new Set(combined)
    for (const snapshot of snapshots) {
      validateSnapshot(snapshot)
      const condition = `${snapshot.league}/${snapshot.operationMode}`
      if (snapshot.month !== month || snapshot.order !== 'character' || conditions.has(condition)) throw new Error(`${month}の条件が重複または不一致です。`)
      conditions.add(condition)
      if (snapshot.columns.length !== combined.length * (snapshot.operationMode === 'combined' ? 1 : 2)
        || snapshot.columns.some((item) => !expectedCharacters.has(item.characterId))) throw new Error(`${month}のキャラクター構成が一致しません。`)
    }
  }

  function offerDownloads(bundles) {
    const panel = document.createElement('section')
    panel.id = PANEL_ID
    panel.setAttribute('aria-label', '取得した月別JSONの保存')
    panel.style.cssText = 'position:fixed;right:16px;top:16px;z-index:2147483647;max-width:calc(100vw - 32px);max-height:80vh;overflow:auto;background:#fff;color:#222;border:1px solid #aaa;padding:16px;font:14px/1.6 sans-serif;box-shadow:0 4px 24px #0004'
    const heading = document.createElement('h2')
    heading.textContent = `JSONの保存（${bundles.length}か月）`
    heading.style.cssText = 'margin:0 0 12px;font-size:16px'
    panel.append(heading)
    const urls = []
    for (const bundle of bundles) {
      const link = document.createElement('a')
      const url = URL.createObjectURL(new Blob([JSON.stringify(bundle) + '\n'], { type: 'application/json' }))
      urls.push(url)
      link.href = url
      link.download = `${bundle.month}.json`
      link.textContent = `${bundle.month}.json`
      link.style.cssText = 'display:block;min-height:44px;padding:10px;color:#245ea8;text-decoration:underline'
      panel.append(link)
    }
    const close = document.createElement('button')
    close.type = 'button'
    close.textContent = '保存欄を閉じる'
    close.style.cssText = 'min-height:44px;margin-top:8px;padding:8px 12px;color:#222;background:#fff;border:1px solid #aaa;cursor:pointer'
    close.addEventListener('click', () => { panel.remove(); urls.forEach((url) => URL.revokeObjectURL(url)) })
    panel.append(close)
    document.body.append(panel)
    panel.querySelector('a')?.focus()
  }

  try {
    const available = [...monthSelect().options].map(optionMonth).filter(Boolean)
    if (new Set(available).size !== available.length) throw new Error('対象月の選択肢が重複しています。')
    const months = expandMonths(available)
    if (months.length === 0 || available.length < 2) throw new Error('月の切替を確認できる選択肢がありません。')
    const alternateMonth = [...available].sort().find((month) => month !== months[0])
    if (!hasNumericTable()) {
      // The page may initially select an unpublished month with no values.
      // Bootstrap a numeric table, then verify the requested month's arrival
      // through the same guarded month transition used for every later month.
      const bootstrapMonth = selectedMonth() === months[0] ? alternateMonth : months[0]
      selectMonth(bootstrapMonth)
      await waitForSnapshot({ month: bootstrapMonth }, undefined, MONTH_TIMEOUT_MS)
    }
    await waitForSnapshot({ month: selectedMonth() }, undefined, MONTH_TIMEOUT_MS)
    // Force a monthly response even when the first requested month is already selected.
    // Prefer an old offered month; the newest dropdown entry can be unpublished.
    if (selectedMonth() === months[0]) await changeMonth(alternateMonth)
    const bundles = []
    for (const month of months) {
      assertRunning()
      await changeMonth(month)
      // Force a different league before capturing the first ROOKIE table.
      await setCondition(month, 'MASTER', 'combined')
      const snapshots = []
      for (const league of LEAGUES) {
        for (const mode of Object.keys(MODE_LABELS)) {
          const snapshot = await setCondition(month, league, mode)
          const live = capture()
          if (!matches(live, { month, league, operationMode: mode, order: 'character' }) || matrixKey(live) !== matrixKey(snapshot)) {
            throw new Error('取得直後に表示条件または数値が変更されました。')
          }
          snapshots.push(snapshot)
          console.info(`[Buckler] ${month} ${league} ${MODE_LABELS[mode]} (${snapshots.length}/16)`)
        }
      }
      validateMonth(month, snapshots)
      bundles.push({ snapshotVersion: 1, month, snapshots })
    }
    assertRunning()
    offerDownloads(bundles)
    console.info(`[Buckler] ${bundles.length}か月・全${bundles.length * 16}条件の取得が完了しました。右上のリンクから月別JSONを保存してください。`)
  } finally {
    document.removeEventListener('keydown', cancel)
    delete window[RUN_KEY]
  }
})().catch((error) => console.error('[Buckler] 書き出しを中止しました。部分的な月データは保存していません。', error))
