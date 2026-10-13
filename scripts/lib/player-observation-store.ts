import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { PLAYER_OBSERVATION_CONDITIONS, PLAYER_OBSERVATION_SOURCE, parsePlayerObservationDataset } from '../../src/lib/playerObservations.ts'
import type { PlayerObservationDataset, PlayerObservationRun } from '../../src/types/playerObservations.ts'
import { parsePlayerObservationPageCapture } from './player-observation-collector.ts'
import type { PlayerObservationInput, PlayerObservationPageCapture } from './player-observation-collector.ts'

const SERIES = 'buckler-max-lp-v1'
const PROJECT_PUBLIC_DIRECTORY = fileURLToPath(new URL('../../public/', import.meta.url))
type RunInfo = PlayerObservationInput['run']
interface StoredRun {
  id: string; phase: 'baseline' | 'observation'; scope: 'probe' | 'population'
  scheduled_at: string; started_at: string | null; planned_end: string | null; ended_at: string | null
  status: PlayerObservationRun['status']
}
interface StoredPage { page: number; captured_at: string; reported_total: number; row_count: number; fingerprint: string }

function utc(value: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().replace('.000Z', 'Z') !== value.replace('.000Z', 'Z')) {
    throw new Error('観測日時は実在するISO UTC日時で指定してください。')
  }
  return new Date(value).toISOString()
}

function id(value: string): string {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9-]{0,95}$/.test(value)) throw new Error('走査IDの形式が不正です。')
  return value
}

