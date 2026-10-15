import assert from 'node:assert/strict'
import { dirname } from 'node:path'
import test from 'node:test'
import { BUCKLER_SESSION_CAPTURE_PATH } from './lib/buckler-session-store.ts'
import {
  BUCKLER_CLOUD_RECEIPT_PATH, BUCKLER_CLOUD_REPOSITORY, BUCKLER_CLOUD_SECRET, BUCKLER_CLOUD_SECRET_LIMIT,
  BucklerCloudSendError, cloudSecretArguments, cloudSecretEnvironment, main, parseCloudSendArguments,
} from './send-buckler-cloud-session.ts'
import type { CloudSendDependencies, CloudSessionFileInfo, CloudSessionIo } from './send-buckler-cloud-session.ts'

const PRIVATE = 'offline-private-cookie-fixture'
const DATE = '2026-10-15T08:00:00.000Z'
const IDENTITY = 'a'.repeat(64)
const capture = { schemaVersion: 1, capturedAt: DATE, processId: 1234,
  launchId: '01234567-89ab-4def-8123-456789abcdef', stateIdentity: IDENTITY }
const receipt = { repository: BUCKLER_CLOUD_REPOSITORY, secret: BUCKLER_CLOUD_SECRET, uploadedAt: DATE }
function state(value = PRIVATE): string {
  return JSON.stringify({ cookies: [{ name: 'session', value, domain: '.streetfighter.com', path: '/', expires: -1,
    httpOnly: true, secure: true, sameSite: 'Lax' }], origins: [] })
}

function fixture() {
  const files = new Map<string, Buffer>()
  const info = new Map<string, CloudSessionFileInfo>()
  const writes: Array<{ path: string; bytes: Buffer }> = []
  const output: string[] = []
  const calls: Array<{ operation: string; input?: string }> = []
  const order: string[] = []
  let identities = [IDENTITY, IDENTITY]
  let plaintext = state()
  let loads = 0
  let consent = 'UPLOAD'
  let secretExists = false
  let setFailure = false
  let deleteFailure = false
  let listFailure = false
  let writeFailure = false
  let linkFailure = false
  const directory = dirname(BUCKLER_CLOUD_RECEIPT_PATH)
  const root = dirname(dirname(directory))
  for (let path = root; ; path = dirname(path)) {
    info.set(path, { kind: 'directory', symbolicLink: false, reparsePoint: false, size: 0 })
    if (path === dirname(path)) break
  }
  function addFile(path: string, value: string) {
    const bytes = Buffer.from(value)
    files.set(path, bytes)
    info.set(path, { kind: 'file', symbolicLink: false, reparsePoint: false, size: bytes.length })
  }
  for (const path of [dirname(directory), directory, dirname(BUCKLER_SESSION_CAPTURE_PATH)]) {
    info.set(path, { kind: 'directory', symbolicLink: false, reparsePoint: false, size: 0 })
  }
  addFile(BUCKLER_SESSION_CAPTURE_PATH, JSON.stringify(capture))
  const io: CloudSessionIo = {
    inspect: async path => info.get(path) ?? null,
    mkdir: async path => { info.set(path, { kind: 'directory', symbolicLink: false, reparsePoint: false, size: 0 }) },
    readBounded: async (path, limit) => {
      const bytes = files.get(path)
      if (!bytes || bytes.length > limit) throw new Error(PRIVATE)
      return Buffer.from(bytes)
    },
    writeExclusive: async (path, bytes) => {
      if (writeFailure || info.has(path)) throw new Error(PRIVATE)
      const copy = Buffer.from(bytes)
      writes.push({ path, bytes: copy }); addFile(path, copy.toString('utf8'))
    },
    linkExclusive: async (from, to) => {
      if (linkFailure || info.has(to)) throw new Error(PRIVATE)
      const bytes = files.get(from)
      if (!bytes) throw new Error(PRIVATE)
      addFile(to, bytes.toString('utf8'))
    },
    unlink: async path => { info.delete(path); files.delete(path) },
  }
  const dependencies: CloudSendDependencies = {
    io, isTTY: true, now: () => new Date(DATE), write: value => { output.push(value) },
    confirm: async () => { order.push('consent'); return consent },
    store: {
      checkCapturePath: async path => { order.push('capture-check'); assert.equal(path, BUCKLER_SESSION_CAPTURE_PATH) },
      identity: async () => { order.push('identity'); return identities.shift() ?? IDENTITY },
      load: async () => { order.push('decrypt'); loads++; return plaintext },
    },
    runGh: async (operation, input) => {
      calls.push({ operation, input }); order.push(`gh-${operation}`)
      if (operation === 'list') {
        if (listFailure) throw new Error(PRIVATE)
        return JSON.stringify(secretExists ? [{ name: BUCKLER_CLOUD_SECRET }] : [])
      }
      if (operation === 'set') {
        // Even an uncertain remote failure can occur after the server accepted it.
        secretExists = true
        if (setFailure) throw new Error(PRIVATE)
        return PRIVATE
      }
      if (deleteFailure) throw new Error(PRIVATE)
      secretExists = false
      return PRIVATE
    },
  }
  return { dependencies, files, info, writes, output, calls, order, root, directory, addFile,
    get loads() { return loads }, get secretExists() { return secretExists },
    set consent(value: string) { consent = value },
    set identities(value: string[]) { identities = value }, set plaintext(value: string) { plaintext = value },
    set secretExists(value: boolean) { secretExists = value }, set setFailure(value: boolean) { setFailure = value },
    set deleteFailure(value: boolean) { deleteFailure = value }, set listFailure(value: boolean) { listFailure = value },
    set writeFailure(value: boolean) { writeFailure = value }, set linkFailure(value: boolean) { linkFailure = value },
  }
}

