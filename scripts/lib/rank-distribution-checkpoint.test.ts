import assert from 'node:assert/strict'
import { dirname } from 'node:path'
import test from 'node:test'
import { RANK_BOUNDARY_SOURCE_URL } from './rank-distribution-boundaries.ts'
import {
  createRankDistributionCheckpointStore, mergeRankDistributionCheckpoints, parseRankDistributionCheckpoint,
  RANK_DISTRIBUTION_CHECKPOINT_PATH, RANK_DISTRIBUTION_CHECKPOINT_SIZE_LIMIT, RankDistributionCheckpointError,
} from './rank-distribution-checkpoint.ts'
import type {
  RankDistributionCheckpoint, RankDistributionCheckpointFileInfo, RankDistributionCheckpointIo,
} from './rank-distribution-checkpoint.ts'

const savedAt = '2026-10-15T10:00:00.000Z'
const observedAt = '2026-10-15T09:59:00.000Z'
const path = RANK_DISTRIBUTION_CHECKPOINT_PATH
const lockPath = `${path}.lock`
const nonce = '11111111-1111-4111-8111-111111111111'

function checkpoint(rankIds = [2, 10, 36]): RankDistributionCheckpoint {
  return {
    schemaVersion: 1, method: 'boundary-search-estimate', sourceUrl: RANK_BOUNDARY_SOURCE_URL,
    pageSize: 20, savedAt,
    hints: rankIds.map(rankId => ({ rankId, countAtOrAbove: 100 - rankId, totalCount: 100, observedAt })),
  }
}
function errorCode(code: string) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof RankDistributionCheckpointError)
    assert.equal(error.code, code)
    assert.equal(error.cause, undefined)
    assert.doesNotMatch(error.message, /private-cookie|private-player|raw-file-error|C:\\Users/)
    return true
  }
}
function fixture() {
  const files = new Map<string, Uint8Array>()
  const info = new Map<string, RankDistributionCheckpointFileInfo>()
  const operations: Array<{ action: string; path: string; mode?: number; flag?: string }> = []
  for (let current = dirname(path); ; current = dirname(current)) {
    info.set(current, { kind: 'directory', symbolicLink: false, size: 0 })
    if (current === dirname(current)) break
  }
  const io: RankDistributionCheckpointIo = {
    async inspect(target) {
      operations.push({ action: 'inspect', path: target })
      return info.get(target) ?? (files.has(target) ? { kind: 'file', symbolicLink: false, size: files.get(target)!.byteLength } : null)
    },
    async mkdir(target, mode) {
      operations.push({ action: 'mkdir', path: target, mode })
      info.set(target, { kind: 'directory', symbolicLink: false, size: 0 })
    },
    async readBounded(target, maximumBytes) {
      operations.push({ action: 'read', path: target })
      assert.equal(maximumBytes, RANK_DISTRIBUTION_CHECKPOINT_SIZE_LIMIT)
      return files.get(target)!
    },
    async writeFile(target, bytes, options) {
      operations.push({ action: 'write', path: target, ...options })
      if (files.has(target) || info.has(target)) throw Object.assign(new Error('raw-file-error-private-cookie'), { code: 'EEXIST' })
      files.set(target, Uint8Array.from(bytes))
    },
    async rename(from, to) {
      operations.push({ action: 'rename', path: to })
      assert.equal(from, `${path}.tmp-${nonce}`)
      assert.equal(to, path)
      files.set(to, files.get(from)!)
      files.delete(from)
    },
    async unlink(target) { operations.push({ action: 'unlink', path: target }); files.delete(target) },
  }
  const store = createRankDistributionCheckpointStore({ io, now: () => new Date(savedAt), randomId: () => nonce })
  return { io, store, files, info, operations, seed(value: unknown) { files.set(path, Buffer.from(JSON.stringify(value))) } }
}

test('parses only aggregate search hints and never claims they are a completed dataset', () => {
  const value = checkpoint()
  assert.deepEqual(parseRankDistributionCheckpoint(JSON.parse(JSON.stringify(value))), value)
  assert.deepEqual(parseRankDistributionCheckpoint(checkpoint([])).hints, [])
  assert.doesNotMatch(JSON.stringify(parseRankDistributionCheckpoint(value)), /accountKey|leaguePoint|cookie|entries|verified/)
  // Cross-run hints may move in opposite directions; final observations must be checked anew.
  const crossed = checkpoint([2, 36])
  crossed.hints[1].countAtOrAbove = 99
  assert.deepEqual(parseRankDistributionCheckpoint(crossed), crossed)
})

