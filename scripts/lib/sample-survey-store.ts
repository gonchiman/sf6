import { existsSync, lstatSync, mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { parseSampleSurveyPlan, parseSampleSurveyRun } from '../../src/lib/sampleSurvey.ts'
import type { SampleSurveyPlan, SampleSurveyRun } from '../../src/types/sampleSurvey.ts'
import { parseSampleSurveyCheckpoint } from './sample-survey-runner.ts'
import type { SampleSurveyCheckpoint } from './sample-survey-runner.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const MAX_CHECKPOINT_BYTES = 16 * 1024 * 1024
function invalid(): never { throw new Error('標本調査の非公開記録を保存・読込できません。') }
function ancestors(path: string, finalFile = false): void {
  for (let current = path; ; current = dirname(current)) {
    if (existsSync(current)) {
      const info = lstatSync(current)
      if (info.isSymbolicLink() || (current === path && finalFile ? !info.isFile() : !info.isDirectory())) invalid()
    }
    if (current === dirname(current)) break
  }
}

/** The only database destination is a fixed private subtree beneath the project. */
export function createSampleSurveyStore(projectRoot = ROOT) {
  const root = resolve(projectRoot)
  if (root.split(sep).some(part => ['public', '.git'].includes(part.toLowerCase())) || root === dirname(root)) invalid()
  ancestors(root)
  if (!existsSync(root)) invalid()
  const local = resolve(root, '.local'), directory = resolve(local, 'sample-survey')
  for (const path of [local, directory]) {
    ancestors(dirname(path))
    if (!existsSync(path)) mkdirSync(path, { mode: 0o700 })
    ancestors(path)
  }
  const path = resolve(directory, 'observations.sqlite')
  function assertFiles() {
    ancestors(directory)
    for (const suffix of ['', '-wal', '-shm', '-journal']) ancestors(path + suffix, true)
  }
  assertFiles()
  const database = new DatabaseSync(path)
  const owner = randomUUID()
  let closed = false
  try {
    database.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;')
    database.exec(`
      CREATE TABLE IF NOT EXISTS sample_survey_plans (
        id TEXT PRIMARY KEY, created_at TEXT NOT NULL, plan_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sample_survey_runs (
        id TEXT PRIMARY KEY, plan_id TEXT NOT NULL REFERENCES sample_survey_plans(id),
        started_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        report_json TEXT NOT NULL, checkpoint_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sample_survey_runs_started ON sample_survey_runs(started_at);
      CREATE TABLE IF NOT EXISTS sample_survey_owner (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1), pid INTEGER NOT NULL, token TEXT NOT NULL
      );
    `)
    database.exec('BEGIN IMMEDIATE')
    try {
      const existing = database.prepare('SELECT pid FROM sample_survey_owner WHERE singleton=1').get()
      if (existing) {
        const pid = Number(existing.pid)
        if (!Number.isSafeInteger(pid) || pid < 1) invalid()
        let alive = true
        try { process.kill(pid, 0) }
        catch (error) { alive = !(error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH') }
        if (alive) invalid()
      }
      database.prepare('INSERT INTO sample_survey_owner VALUES (1,?,?) ON CONFLICT(singleton) DO UPDATE SET pid=excluded.pid,token=excluded.token').run(process.pid, owner)
      database.exec('COMMIT')
    } catch (error) { database.exec('ROLLBACK'); throw error }
  } catch { database.close(); invalid() }
  function use<T>(operation: () => T): T {
    if (closed) invalid()
    try {
      assertFiles()
      const lease = database.prepare('SELECT token FROM sample_survey_owner WHERE singleton=1').get()
      if (lease?.token !== owner) invalid()
      return operation()
    } catch { invalid() }
  }
  function transaction<T>(operation: () => T): T {
    return use(() => {
      database.exec('BEGIN IMMEDIATE')
      try { const value = operation(); database.exec('COMMIT'); return value }
      catch (error) { database.exec('ROLLBACK'); throw error }
    })
  }
  function putPlan(plan: SampleSurveyPlan) {
    const serialized = JSON.stringify(plan)
    const existing = database.prepare('SELECT plan_json FROM sample_survey_plans WHERE id=?').get(plan.id)
    if (existing && existing.plan_json !== serialized) invalid()
    database.prepare('INSERT OR IGNORE INTO sample_survey_plans VALUES (?,?,?)').run(plan.id, plan.createdAt, serialized)
  }
  return {
    savePlan(value: SampleSurveyPlan): void {
      const plan = parseSampleSurveyPlan(value)
      transaction(() => putPlan(plan))
    },
    listPlans(): SampleSurveyPlan[] {
      return use(() => database.prepare('SELECT plan_json FROM sample_survey_plans ORDER BY created_at DESC,id DESC LIMIT 1000').all()
        .map(row => parseSampleSurveyPlan(JSON.parse(String(row.plan_json)))))
    },
    saveRun(value: SampleSurveyCheckpoint): void {
      const checkpoint = parseSampleSurveyCheckpoint(value), report = checkpoint.report
      const serialized = JSON.stringify(checkpoint)
      if (Buffer.byteLength(serialized) > MAX_CHECKPOINT_BYTES) invalid()
      transaction(() => {
        putPlan(checkpoint.plan)
        const existing = database.prepare('SELECT checkpoint_json FROM sample_survey_runs WHERE id=?').get(report.id)
        if (existing) {
          const previous = parseSampleSurveyCheckpoint(JSON.parse(String(existing.checkpoint_json)))
          if (previous.plan.id !== checkpoint.plan.id || previous.report.startedAt !== report.startedAt || previous.report.updatedAt > report.updatedAt
            || previous.report.attempts > report.attempts || previous.report.successfulPages > report.successfulPages
            || previous.report.elapsedMs > report.elapsedMs || previous.slots.length > checkpoint.slots.length) invalid()
          const updatedSlots = new Map(checkpoint.slots.map(slot => [slot.id, slot]))
          for (const oldSlot of previous.slots) {
            const slot = updatedSlots.get(oldSlot.id)
            if (!slot || oldSlot.status !== 'pending' && JSON.stringify(slot) !== JSON.stringify(oldSlot)) invalid()
          }
          if (previous.report.state === 'complete' && serialized !== JSON.stringify(previous)) invalid()
        }
        database.prepare(`INSERT INTO sample_survey_runs VALUES (?,?,?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at, report_json=excluded.report_json, checkpoint_json=excluded.checkpoint_json`)
          .run(report.id, report.planId, report.startedAt, report.updatedAt, JSON.stringify(report), serialized)
      })
    },
    listRuns(): SampleSurveyRun[] {
      return use(() => database.prepare('SELECT report_json FROM sample_survey_runs ORDER BY started_at DESC,id DESC LIMIT 1000').all()
        .map(row => parseSampleSurveyRun(JSON.parse(String(row.report_json)))))
    },
    loadRun(id: string): SampleSurveyCheckpoint | null {
      if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(id)) invalid()
      return use(() => {
        const row = database.prepare('SELECT checkpoint_json FROM sample_survey_runs WHERE id=?').get(id)
        if (!row) return null
        const text = String(row.checkpoint_json)
        if (Buffer.byteLength(text) > MAX_CHECKPOINT_BYTES) invalid()
        const checkpoint = parseSampleSurveyCheckpoint(JSON.parse(text))
        if (checkpoint.report.id !== id) invalid()
        return checkpoint
      })
    },
    close(): void {
      if (!closed) {
        try { database.prepare('DELETE FROM sample_survey_owner WHERE singleton=1 AND token=?').run(owner) }
        finally { database.close(); closed = true }
      }
    },
  }
}