function safe(code?: string) {
  return (error: unknown) => {
    assert.ok(error instanceof BucklerCloudSendError)
    if (code) assert.equal(error.code, code)
    assert.ok(!error.message.includes(PRIVATE))
    return true
  }
}

test('allows exactly one fixed operation and refuses arbitrary repositories, paths, names and duplicate flags', () => {
  for (const mode of ['upload', 'cleanup', 'help'] as const) assert.equal(parseCloudSendArguments([`--${mode}`]), mode)
  for (const args of [[], ['--upload', '--cleanup'], ['--upload', '--upload'], ['--upload', '--repo', 'other/repo'],
    ['--cleanup', '--secret', 'OTHER'], ['--upload', '--file', PRIVATE], ['--UPLOAD']]) {
    assert.throws(() => parseCloudSendArguments(args), safe('arguments'))
  }
})

test('help and invalid arguments never inspect, decrypt or contact GitHub', async () => {
  const f = fixture()
  await main(['--help'], f.dependencies)
  await assert.rejects(main(['--upload', PRIVATE], f.dependencies), safe('arguments'))
  assert.equal(f.loads, 0); assert.deepEqual(f.calls, []); assert.deepEqual(f.order, [])
  assert.match(f.output[0], /公開リポジトリ gonchiman\/sf6/)
  assert.match(f.output[0], /ローカル保存時の同意とは別/)
})

test('noninteractive or declined upload never decrypts or sends authentication', async () => {
  for (const answer of ['ABORT', '', 'upload']) {
    const f = fixture(); f.consent = answer
    await assert.rejects(main(['--upload'], f.dependencies), safe('cancelled'))
    assert.equal(f.loads, 0); assert.deepEqual(f.calls, []); assert.deepEqual(f.writes, [])
  }
  const f = fixture(); f.dependencies.isTTY = false
  await assert.rejects(main(['--upload'], f.dependencies), safe('interactive'))
  assert.equal(f.loads, 0); assert.deepEqual(f.order, [])
})

