import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { dirname, join, relative } from 'node:path'
import test from 'node:test'
import {
  BUCKLER_PRIVATE_SESSION_PATH, BUCKLER_SESSION_CAPTURE_PATH, BUCKLER_SESSION_SIZE_LIMIT, BucklerSessionStoreError,
  createBucklerSessionStore, validateBucklerSessionState,
} from './buckler-session-store.ts'
import type { BucklerSessionCrypto, BucklerSessionFileInfo, BucklerSessionStoreIo, BucklerSessionStoreOptions } from './buckler-session-store.ts'

function state(cookieValue = 'offline-cookie-fixture') {
  return {
    cookies: [{ name: 'fixture', value: cookieValue, domain: '.streetfighter.com', path: '/', expires: -1,
      httpOnly: true, secure: true, sameSite: 'Lax', partitionKey: 'https://www.streetfighter.com' }],
    origins: [{ origin: 'https://www.streetfighter.com', localStorage: [{ name: 'fixture', value: 'offline-localstorage-fixture' }] }],
  }
}

function virtualIo() {
  const files = new Map<string, Buffer>()
  const info = new Map<string, BucklerSessionFileInfo>()
  const paths: string[] = []
  const modes: number[] = []
  const directory = dirname(BUCKLER_PRIVATE_SESSION_PATH)
  const repo = dirname(dirname(directory))
  for (let path = repo; ; path = dirname(path)) {
    info.set(path, { kind: 'directory', symbolicLink: false, reparsePoint: false, size: 0 })
    if (path === dirname(path)) break
  }
  const io: BucklerSessionStoreIo = {
    inspect: async path => { paths.push(path); return info.get(path) ?? null },
    mkdir: async (path, mode) => { paths.push(path); modes.push(mode); info.set(path, { kind: 'directory', symbolicLink: false, reparsePoint: false, size: 0 }) },
    readFile: async path => { paths.push(path); const value = files.get(path); if (!value) throw new Error('offline-private-read-error'); return Buffer.from(value) },
    writeFile: async (path, value, options) => {
      paths.push(path); modes.push(options.mode)
      assert.equal(options.flag, 'wx')
      if (files.has(path)) throw new Error('offline-private-file-exists')
      const bytes = Buffer.from(value)
      files.set(path, bytes)
      info.set(path, { kind: 'file', symbolicLink: false, reparsePoint: false, size: bytes.length })
    },
    rename: async (from, to) => {
      paths.push(from, to)
      files.set(to, files.get(from)!)
      info.set(to, info.get(from)!)
      files.delete(from); info.delete(from)
    },
    unlink: async path => { paths.push(path); files.delete(path); info.delete(path) },
  }
  return { io, info, files, paths, modes, directory, repo }
}

/** Synthetic in-memory framing, not encryption and not a real credential/session. */
function fakeCrypto(): BucklerSessionCrypto {
  const header = Buffer.from('offline-fixture-only')
  return {
    protect: async plain => {
      const bytes = Buffer.from(plain)
      return Buffer.concat([header, createHash('sha256').update(bytes).digest(), bytes]).toString('base64')
    },
    unprotect: async value => {
      const bytes = Buffer.from(value, 'base64')
      const digest = bytes.subarray(header.length, header.length + 32)
      const plain = bytes.subarray(header.length + 32)
      if (!bytes.subarray(0, header.length).equals(header) || !digest.equals(createHash('sha256').update(plain).digest())) {
        throw new Error('offline-private-corruption-message')
      }
      return plain.toString('utf8')
    },
  }
}

function safeError(error: unknown): error is BucklerSessionStoreError {
  assert.ok(error instanceof BucklerSessionStoreError)
  assert.ok(!error.message.includes('offline-private'))
  assert.ok(!error.message.includes('cookie-fixture'))
  assert.ok(!error.message.includes(BUCKLER_PRIVATE_SESSION_PATH))
  return true
}

test('validates only streetfighter cookies/origins and preserves session cookie and partition key fields', () => {
  assert.deepEqual(JSON.parse(validateBucklerSessionState(JSON.stringify(state()))), state())
  const value = state()
  value.cookies[0].domain = 'www.streetfighter.com'
  value.cookies[0].value = ''
  value.cookies[0].expires = 1780000000.5
  assert.equal(JSON.parse(validateBucklerSessionState(JSON.stringify(value))).cookies[0].expires, 1780000000.5)
})