function contains(parent: string, child: string): boolean {
  const path = relative(parent, child)
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`))
}

/** ID history may not be placed inside the browser-delivered public directory. */
export function assertPrivateObservationPath(path: string): string {
  const absolute = resolve(path)
  if ([resolve('public'), PROJECT_PUBLIC_DIRECTORY].some((directory) => contains(directory, absolute)) || absolute === dirname(absolute)) {
    throw new Error('ID履歴はpublic以外の非公開ファイルへ保存してください。')
  }
  for (let current = absolute; ; current = dirname(current)) {
    if (existsSync(current)) {
      const stat = lstatSync(current)
      if (stat.isSymbolicLink() || (current === absolute ? !stat.isFile() : !stat.isDirectory())) {
        throw new Error('ID履歴の保存先にリンク等の特殊なファイルは指定できません。')
      }
    }
    if (current === dirname(current)) break
  }
  return absolute
}

/** A durable first-observed ledger; a failed publication never removes observations. */
export class PlayerObservationStore {
  database: DatabaseSync
  constructor(databasePath: string) {
    const path = assertPrivateObservationPath(databasePath)
    mkdirSync(dirname(path), { recursive: true })
    this.database = new DatabaseSync(path)
    this.database.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;')
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS observation_series (
        series_id TEXT PRIMARY KEY, definition_version INTEGER NOT NULL,
        conditions TEXT NOT NULL, baseline_completed_at TEXT
      );
      CREATE TABLE IF NOT EXISTS observation_runs (
        series_id TEXT NOT NULL REFERENCES observation_series(series_id), id TEXT NOT NULL,
        phase TEXT NOT NULL, scope TEXT NOT NULL, scheduled_at TEXT NOT NULL,
        started_at TEXT, planned_end TEXT, ended_at TEXT, status TEXT NOT NULL,
        PRIMARY KEY(series_id, id)
      );
      CREATE TABLE IF NOT EXISTS observation_pages (
        series_id TEXT NOT NULL, run_id TEXT NOT NULL, page INTEGER NOT NULL,
        captured_at TEXT NOT NULL, reported_total INTEGER NOT NULL, row_count INTEGER NOT NULL,
        fingerprint TEXT NOT NULL,
        PRIMARY KEY(series_id, run_id, page),
        FOREIGN KEY(series_id,run_id) REFERENCES observation_runs(series_id,id)
      );
      CREATE TABLE IF NOT EXISTS observation_page_failures (
        series_id TEXT NOT NULL, run_id TEXT NOT NULL, page INTEGER NOT NULL,
        PRIMARY KEY(series_id,run_id,page),
        FOREIGN KEY(series_id,run_id) REFERENCES observation_runs(series_id,id)
      );
      CREATE TABLE IF NOT EXISTS observation_run_ids (
        series_id TEXT NOT NULL, run_id TEXT NOT NULL, cfn_id TEXT NOT NULL,
        PRIMARY KEY(series_id,run_id,cfn_id),
        FOREIGN KEY(series_id,run_id) REFERENCES observation_runs(series_id,id)
      );
      CREATE TABLE IF NOT EXISTS observation_first_seen (
        series_id TEXT NOT NULL, cfn_id TEXT NOT NULL, first_observed_at TEXT NOT NULL,
        run_id TEXT NOT NULL, phase TEXT NOT NULL,
        PRIMARY KEY(series_id,cfn_id),
        FOREIGN KEY(series_id,run_id) REFERENCES observation_runs(series_id,id)
      );
      CREATE INDEX IF NOT EXISTS observation_first_seen_run ON observation_first_seen(series_id,run_id);
    `)
    this.database.prepare('INSERT OR IGNORE INTO observation_series VALUES (?,1,?,NULL)').run(SERIES, JSON.stringify(PLAYER_OBSERVATION_CONDITIONS))
    const series = this.database.prepare('SELECT definition_version,conditions FROM observation_series WHERE series_id=?').get(SERIES)
    if (series?.definition_version !== 1 || series.conditions !== JSON.stringify(PLAYER_OBSERVATION_CONDITIONS)) {
      this.close()
      throw new Error('履歴の定義・取得条件が現在の系列と一致しません。別の基準履歴を作成してください。')
    }
  }

  close(): void { this.database.close() }

  private transaction<T>(action: () => T, readOnly = false): T {
    this.database.exec(readOnly ? 'BEGIN' : 'BEGIN IMMEDIATE')
    try { const value = action(); this.database.exec('COMMIT'); return value }
    catch (error) { this.database.exec('ROLLBACK'); throw error }
  }

  private storedRun(runId: string): StoredRun {
    const run = this.database.prepare('SELECT * FROM observation_runs WHERE series_id=? AND id=?').get(SERIES, id(runId))
    if (!run) throw new Error('対象の走査履歴がありません。')
    return run as unknown as StoredRun
  }

  beginRun(info: RunInfo): void {
    id(info.id)
    if (info.scope !== 'probe' && info.scope !== 'population') throw new Error('走査範囲が不正です。')
    const scheduledAt = utc(info.scheduledAt), startedAt = utc(info.startedAt), plannedEnd = utc(info.endedAt)
    if (scheduledAt > startedAt || startedAt > plannedEnd) throw new Error('走査日時の順序が不正です。')
    this.transaction(() => {
      const existing = this.database.prepare('SELECT * FROM observation_runs WHERE series_id=? AND id=?').get(SERIES, info.id) as unknown as StoredRun | undefined
      if (existing) {
        if (existing.scope !== info.scope || existing.scheduled_at !== scheduledAt || existing.started_at !== startedAt || existing.planned_end !== plannedEnd) {
          throw new Error('同じ走査IDの記録内容が変わっています。新しい走査として保存してください。')
        }
        return
      }
      const active = this.database.prepare("SELECT id FROM observation_runs WHERE series_id=? AND status='running'").get(SERIES)
      if (active) throw new Error('終了していない走査があります。同じ入力で再開してください。')
      const last = this.database.prepare('SELECT MAX(ended_at) AS ended FROM observation_runs WHERE series_id=?').get(SERIES)
      if (typeof last?.ended === 'string' && startedAt < last.ended) throw new Error('過去の走査より前の入力は追加できません。初観測履歴を変更せず停止しました。')
      const baseline = this.database.prepare('SELECT baseline_completed_at FROM observation_series WHERE series_id=?').get(SERIES)
      const phase = baseline?.baseline_completed_at ? 'observation' : 'baseline'
      this.database.prepare('INSERT INTO observation_runs VALUES (?,?,?,?,?,?,?,NULL,?)').run(SERIES, info.id, phase, info.scope, scheduledAt, startedAt, plannedEnd, 'running')
    })
  }

  recordPage(runId: string, value: PlayerObservationPageCapture, suppliedFingerprint?: string): void {
    const page = parsePlayerObservationPageCapture(value)
    const fingerprint = createHash('sha256').update(JSON.stringify(page)).digest('hex')
    if (suppliedFingerprint !== undefined && suppliedFingerprint !== fingerprint) throw new Error('ページ記録の内容照合に失敗しました。')
    this.transaction(() => {
      const run = this.storedRun(runId)
      const existing = this.database.prepare('SELECT fingerprint FROM observation_pages WHERE series_id=? AND run_id=? AND page=?').get(SERIES, runId, page.page)
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new Error('同じ走査・ページの記録内容が変わっています。')
        return
      }
      if (run.status !== 'running') throw new Error('終了済み走査への追加は新しい走査として記録してください。')
      if (!run.started_at || !run.planned_end || page.capturedAt < run.started_at || page.capturedAt > run.planned_end) throw new Error('取得日時が走査区間外です。')
      const latest = this.database.prepare('SELECT MAX(captured_at) AS captured_at FROM observation_pages WHERE series_id=? AND run_id=?').get(SERIES, runId)
      if (typeof latest?.captured_at === 'string' && page.capturedAt < latest.captured_at) throw new Error('ページは取得日時順に保存してください。')
      const failure = this.database.prepare('SELECT page FROM observation_page_failures WHERE series_id=? AND run_id=? AND page=?').get(SERIES, runId, page.page)
      if (failure) throw new Error('失敗済みページの再取得は新しい走査として記録してください。')
      this.database.prepare('INSERT INTO observation_pages VALUES (?,?,?,?,?,?,?)').run(SERIES, runId, page.page, page.capturedAt, page.range.total, page.rows.length, fingerprint)
      const seen = this.database.prepare('INSERT OR IGNORE INTO observation_run_ids VALUES (?,?,?)')
      const first = this.database.prepare('INSERT OR IGNORE INTO observation_first_seen VALUES (?,?,?,?,?)')
      for (const row of page.rows) {
        seen.run(SERIES, runId, row.cfnId)
        first.run(SERIES, row.cfnId, page.capturedAt, runId, run.phase)
      }
    })
  }

  recordFailure(runId: string, page: number): void {
    if (!Number.isSafeInteger(page) || page < 1) throw new Error('失敗ページ番号が不正です。')
    this.transaction(() => {
      const run = this.storedRun(runId)
      const existing = this.database.prepare('SELECT page FROM observation_page_failures WHERE series_id=? AND run_id=? AND page=?').get(SERIES, runId, page)
      if (existing) return
      if (run.status !== 'running') throw new Error('終了済み走査への失敗記録は追加できません。')
      if (this.database.prepare('SELECT page FROM observation_pages WHERE series_id=? AND run_id=? AND page=?').get(SERIES, runId, page)) throw new Error('取得済みページを失敗として上書きできません。')
      this.database.prepare('INSERT INTO observation_page_failures VALUES (?,?,?)').run(SERIES, runId, page)
    })
  }

  finishRun(runId: string, endedAtValue: string): PlayerObservationRun {
    const endedAt = utc(endedAtValue)
    this.transaction(() => {
      const run = this.storedRun(runId)
      if (run.status !== 'running') {
        if (run.ended_at !== endedAt) throw new Error('同じ走査の終了日時は変更できません。')
        return
      }
      if (!run.started_at || endedAt < run.started_at || endedAt !== run.planned_end) throw new Error('走査終了日時が入力記録と一致しません。')
      const pages = this.pages(runId)
      const failures = this.failedPages(runId)
      const maxExpected = pages.length ? Math.ceil(pages.reduce((maximum, page) => Math.max(maximum, page.reported_total), 0) / 20) : null
      const allPages = run.scope === 'population' && failures === 0 && maxExpected !== null
        && pages.length >= maxExpected && pages.slice().sort((a, b) => a.page - b.page).every((page, index) => page.page === index + 1)
      const status = allPages ? 'complete' : pages.length ? 'partial' : 'failed'
      this.database.prepare('UPDATE observation_runs SET status=?,ended_at=? WHERE series_id=? AND id=?').run(status, endedAt, SERIES, runId)
      if (status === 'complete' && run.phase === 'baseline') {
        this.database.prepare('UPDATE observation_series SET baseline_completed_at=? WHERE series_id=?').run(endedAt, SERIES)
      }
    })
    return this.runSummary(runId)
  }

  /** Explicit missing observations are not fabricated as zero-account successful scans. */
  recordMissingRun(runId: string, scheduledAtValue: string): PlayerObservationRun {
    const scheduledAt = utc(scheduledAtValue)
    this.transaction(() => {
      id(runId)
      const existing = this.database.prepare('SELECT scheduled_at,status FROM observation_runs WHERE series_id=? AND id=?').get(SERIES, runId)
      if (existing) {
        if (existing.status !== 'missing' || existing.scheduled_at !== scheduledAt) throw new Error('同じ走査IDの欠測記録が一致しません。')
        return
      }
      const baseline = this.database.prepare('SELECT baseline_completed_at FROM observation_series WHERE series_id=?').get(SERIES)
      const ready = typeof baseline?.baseline_completed_at === 'string' && baseline.baseline_completed_at <= scheduledAt
      this.database.prepare("INSERT INTO observation_runs VALUES (?,?,?,'population',?,NULL,NULL,NULL,'missing')").run(SERIES, runId, ready ? 'observation' : 'baseline', scheduledAt)
    })
    return this.runSummary(runId)
  }

  private pages(runId: string): StoredPage[] {
    return this.database.prepare('SELECT * FROM observation_pages WHERE series_id=? AND run_id=? ORDER BY captured_at,page').all(SERIES, runId) as unknown as StoredPage[]
  }
  private failedPages(runId: string): number {
    return Number(this.database.prepare('SELECT COUNT(*) AS n FROM observation_page_failures WHERE series_id=? AND run_id=?').get(SERIES, runId)?.n)
  }

  runSummary(runId: string): PlayerObservationRun {
    const run = this.storedRun(runId)
    const pages = this.pages(runId)
    const failures = this.failedPages(runId)
    const observed = pages.length ? Number(this.database.prepare('SELECT COUNT(*) AS n FROM observation_run_ids WHERE series_id=? AND run_id=?').get(SERIES, runId)?.n) : null
    const first = Number(this.database.prepare("SELECT COUNT(*) AS n FROM observation_first_seen WHERE series_id=? AND run_id=? AND phase='observation'").get(SERIES, runId)?.n)
    const warnings: string[] = []
    if (new Set(pages.map((page) => page.reported_total)).size > 1) warnings.push('走査中に表示総件数が変わりました。単一時点の名簿ではありません。')
    if (observed !== null && pages.reduce((sum, page) => sum + page.row_count, 0) > observed) warnings.push('ページ間で同じCFN IDを再確認しました。ID単位で重複を除いています。')
    if (run.scope === 'probe') warnings.push('一部ページの検証記録です。全件を観測していません。')
    const complete = run.status === 'complete'
    const canShowLower = run.phase === 'observation' && observed !== null && ['running', 'partial'].includes(run.status)
    const reportedStart = pages[0]?.reported_total ?? null, reportedEnd = pages.at(-1)?.reported_total ?? null
    return {
      id: run.id, phase: run.phase, status: run.status, scope: run.scope,
      scheduledAt: run.scheduled_at, startedAt: run.started_at, endedAt: run.ended_at,
      observedIdCount: observed,
      newObservedCount: run.phase === 'observation' && complete ? first : null,
      newObservedLowerBound: canShowLower ? first : null,
      pages: { expectedAtStart: reportedStart === null ? null : Math.ceil(reportedStart / 20), expectedAtEnd: reportedEnd === null ? null : Math.ceil(reportedEnd / 20),
        succeeded: pages.length, failed: failures, sampledPages: run.scope === 'probe' ? pages.map((page) => page.page).sort((a, b) => a - b) : [] },
      coverage: complete ? 'all-pages' : pages.length ? run.scope === 'probe' ? 'sample' : 'incomplete' : 'none',
      reportedTotalAtStart: reportedStart, reportedTotalAtEnd: reportedEnd, warnings,
      failureReason: run.status === 'missing' ? 'この日時の観測記録がありません。'
        : run.status === 'failed' ? '有効なページ記録を取得できませんでした。'
          : run.status === 'partial' ? '全対象ページの有効な記録が揃っていません。' : null,
    }
  }

  snapshotDataset(generatedAtValue = new Date().toISOString()): PlayerObservationDataset {
    const generatedAt = utc(generatedAtValue)
    return this.transaction(() => {
      const baseline = this.database.prepare('SELECT baseline_completed_at FROM observation_series WHERE series_id=?').get(SERIES)
      const completedAt = typeof baseline?.baseline_completed_at === 'string' ? baseline.baseline_completed_at : null
      const ids = this.database.prepare('SELECT id FROM observation_runs WHERE series_id=? ORDER BY scheduled_at,id').all(SERIES)
      return parsePlayerObservationDataset({ schemaVersion: 1, definitionVersion: 1, seriesId: SERIES, generatedAt,
        source: structuredClone(PLAYER_OBSERVATION_SOURCE), conditions: { ...PLAYER_OBSERVATION_CONDITIONS },
        baseline: { status: completedAt ? 'ready' : 'preparing', completedAt },
        runs: ids.map((row) => this.runSummary(String(row.id))) })
    }, true)
  }
}