test('consent timeout or a raw confirmation failure is sanitized before any operation', async () => {
  const f = fixture(); f.dependencies.confirm = async () => { throw new Error(PRIVATE) }
  await assert.rejects(main(['--upload'], f.dependencies), safe('cancelled'))
  assert.equal(f.loads, 0); assert.deepEqual(f.calls, [])
})

test('uploads only validated in-memory JSON after consent and matching identities, with no secret in output or files', async () => {
  const f = fixture()
  await main(['--upload'], f.dependencies)
  assert.equal(f.loads, 1); assert.equal(f.secretExists, true)
  assert.deepEqual(f.calls.map(call => call.operation), ['list', 'set'])
  assert.equal(f.calls[1].input, state())
  assert.ok(f.order.indexOf('consent') < f.order.indexOf('decrypt'))
  assert.ok(f.order.indexOf('decrypt') < f.order.indexOf('gh-set'))
  assert.equal(f.order.filter(value => value === 'identity').length, 2)
  assert.deepEqual(JSON.parse(f.files.get(BUCKLER_CLOUD_RECEIPT_PATH)!.toString('utf8')), receipt)
  for (const write of f.writes) { assert.ok(!write.bytes.includes(Buffer.from(PRIVATE))); assert.ok(write.path.startsWith(BUCKLER_CLOUD_RECEIPT_PATH + '.tmp-')) }
  assert.ok(!f.output.join('\n').includes(PRIVATE))
  assert.ok(![...f.files.keys()].some(path => path.includes('.tmp-')))
})

test('refuses an existing same-name secret before decryption or overwriting', async () => {
  const f = fixture(); f.secretExists = true
  await assert.rejects(main(['--upload'], f.dependencies), safe('existing-secret'))
  assert.equal(f.loads, 0); assert.deepEqual(f.calls.map(call => call.operation), ['list']); assert.deepEqual(f.writes, [])
})

test('refuses an existing receipt before contacting GitHub, protecting prior ownership', async () => {
  const f = fixture(); f.addFile(BUCKLER_CLOUD_RECEIPT_PATH, JSON.stringify(receipt))
  await assert.rejects(main(['--upload'], f.dependencies), safe('receipt-exists'))
  assert.equal(f.loads, 0); assert.deepEqual(f.calls, [])
})

test('rejects identity mismatches both before and after decryption', async () => {
  for (const [identities, loads] of [[['b'.repeat(64)], 0], [[IDENTITY, 'b'.repeat(64)], 1]] as const) {
    const f = fixture(); f.identities = [...identities]
    await assert.rejects(main(['--upload'], f.dependencies), safe('identity'))
    assert.equal(f.loads, loads); assert.deepEqual(f.calls.map(call => call.operation), ['list']); assert.deepEqual(f.writes, [])
  }
})

test('rejects untrusted capture metadata, non-files, links and oversized reads without loading a session', async () => {
  for (const mutation of ['invalid-json', 'other-origin', 'oversized', 'symlink', 'reparse', 'directory']) {
    const f = fixture()
    if (mutation === 'invalid-json') f.addFile(BUCKLER_SESSION_CAPTURE_PATH, PRIVATE)
    if (mutation === 'other-origin') f.addFile(BUCKLER_SESSION_CAPTURE_PATH, JSON.stringify({ ...capture, repository: 'other/repo' }))
    if (mutation === 'oversized') f.addFile(BUCKLER_SESSION_CAPTURE_PATH, 'x'.repeat(1025))
    const info = f.info.get(BUCKLER_SESSION_CAPTURE_PATH)!
    if (mutation === 'symlink') info.symbolicLink = true
    if (mutation === 'reparse') info.reparsePoint = true
    if (mutation === 'directory') info.kind = 'directory'
    await assert.rejects(main(['--upload'], f.dependencies), safe('capture'))
    assert.equal(f.loads, 0); assert.ok(!f.calls.some(call => call.operation === 'set'))
  }
})