test('rejects unknown keys, conditions, rank IDs, duplicate ranks and unsafe counts', () => {
  const bad: unknown[] = [
    null, [], {}, { ...checkpoint(), schemaVersion: 2 }, { ...checkpoint(), method: 'boundary-search' },
    { ...checkpoint(), sourceUrl: `${RANK_BOUNDARY_SOURCE_URL}&platform=2` },
    { ...checkpoint(), sourceUrl: 'https://private-cookie@example.test/' },
    { ...checkpoint(), privatePlayer: 'private-player' },
    { ...checkpoint(), hints: [{ ...checkpoint().hints[0], accountKey: 'private-player' }] },
    { ...checkpoint(), hints: [{ ...checkpoint().hints[0], leaguePoint: 1000 }] },
    { ...checkpoint(), hints: [...checkpoint().hints, checkpoint().hints[0]] },
    { ...checkpoint(), hints: Array.from({ length: 36 }, () => checkpoint().hints[0]) },
  ]
  for (const rankId of [0, 1, 37, 1.5, NaN, Infinity, null]) {
    bad.push({ ...checkpoint(), hints: [{ ...checkpoint().hints[0], rankId }] })
  }
  for (const field of ['countAtOrAbove', 'totalCount']) {
    for (const value of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, null]) {
      bad.push({ ...checkpoint(), hints: [{ ...checkpoint().hints[0], [field]: value }] })
    }
  }
  for (const pageSize of [0, -1, 21, 1.5, null]) bad.push({ ...checkpoint(), pageSize })
  bad.push({ ...checkpoint(), hints: [{ ...checkpoint().hints[0], countAtOrAbove: 101 }] })
  for (const value of bad) assert.throws(() => parseRankDistributionCheckpoint(value), errorCode('invalid-checkpoint'))
})

test('requires real UTC timestamps and refuses hints observed after saving', () => {
  for (const timestamp of ['2026-02-30T10:00:00Z', '2026-13-01T10:00:00Z', '2026-10-15T24:00:00Z', '2026-10-15', '2026-10-15T10:00:00+09:00', 'invalid']) {
    assert.throws(() => parseRankDistributionCheckpoint({ ...checkpoint(), savedAt: timestamp }), errorCode('invalid-checkpoint'))
    assert.throws(() => parseRankDistributionCheckpoint({ ...checkpoint(), hints: [{ ...checkpoint().hints[0], observedAt: timestamp }] }), errorCode('invalid-checkpoint'))
  }
  assert.throws(() => parseRankDistributionCheckpoint({ ...checkpoint(), hints: [{ ...checkpoint().hints[0], observedAt: '2026-10-15T10:00:00.001Z' }] }), errorCode('invalid-checkpoint'))
  assert.equal(parseRankDistributionCheckpoint({ ...checkpoint(), savedAt: '2026-10-15T10:00:00Z' }).savedAt, '2026-10-15T10:00:00Z')
})

test('merge retains untouched and newer hints across failed runs without reducing rank coverage', () => {
  const previous = checkpoint([2, 10, 36])
  const incoming = checkpoint([10, 20])
  incoming.hints[0] = { ...incoming.hints[0], countAtOrAbove: 88, observedAt: '2026-10-15T09:59:30Z' }
  incoming.hints[1].observedAt = '2026-10-15T09:58:00Z'
  const merged = mergeRankDistributionCheckpoints(previous, incoming)
  assert.deepEqual(merged.hints.map(hint => hint.rankId), [2, 10, 20, 36])
  assert.equal(merged.hints.find(hint => hint.rankId === 10)!.countAtOrAbove, 88)
  const stale = checkpoint([10])
  stale.savedAt = '2026-10-15T09:59:15Z'
  assert.deepEqual(mergeRankDistributionCheckpoints(merged, stale), merged)
  assert.deepEqual(mergeRankDistributionCheckpoints(merged, checkpoint([])), merged)
  assert.deepEqual(mergeRankDistributionCheckpoints(null, incoming), incoming)
  const conflict = checkpoint([2])
  conflict.hints[0].countAtOrAbove = 1
  assert.throws(() => mergeRankDistributionCheckpoints(previous, conflict), errorCode('invalid-checkpoint'))
  assert.throws(() => mergeRankDistributionCheckpoints(previous, { ...incoming, pageSize: 10 }), errorCode('invalid-checkpoint'))
  assert.deepEqual(previous, checkpoint([2, 10, 36]))
})