test('rejects other sites, malformed fields, duplicate records, unknown branches and invalid JSON without echoing inputs', () => {
  const cases: unknown[] = [
    { ...state(), branchInfo: 'offline-private-branch' },
    { ...state(), origins: [{ origin: 'https://cid.capcom.com', localStorage: [] }] },
    { ...state(), origins: [{ origin: 'http://www.streetfighter.com', localStorage: [] }] },
    { ...state(), origins: [{ origin: 'https://www.streetfighter.com/path', localStorage: [] }] },
    { ...state(), origins: [{ origin: 'https://www.streetfighter.com', localStorage: [{ name: 'x', value: 1 }] }] },
    { ...state(), cookies: [state().cookies[0], state().cookies[0]] },
    { ...state(), origins: [state().origins[0], state().origins[0]] },
  ]
  for (const change of [
    { domain: 'streetfighter.com.evil.example' }, { domain: '.cid.capcom.com' }, { path: 'relative' },
    { expires: -0.5 }, { expires: null }, { sameSite: 'invalid' }, { httpOnly: 'true' },
    { name: 'invalid name' }, { value: 'offline-private\nvalue' }, { partitionKey: 1 },
  ]) cases.push({ ...state(), cookies: [{ ...state().cookies[0], ...change }] })
  for (const value of cases) assert.throws(() => validateBucklerSessionState(JSON.stringify(value)), safeError)
  assert.throws(() => validateBucklerSessionState('{offline-private-truncated'), safeError)
})

test('capture saves to a single fixed local binary file using private permissions and loads a fresh caller-owned JSON value', async () => {
  const fixture = virtualIo()
  const store = createBucklerSessionStore({ io: fixture.io, crypto: fakeCrypto() })
  assert.equal(await store.exists(), false)
  await store.save(JSON.stringify(state()), 'capture')
  assert.equal(await store.exists(), true)
  assert.deepEqual(JSON.parse(await store.load()), state())
  assert.deepEqual([...fixture.files.keys()], [BUCKLER_PRIVATE_SESSION_PATH])
  assert.ok(fixture.modes.includes(0o600))
  assert.equal(relative(fixture.repo, BUCKLER_PRIVATE_SESSION_PATH), join('.local', 'buckler-auth-probe', 'private-session.dpapi'))
  // No caller-controlled output path exists. Virtual writes stay in the fixed local directory.
  for (const path of fixture.paths.filter(path => path.includes('private-session'))) {
    assert.ok(path === BUCKLER_PRIVATE_SESSION_PATH || path.startsWith(`${BUCKLER_PRIVATE_SESSION_PATH}.tmp-`))
  }
})

test('requires capture intent, refuses path options, and rejects oversize state before any encryption or filesystem writes', async () => {
  const fixture = virtualIo()
  let protectCalls = 0
  const crypto = fakeCrypto()
  const store = createBucklerSessionStore({ io: fixture.io, crypto: { ...crypto, protect: async value => { protectCalls++; return crypto.protect(value) } } })
  await assert.rejects(store.save(JSON.stringify(state()), 'reuse' as 'capture'), safeError)
  assert.throws(() => createBucklerSessionStore({ io: fixture.io, crypto, path: '../outside' } as unknown as BucklerSessionStoreOptions), safeError)
  const oversized = state('x'.repeat(BUCKLER_SESSION_SIZE_LIMIT))
  await assert.rejects(store.save(JSON.stringify(oversized), 'capture'), safeError)
  assert.equal(protectCalls, 0)
  assert.equal(fixture.files.size, 0)
})

test('cancelling before encryption, during encryption or after staging preserves the previous capture', async () => {
  for (const moment of ['before', 'encryption', 'staging'] as const) {
    const fixture = virtualIo()
    const crypto = fakeCrypto()
    await createBucklerSessionStore({ io: fixture.io, crypto }).save(JSON.stringify(state()), 'capture')
    const previous = Buffer.from(fixture.files.get(BUCKLER_PRIVATE_SESSION_PATH)!)
    const interrupted = new AbortController()
    let encryptCalls = 0
    const store = createBucklerSessionStore({
      io: { ...fixture.io, writeFile: async (path, bytes, options) => {
        await fixture.io.writeFile(path, bytes, options)
        if (moment === 'staging') interrupted.abort()
      } },
      crypto: { ...crypto, protect: async value => {
        encryptCalls++
        const protectedValue = await crypto.protect(value)
        if (moment === 'encryption') interrupted.abort()
        return protectedValue
      } },
    })
    if (moment === 'before') interrupted.abort()
    await assert.rejects(store.save(JSON.stringify(state('changed-cookie-fixture')), 'capture', interrupted.signal),
      error => safeError(error) && error.code === 'cancelled')
    assert.deepEqual(fixture.files.get(BUCKLER_PRIVATE_SESSION_PATH), previous)
    assert.deepEqual([...fixture.files.keys()], [BUCKLER_PRIVATE_SESSION_PATH])
    assert.equal(encryptCalls, moment === 'before' ? 0 : 1)
  }
})