test('rejects other-site state and malformed plaintext without displaying it', async () => {
  const f = fixture(); f.plaintext = state().replace('.streetfighter.com', '.capcom.com')
  await assert.rejects(main(['--upload'], f.dependencies), safe('state'))
  assert.ok(!f.calls.some(call => call.operation === 'set')); assert.ok(!f.output.join('\n').includes(PRIVATE))
})

test('enforces the byte limit strictly below 48KiB, including multibyte values', async () => {
  const base = Buffer.byteLength(state(''))
  const exactly = fixture(); exactly.plaintext = state('a'.repeat(BUCKLER_CLOUD_SECRET_LIMIT - base))
  await assert.rejects(main(['--upload'], exactly.dependencies), safe('size'))
  assert.ok(!exactly.calls.some(call => call.operation === 'set'))
  const below = fixture(); below.plaintext = state('a'.repeat(BUCKLER_CLOUD_SECRET_LIMIT - base - 1))
  await main(['--upload'], below.dependencies)
  assert.equal(Buffer.byteLength(below.calls.find(call => call.operation === 'set')!.input!), BUCKLER_CLOUD_SECRET_LIMIT - 1)
  const unicode = fixture(); unicode.plaintext = state('あ'.repeat(Math.ceil(BUCKLER_CLOUD_SECRET_LIMIT / 3)))
  await assert.rejects(main(['--upload'], unicode.dependencies), safe('size'))
})

test('refuses unsafe receipt ancestors and destination links before any transfer', async () => {
  for (const path of [fillerRoot(), dirname(BUCKLER_CLOUD_RECEIPT_PATH), BUCKLER_CLOUD_RECEIPT_PATH]) {
    const f = fixture()
    f.info.set(path, { kind: path === BUCKLER_CLOUD_RECEIPT_PATH ? 'file' : 'directory', size: 1, symbolicLink: false, reparsePoint: true })
    await assert.rejects(main(['--upload'], f.dependencies), safe('path'))
    assert.equal(f.loads, 0); assert.deepEqual(f.calls, [])
  }
  function fillerRoot() { return dirname(dirname(dirname(BUCKLER_CLOUD_RECEIPT_PATH))) }
})

test('receipt staging or atomic-publication failure prevents transfer and removes only staging metadata', async () => {
  for (const kind of ['write', 'link']) {
    const f = fixture()
    if (kind === 'write') f.writeFailure = true
    else f.linkFailure = true
    await assert.rejects(main(['--upload'], f.dependencies), safe('path'))
    assert.ok(!f.calls.some(call => call.operation === 'set'))
    assert.ok(!f.files.has(BUCKLER_CLOUD_RECEIPT_PATH))
    assert.ok(![...f.files.keys()].some(path => path.includes('.tmp-')))
  }
})

test('an uncertain upload failure deletes only the fixed newly-created secret and its receipt', async () => {
  const f = fixture(); f.setFailure = true
  await assert.rejects(main(['--upload'], f.dependencies), safe('upload'))
  assert.deepEqual(f.calls.map(call => call.operation), ['list', 'set', 'list', 'delete', 'list'])
  assert.equal(f.secretExists, false); assert.ok(!f.files.has(BUCKLER_CLOUD_RECEIPT_PATH))
  assert.ok(!f.output.join('\n').includes(PRIVATE))
})

test('failed rollback retains safe receipt for a later cleanup attempt', async () => {
  const f = fixture(); f.setFailure = true; f.deleteFailure = true
  await assert.rejects(main(['--upload'], f.dependencies), safe('cleanup-needed'))
  assert.equal(f.secretExists, true); assert.ok(f.files.has(BUCKLER_CLOUD_RECEIPT_PATH))
  f.deleteFailure = false
  await main(['--cleanup'], f.dependencies)
  assert.equal(f.secretExists, false); assert.ok(!f.files.has(BUCKLER_CLOUD_RECEIPT_PATH)); assert.equal(f.loads, 1)
})