test('missing state loads as null and saving creates only fixed private paths with safe modes', async () => {
  const setup = fixture()
  setup.info.delete(dirname(path))
  setup.info.delete(dirname(dirname(path)))
  assert.equal(await setup.store.load(), null)
  assert.ok(!setup.operations.some(operation => operation.action === 'mkdir'))
  const saved = await setup.store.save(checkpoint())
  assert.deepEqual(saved, checkpoint())
  assert.deepEqual(await setup.store.load(), checkpoint())
  assert.deepEqual([...setup.files.keys()], [path])
  assert.ok(setup.operations.filter(operation => operation.action === 'mkdir').every(operation => operation.mode === 0o700))
  assert.ok(setup.operations.filter(operation => operation.action === 'write').every(operation => operation.mode === 0o600 && operation.flag === 'wx'))
  const permittedFiles = new Set([path, lockPath, `${path}.tmp-${nonce}`])
  assert.ok(setup.operations.filter(operation => ['read', 'write', 'rename', 'unlink'].includes(operation.action))
    .every(operation => permittedFiles.has(operation.path)))
})

test('atomic save merges previous hints and a new store reopens the aggregate checkpoint', async () => {
  const setup = fixture()
  await setup.store.save(checkpoint([2, 36]))
  await setup.store.save(checkpoint([10]))
  const reopened = createRankDistributionCheckpointStore({ io: setup.io, now: () => new Date(savedAt), randomId: () => nonce })
  assert.deepEqual((await reopened.load())!.hints.map(hint => hint.rankId), [2, 10, 36])
  assert.deepEqual([...setup.files.keys()], [path])
})

test('unsafe files and every parent link are refused before reading or replacing data', async () => {
  for (const target of [path, dirname(path), dirname(dirname(path)), dirname(dirname(dirname(path)))]) {
    for (const mark of ['symbolicLink', 'reparsePoint'] as const) {
      const setup = fixture()
      setup.seed(checkpoint())
      setup.info.set(target, { kind: target === path ? 'file' : 'directory', symbolicLink: false, size: 0, [mark]: true })
      await assert.rejects(setup.store.load(), errorCode('unsafe-path'))
      await assert.rejects(setup.store.save(checkpoint()), errorCode('unsafe-path'))
      assert.ok(!setup.operations.some(operation => operation.action === 'read'))
    }
  }
  const directory = fixture()
  directory.info.set(path, { kind: 'directory', symbolicLink: false, size: 0 })
  await assert.rejects(directory.store.load(), errorCode('unsafe-path'))
  const special = fixture()
  special.info.set(path, { kind: 'other', symbolicLink: false, size: 0 })
  await assert.rejects(special.store.load(), errorCode('unsafe-path'))
})

test('corrupt, oversized and future records stop fresh saves while preserving the previous bytes', async () => {
  for (const bytes of [Buffer.from('private-cookie-invalid-json'), Buffer.from('{}'), Buffer.from([0xff])]) {
    const setup = fixture()
    setup.files.set(path, bytes)
    await assert.rejects(setup.store.load(), errorCode('invalid-checkpoint'))
    await assert.rejects(setup.store.save(checkpoint()), errorCode('invalid-checkpoint'))
    assert.deepEqual(setup.files.get(path), bytes)
    assert.ok(!setup.files.has(lockPath))
  }
  const oversized = fixture()
  oversized.info.set(path, { kind: 'file', symbolicLink: false, size: RANK_DISTRIBUTION_CHECKPOINT_SIZE_LIMIT + 1 })
  await assert.rejects(oversized.store.load(), errorCode('size-limit'))
  assert.ok(!oversized.operations.some(operation => operation.action === 'read'))
  const future = fixture()
  const value = { ...checkpoint(), savedAt: '2026-10-15T10:00:00.001Z' }
  future.seed(value)
  await assert.rejects(future.store.load(), errorCode('future-checkpoint'))
  await assert.rejects(future.store.save(checkpoint()), errorCode('future-checkpoint'))
  assert.deepEqual(JSON.parse(Buffer.from(future.files.get(path)!).toString()), value)
})