test('rejects symlink/reparse parents and destination paths on save, load and identity', async () => {
  for (const reparse of [false, true]) {
    for (const unsafe of ['parent', 'destination'] as const) {
      const fixture = virtualIo()
      const store = createBucklerSessionStore({ io: fixture.io, crypto: fakeCrypto() })
      await store.save(JSON.stringify(state()), 'capture')
      const path = unsafe === 'parent' ? fixture.directory : BUCKLER_PRIVATE_SESSION_PATH
      fixture.info.set(path, { ...fixture.info.get(path)!, symbolicLink: !reparse, reparsePoint: reparse })
      await assert.rejects(store.load(), error => safeError(error) && error.code === 'unsafe-path')
      await assert.rejects(store.identity(), error => safeError(error) && error.code === 'unsafe-path')
      await assert.rejects(store.save(JSON.stringify(state()), 'capture'), error => safeError(error) && error.code === 'unsafe-path')
    }
  }
})

test('identity is the current ciphertext digest, changes after capture, and never decrypts state', async () => {
  const fixture = virtualIo()
  const crypto = fakeCrypto()
  let decryptCalls = 0
  const store = createBucklerSessionStore({ io: fixture.io, crypto: {
    ...crypto, unprotect: async value => { decryptCalls++; return crypto.unprotect(value) },
  } })
  await store.save(JSON.stringify(state()), 'capture')
  const first = await store.identity()
  assert.match(first, /^[0-9a-f]{64}$/)
  assert.equal(first, createHash('sha256').update(fixture.files.get(BUCKLER_PRIVATE_SESSION_PATH)!).digest('hex'))
  assert.equal(await store.identity(), first)
  await store.save(JSON.stringify(state('changed-cookie-fixture')), 'capture')
  const second = await store.identity()
  assert.notEqual(second, first)
  assert.equal(decryptCalls, 0)
  assert.deepEqual(JSON.parse(await store.load()), state('changed-cookie-fixture'))
  assert.equal(decryptCalls, 1)
  assert.equal(await store.identity(), second)
})

test('identity refuses missing, oversized, truncated and inconsistent files with sanitized IO errors', async () => {
  const fixture = virtualIo()
  const store = createBucklerSessionStore({ io: fixture.io, crypto: fakeCrypto() })
  await assert.rejects(store.identity(), error => safeError(error) && error.code === 'missing-session')
  await store.save(JSON.stringify(state()), 'capture')
  const original = Buffer.from(fixture.files.get(BUCKLER_PRIVATE_SESSION_PATH)!)
  const info = { ...fixture.info.get(BUCKLER_PRIVATE_SESSION_PATH)! }
  fixture.info.set(BUCKLER_PRIVATE_SESSION_PATH, { ...info, size: BUCKLER_SESSION_SIZE_LIMIT + 1 })
  await assert.rejects(store.identity(), error => safeError(error) && error.code === 'size-limit')
  fixture.info.set(BUCKLER_PRIVATE_SESSION_PATH, info)
  fixture.files.set(BUCKLER_PRIVATE_SESSION_PATH, original.subarray(0, original.length - 1))
  await assert.rejects(store.identity(), error => safeError(error) && error.code === 'crypto-failed')
  fixture.info.set(BUCKLER_PRIVATE_SESSION_PATH, { ...info, size: 8 })
  fixture.files.set(BUCKLER_PRIVATE_SESSION_PATH, original.subarray(0, 8))
  await assert.rejects(store.identity(), error => safeError(error) && error.code === 'crypto-failed')
  fixture.info.set(BUCKLER_PRIVATE_SESSION_PATH, info)
  fixture.files.set(BUCKLER_PRIVATE_SESSION_PATH, original)
  const failedIo = createBucklerSessionStore({ io: { ...fixture.io,
    readFile: async () => { throw new Error(`offline-private-${BUCKLER_PRIVATE_SESSION_PATH}-cookie-fixture`) },
  }, crypto: fakeCrypto() })
  await assert.rejects(failedIo.identity(), error => safeError(error) && error.code === 'io-failed')
})