test('cleanup requires a matching fixed receipt and never decrypts or targets another secret', async () => {
  const missing = fixture()
  await assert.rejects(main(['--cleanup'], missing.dependencies), safe('receipt-missing'))
  assert.deepEqual(missing.calls, []); assert.equal(missing.loads, 0)
  for (const value of [{ ...receipt, repository: 'other/repo' }, { ...receipt, secret: 'OTHER_SECRET' },
    { ...receipt, uploadedAt: '2026-02-30T08:00:00.000Z' }, { ...receipt, private: PRIVATE }]) {
    const f = fixture(); f.addFile(BUCKLER_CLOUD_RECEIPT_PATH, JSON.stringify(value))
    await assert.rejects(main(['--cleanup'], f.dependencies), safe('receipt-invalid'))
    assert.deepEqual(f.calls, []); assert.equal(f.loads, 0)
  }
  const f = fixture(); f.addFile(BUCKLER_CLOUD_RECEIPT_PATH, JSON.stringify(receipt)); f.secretExists = true
  await main(['--cleanup'], f.dependencies)
  assert.deepEqual(f.calls.map(call => call.operation), ['list', 'delete', 'list'])
  assert.ok(f.calls.every(call => call.input === undefined)); assert.equal(f.loads, 0)
})

test('cleanup after an interrupted pre-send attempt removes metadata when secret is absent', async () => {
  const f = fixture(); f.addFile(BUCKLER_CLOUD_RECEIPT_PATH, JSON.stringify(receipt))
  await main(['--cleanup'], f.dependencies)
  assert.deepEqual(f.calls.map(call => call.operation), ['list'])
  assert.ok(!f.files.has(BUCKLER_CLOUD_RECEIPT_PATH)); assert.equal(f.loads, 0)
})

test('raw GitHub failures or malformed list output never reach logs and never trigger a send', async () => {
  for (const listing of [null, PRIVATE, '{"name":"OTHER"}', '[{"name":"OTHER","private":"secret"}]']) {
    const f = fixture()
    if (listing === null) f.listFailure = true
    else f.dependencies.runGh = async () => listing
    await assert.rejects(main(['--upload'], f.dependencies), safe('github'))
    assert.equal(f.loads, 0); assert.ok(!f.output.join('\n').includes(PRIVATE))
  }
})

test('gh arguments are fixed and subprocess environment removes debug, Node hooks and custom host', () => {
  assert.deepEqual(cloudSecretArguments('set'), ['secret', 'set', BUCKLER_CLOUD_SECRET, '--repo', BUCKLER_CLOUD_REPOSITORY])
  assert.deepEqual(cloudSecretArguments('delete'), ['secret', 'delete', BUCKLER_CLOUD_SECRET, '--repo', BUCKLER_CLOUD_REPOSITORY])
  assert.deepEqual(cloudSecretArguments('list'), ['secret', 'list', '--repo', BUCKLER_CLOUD_REPOSITORY, '--json', 'name'])
  const env = cloudSecretEnvironment({ PATH: 'system-path', GH_TOKEN: 'offline-auth', GH_HOST: 'other.example', GH_DEBUG: 'api',
    DEBUG: '*', NODE_OPTIONS: '--require=other', NODE_DEBUG: '*', GH_FORCE_TTY: '1', GH_HTTP_UNIX_SOCKET: 'other',
    HTTPS_PROXY: 'https://proxy.example', SYSTEMROOT: 'system-root' })
  assert.equal(env.GH_HOST, 'github.com'); assert.equal(env.GH_TOKEN, 'offline-auth'); assert.equal(env.PATH, 'system-path')
  assert.equal(env.GH_PROMPT_DISABLED, '1')
  for (const name of ['GH_DEBUG', 'DEBUG', 'NODE_OPTIONS', 'NODE_DEBUG', 'GH_FORCE_TTY', 'GH_HTTP_UNIX_SOCKET']) assert.equal(env[name], undefined)
})