test('a concurrent lock is rejected immediately and never removed by another writer', async () => {
  const setup = fixture()
  setup.files.set(lockPath, Buffer.from('private-cookie-existing-lock'))
  await assert.rejects(setup.store.save(checkpoint()), errorCode('locked'))
  assert.equal(Buffer.from(setup.files.get(lockPath)!).toString(), 'private-cookie-existing-lock')
  assert.ok(!setup.operations.some(operation => operation.action === 'write'))
  const raced = fixture()
  raced.io.writeFile = async () => { throw Object.assign(new Error('raw-file-error-private-cookie'), { code: 'EEXIST' }) }
  await assert.rejects(raced.store.save(checkpoint()), errorCode('locked'))
  assert.ok(!raced.operations.some(operation => operation.action === 'unlink'))
})

test('write and rename failures keep previous hints and expose only a fixed error', async () => {
  const setup = fixture()
  setup.seed(checkpoint([2, 36]))
  const previous = Uint8Array.from(setup.files.get(path)!)
  setup.io.rename = async () => { throw new Error('raw-file-error-private-cookie-private-player') }
  await assert.rejects(setup.store.save(checkpoint([10])), errorCode('io-failed'))
  assert.deepEqual(Uint8Array.from(setup.files.get(path)!), previous)
  assert.deepEqual([...setup.files.keys()], [path])
  const failedWrite = fixture()
  const originalWrite = failedWrite.io.writeFile
  failedWrite.io.writeFile = async (target, bytes, options) => {
    if (target !== lockPath) throw new Error('raw-file-error-private-cookie')
    return originalWrite(target, bytes, options)
  }
  await assert.rejects(failedWrite.store.save(checkpoint()), errorCode('io-failed'))
  assert.equal(failedWrite.files.size, 0)
})

test('rechecks directory, destination and staging files immediately before atomic replacement', async () => {
  for (const mutate of ['parent', 'destination', 'stage', 'content'] as const) {
    const setup = fixture()
    setup.seed(checkpoint([2]))
    const write = setup.io.writeFile
    setup.io.writeFile = async (target, bytes, options) => {
      await write(target, bytes, options)
      if (target === lockPath) return
      if (mutate === 'parent') setup.info.set(dirname(path), { kind: 'directory', symbolicLink: true, size: 0 })
      if (mutate === 'destination') setup.info.set(path, { kind: 'file', symbolicLink: true, size: 0 })
      if (mutate === 'stage') setup.info.set(target, { kind: 'file', symbolicLink: true, size: bytes.length })
      if (mutate === 'content') setup.seed(checkpoint([36]))
    }
    await assert.rejects(setup.store.save(checkpoint([10])), errorCode(mutate === 'content' ? 'io-failed' : 'unsafe-path'))
    assert.ok(!setup.operations.some(operation => operation.action === 'rename'))
    if (mutate === 'parent') {
      assert.ok(setup.files.has(lockPath))
      assert.ok(!setup.operations.some(operation => operation.action === 'unlink'))
    } else assert.ok(!setup.files.has(lockPath))
  }
})

test('read bounds, invalid clocks and unsafe staging names cannot bypass validation', async () => {
  const grown = fixture()
  grown.seed(checkpoint())
  grown.io.readBounded = async () => new Uint8Array(RANK_DISTRIBUTION_CHECKPOINT_SIZE_LIMIT + 1)
  await assert.rejects(grown.store.load(), errorCode('size-limit'))
  const truncated = fixture()
  truncated.seed(checkpoint())
  truncated.io.readBounded = async () => Buffer.from('{}')
  await assert.rejects(truncated.store.load(), errorCode('invalid-checkpoint'))
  const setup = fixture()
  const invalidClock = createRankDistributionCheckpointStore({ io: setup.io, now: () => new Date(NaN), randomId: () => nonce })
  await assert.rejects(invalidClock.save(checkpoint()), errorCode('invalid-checkpoint'))
  const unsafeNonce = createRankDistributionCheckpointStore({ io: setup.io, now: () => new Date(savedAt), randomId: () => '../private-cookie' })
  await assert.rejects(unsafeNonce.save(checkpoint()), errorCode('unsafe-path'))
  assert.ok(!setup.files.has(lockPath))
  assert.throws(() => createRankDistributionCheckpointStore({ path: 'private-cookie' } as never), errorCode('invalid-checkpoint'))
})