test('checks only fixed capture metadata and UUID staging paths, rejecting unsafe parents and files', async () => {
  const fixture = virtualIo()
  const store = createBucklerSessionStore({ io: fixture.io, crypto: fakeCrypto() })
  const staged = `${BUCKLER_SESSION_CAPTURE_PATH}.tmp-11111111-1111-4111-8111-111111111111`
  for (const path of [join(fixture.repo, 'outside.json'), `${BUCKLER_SESSION_CAPTURE_PATH}.tmp-invalid`, `${staged}/nested`]) {
    await assert.rejects(store.checkCapturePath(path), error => safeError(error) && error.code === 'unsafe-path')
  }
  assert.equal(fixture.paths.length, 0)
  await assert.rejects(store.checkCapturePath(BUCKLER_SESSION_CAPTURE_PATH), error => safeError(error) && error.code === 'missing-session')
  await store.save(JSON.stringify(state()), 'capture')
  await store.checkCapturePath(BUCKLER_SESSION_CAPTURE_PATH)
  await store.checkCapturePath(staged)
  const regular: BucklerSessionFileInfo = { kind: 'file', symbolicLink: false, reparsePoint: false, size: 1024 }
  for (const path of [BUCKLER_SESSION_CAPTURE_PATH, staged]) {
    fixture.info.set(path, regular)
    await store.checkCapturePath(path)
    for (const unsafe of [{ symbolicLink: true }, { reparsePoint: true }, { kind: 'directory' as const }]) {
      fixture.info.set(path, { ...regular, ...unsafe })
      await assert.rejects(store.checkCapturePath(path), error => safeError(error) && error.code === 'unsafe-path')
    }
    fixture.info.set(path, { ...regular, size: 1025 })
    await assert.rejects(store.checkCapturePath(path), error => safeError(error) && error.code === 'size-limit')
    fixture.info.set(path, regular)
  }
  fixture.info.set(fixture.directory, { ...fixture.info.get(fixture.directory)!, reparsePoint: true })
  await assert.rejects(store.checkCapturePath(BUCKLER_SESSION_CAPTURE_PATH), error => safeError(error) && error.code === 'unsafe-path')
})

test('rejects missing, oversized, corrupted/truncated and decrypted invalid files without falling back to empty state', async () => {
  const fixture = virtualIo()
  const store = createBucklerSessionStore({ io: fixture.io, crypto: fakeCrypto() })
  await assert.rejects(store.load(), error => safeError(error) && error.code === 'missing-session')
  await store.save(JSON.stringify(state()), 'capture')
  const original = Buffer.from(fixture.files.get(BUCKLER_PRIVATE_SESSION_PATH)!)
  fixture.info.set(BUCKLER_PRIVATE_SESSION_PATH, { ...fixture.info.get(BUCKLER_PRIVATE_SESSION_PATH)!, size: BUCKLER_SESSION_SIZE_LIMIT + 1 })
  await assert.rejects(store.load(), safeError)
  for (const bytes of [original.subarray(0, 8), original.subarray(0, original.length - 10)]) {
    fixture.files.set(BUCKLER_PRIVATE_SESSION_PATH, bytes)
    fixture.info.set(BUCKLER_PRIVATE_SESSION_PATH, { ...fixture.info.get(BUCKLER_PRIVATE_SESSION_PATH)!, size: bytes.length })
    await assert.rejects(store.load(), safeError)
  }
  fixture.files.set(BUCKLER_PRIVATE_SESSION_PATH, original)
  fixture.info.set(BUCKLER_PRIVATE_SESSION_PATH, { ...fixture.info.get(BUCKLER_PRIVATE_SESSION_PATH)!, size: original.length })
  const invalidStore = createBucklerSessionStore({ io: fixture.io, crypto: { ...fakeCrypto(), unprotect: async () => '{offline-private-invalid' } })
  await assert.rejects(invalidStore.load(), safeError)
})

test('protect/IO failures retain the previous ciphertext and do not propagate raw secrets or private paths', async () => {
  const fixture = virtualIo()
  const crypto = fakeCrypto()
  const store = createBucklerSessionStore({ io: fixture.io, crypto })
  await store.save(JSON.stringify(state()), 'capture')
  const original = Buffer.from(fixture.files.get(BUCKLER_PRIVATE_SESSION_PATH)!)
  const failedCrypto = createBucklerSessionStore({ io: fixture.io, crypto: { ...crypto, protect: async () => { throw new Error('offline-private-crypto') } } })
  await assert.rejects(failedCrypto.save(JSON.stringify(state('changed')), 'capture'), safeError)
  assert.ok(fixture.files.get(BUCKLER_PRIVATE_SESSION_PATH)!.equals(original))
  const failedIo = createBucklerSessionStore({ io: { ...fixture.io, rename: async () => { throw new Error(`offline-private-${BUCKLER_PRIVATE_SESSION_PATH}`) } }, crypto })
  await assert.rejects(failedIo.save(JSON.stringify(state('changed')), 'capture'), safeError)
  assert.deepEqual([...fixture.files.keys()], [BUCKLER_PRIVATE_SESSION_PATH])
  assert.ok(fixture.files.get(BUCKLER_PRIVATE_SESSION_PATH)!.equals(original))
})
