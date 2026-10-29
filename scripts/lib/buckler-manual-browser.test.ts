import assert from 'node:assert/strict'
import { dirname } from 'node:path'
import test from 'node:test'
import {
  BUCKLER_MANUAL_DEBUG_PATH, BUCKLER_MANUAL_LAUNCH_PATH, BUCKLER_MANUAL_LOGIN_PATH, BUCKLER_MANUAL_PROFILE_PATH,
  BUCKLER_MANUAL_PROFILE_RELATIVE_PATH, BucklerManualBrowserError, createManualBrowserController,
  manualEdgeArguments, manualLoginEdgeArguments, parseManualDevToolsPort,
} from './buckler-manual-browser.ts'
import type { ManualBrowserFileInfo, ManualBrowserIo, ManualBrowserProcessIdentity, ManualBrowserRuntime } from './buckler-manual-browser.ts'
import { BUCKLER_AUTH_PROBE_URL } from './buckler-auth-probe.ts'

const BROWSER_ID = '11111111-2222-4333-8444-555555555555'
const PORT_TEXT = `45921\n/devtools/browser/${BROWSER_ID}\n`
const directory = dirname(BUCKLER_MANUAL_LAUNCH_PATH)
function fixture() {
  const files = new Map<string, Buffer>()
  const infos = new Map<string, ManualBrowserFileInfo>()
  const paths: string[] = []; const readPaths: string[] = []
  const launches: string[][] = []
  const closes: number[] = []
  const repo = dirname(dirname(directory))
  for (let path = repo; ; path = dirname(path)) {
    infos.set(path, { kind: 'directory', symbolicLink: false, reparsePoint: false, size: 0 })
    if (path === dirname(path)) break
  }
  function put(path: string, text: string) {
    const bytes = Buffer.from(text)
    files.set(path, bytes)
    infos.set(path, { kind: 'file', symbolicLink: false, reparsePoint: false, size: bytes.length })
  }
  const io: ManualBrowserIo = {
    inspect: async path => { paths.push(path); return infos.get(path) ?? null },
    mkdir: async path => { paths.push(path); infos.set(path, { kind: 'directory', symbolicLink: false, reparsePoint: false, size: 0 }) },
    readFile: async path => { paths.push(path); readPaths.push(path); if (!files.has(path)) throw new Error('private-fixture-read-error'); return Buffer.from(files.get(path)!) },
    writeFile: async (path, bytes) => { paths.push(path); if (files.has(path)) throw new Error('private-fixture-exists'); put(path, Buffer.from(bytes).toString('utf8')) },
    rename: async (from, to) => { paths.push(from, to); files.set(to, files.get(from)!); infos.set(to, infos.get(from)!); files.delete(from); infos.delete(from) },
    unlink: async path => { paths.push(path); files.delete(path); infos.delete(path) },
  }
  let identity: ManualBrowserProcessIdentity | null = null
  let running = false; let listener = true; let debugText: string | null = PORT_TEXT
  const runtime: ManualBrowserRuntime = {
    launch: async (profile, args) => {
      assert.equal(profile, BUCKLER_MANUAL_PROFILE_PATH)
      launches.push([...args])
      const processId = 8171 + launches.length
      identity = { processId, createdAt: new Date(Date.UTC(2026, 9, 14, 12, 0, launches.length)).toISOString(), officialEdge: true, dedicatedProfile: true, browserProcess: true }
      running = true
      if (debugText !== null && args.includes('--remote-debugging-port=0')) put(BUCKLER_MANUAL_DEBUG_PATH, debugText)
      return processId
    },
    inspectProcess: async (_pid, profile) => { assert.equal(profile, BUCKLER_MANUAL_PROFILE_PATH); return identity && { ...identity } },
    hasRunningProfile: async profile => { assert.equal(profile, BUCKLER_MANUAL_PROFILE_PATH); return running },
    ownsLoopbackListener: async (pid, port) => { assert.equal(pid, identity!.processId); assert.equal(port, 45921); return listener },
    closeProcess: async (pid, createdAt, profile) => { assert.equal(pid, identity!.processId); assert.equal(createdAt, identity!.createdAt); assert.equal(profile, BUCKLER_MANUAL_PROFILE_PATH); closes.push(pid); identity = null; running = false },
    sleep: async () => {},
  }
  return { io, runtime, files, infos, paths, readPaths, launches, closes, repo, put,
    controller: () => createManualBrowserController({ io, runtime, platform: 'win32' }),
    setIdentity: (value: ManualBrowserProcessIdentity | null) => { identity = value },
    identity: () => identity!, setRunning: (value: boolean) => { running = value },
    setListener: (value: boolean) => { listener = value }, setDebugText: (value: string | null) => { debugText = value },
  }
}
function safeFailure(code?: string) {
  return (error: unknown) => {
    assert.ok(error instanceof BucklerManualBrowserError)
    if (code) assert.equal(error.code, code)
    assert.ok(!error.message.includes('private-fixture'))
    assert.ok(!error.message.includes(BROWSER_ID))
    assert.ok(!error.message.includes(BUCKLER_MANUAL_PROFILE_PATH))
    return true
  }
}
function modifyRecord(value: ReturnType<typeof fixture>, change: Record<string, unknown>) {
  const record = JSON.parse(value.files.get(BUCKLER_MANUAL_LAUNCH_PATH)!.toString('utf8'))
  value.put(BUCKLER_MANUAL_LAUNCH_PATH, JSON.stringify({ ...record, ...change }))
}

test('normal Edge arguments use only the fixed dedicated profile, ephemeral loopback debugging and fixed official URL', () => {
  assert.deepEqual(manualEdgeArguments(), [`--user-data-dir=${BUCKLER_MANUAL_PROFILE_PATH}`, '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', '--new-window', BUCKLER_AUTH_PROBE_URL])
  assert.ok(!manualEdgeArguments().some(value => /enable-automation|disable-blink|user-agent|headless|proxy/i.test(value)))
})

test('launch, attach and close verify the same browser while retaining all browser-managed profile data', async () => {
  const value = fixture(); const controller = value.controller()
  const launch = await controller.prepareManualBrowser()
  assert.equal(launch.processId, 8172)
  assert.equal(launch.profilePath, BUCKLER_MANUAL_PROFILE_RELATIVE_PATH)
  assert.equal(Object.hasOwn(launch, 'port'), false)
  assert.equal(Object.hasOwn(launch, 'browserId'), false)
  assert.equal(value.launches.length, 1)
  const endpoint = await controller.readManualBrowserEndpoint()
  assert.equal(endpoint.endpointURL, `ws://127.0.0.1:45921/devtools/browser/${BROWSER_ID}`)
  assert.deepEqual(endpoint.launch, launch)
  const privateFile = BUCKLER_MANUAL_PROFILE_PATH + '/browser-managed-cookie-fixture'
  value.put(privateFile, 'offline-opaque-profile-fixture')
  await controller.closeManualBrowser()
  assert.deepEqual(value.closes, [8172])
  assert.ok(value.infos.has(BUCKLER_MANUAL_PROFILE_PATH))
  assert.ok(value.files.has(privateFile))
  assert.equal(value.files.has(BUCKLER_MANUAL_DEBUG_PATH), false)
  assert.equal(value.files.has(BUCKLER_MANUAL_LAUNCH_PATH), false)
  assert.ok(value.readPaths.every(path => [BUCKLER_MANUAL_DEBUG_PATH, BUCKLER_MANUAL_LAUNCH_PATH].includes(path) || path.endsWith('manual-browser-launch.lock')))
  assert.ok(!value.paths.includes(privateFile))
})

test('rejects existing debugging metadata or a live dedicated browser before starting another process', async () => {
  for (const existing of [BUCKLER_MANUAL_DEBUG_PATH, BUCKLER_MANUAL_LAUNCH_PATH, 'manual-browser-launch.lock']) {
    const value = fixture()
    // Let the helper create the directory hierarchy, then simulate a previous owned launch.
    await value.controller().prepareManualBrowser()
    await value.controller().closeManualBrowser()
    value.launches.length = 0
    value.put(existing === 'manual-browser-launch.lock' ? resolveLock() : existing, 'offline-stale-record')
    await assert.rejects(value.controller().prepareManualBrowser(), safeFailure('already-open'))
    assert.equal(value.launches.length, 0)
  }
  const value = fixture(); value.setRunning(true)
  await assert.rejects(value.controller().prepareManualBrowser(), safeFailure('already-open'))
  assert.equal(value.launches.length, 0)
})
function resolveLock() { return BUCKLER_MANUAL_LAUNCH_PATH.replace(/manual-browser-launch\.json$/, 'manual-browser-launch.lock') }

test('rejects symlinks and reparse points in ancestors, profile and metadata without reading any target', async () => {
  for (const path of [BUCKLER_MANUAL_PROFILE_PATH, directory, dirname(directory), dirname(dirname(directory))]) {
    for (const property of ['symbolicLink', 'reparsePoint'] as const) {
      const value = fixture()
      value.infos.set(path, { kind: 'directory', symbolicLink: false, reparsePoint: false, size: 0, [property]: true })
      await assert.rejects(value.controller().prepareManualBrowser(), safeFailure('unsafe-path'))
      assert.equal(value.launches.length, 0)
      assert.equal(value.readPaths.length, 0)
    }
  }
  for (const path of [BUCKLER_MANUAL_DEBUG_PATH, BUCKLER_MANUAL_LAUNCH_PATH]) {
    const value = fixture(); await value.controller().prepareManualBrowser()
    value.infos.set(path, { ...value.infos.get(path)!, reparsePoint: true })
    await assert.rejects(value.controller().readManualBrowserEndpoint(), safeFailure('unsafe-path'))
    await assert.rejects(value.controller().closeManualBrowser(), safeFailure('unsafe-path'))
    assert.equal(value.closes.length, 0)
  }
})

test('strict two-line DevTools record cannot supply a general endpoint, foreign hostname, query, malformed port or extra content', () => {
  assert.deepEqual(parseManualDevToolsPort(Buffer.from(PORT_TEXT)), { port: 45921, browserId: BROWSER_ID })
  for (const text of ['0\n/devtools/browser/' + BROWSER_ID, '65536\n/devtools/browser/' + BROWSER_ID,
    '45921\nws://evil.example/devtools/browser/' + BROWSER_ID, PORT_TEXT + 'private-fixture-extra',
    '45921\n/devtools/browser/' + BROWSER_ID + '?private-fixture-query', '045921\n/devtools/browser/' + BROWSER_ID,
    '45921\n/devtools/browser/not-a-uuid']) {
    assert.throws(() => parseManualDevToolsPort(Buffer.from(text)), safeFailure('identity-mismatch'))
  }
})

test('attach and close reject changed browser token, tampered metadata or a listener not owned exclusively on loopback', async () => {
  for (const mutate of [
    (value: ReturnType<typeof fixture>) => value.put(BUCKLER_MANUAL_DEBUG_PATH, PORT_TEXT.replace(BROWSER_ID, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee')),
    (value: ReturnType<typeof fixture>) => modifyRecord(value, { profilePath: 'C:/Users/other/normal-profile' }),
    (value: ReturnType<typeof fixture>) => modifyRecord(value, { secret: 'private-fixture-secret' }),
    (value: ReturnType<typeof fixture>) => value.setListener(false),
  ]) {
    const value = fixture(); await value.controller().prepareManualBrowser(); mutate(value)
    await assert.rejects(value.controller().readManualBrowserEndpoint(), safeFailure('identity-mismatch'))
    await assert.rejects(value.controller().closeManualBrowser(), safeFailure('identity-mismatch'))
    assert.equal(value.closes.length, 0)
  }
})

test('PID reuse, ordinary Edge profile, browser subprocess or unofficial executable cannot be connected to or closed', async () => {
  for (const change of [{ createdAt: '2026-10-14T12:01:00.000Z' }, { dedicatedProfile: false },
    { officialEdge: false }, { browserProcess: false }, { processId: 8173 }]) {
    const value = fixture(); await value.controller().prepareManualBrowser()
    value.setIdentity({ ...value.identity(), ...change })
    await assert.rejects(value.controller().readManualBrowserEndpoint(), safeFailure('identity-mismatch'))
    await assert.rejects(value.controller().closeManualBrowser(), safeFailure('identity-mismatch'))
    assert.equal(value.closes.length, 0)
  }
})

test('manual window exit permits cleanup of the matching debug metadata without touching another process', async () => {
  const value = fixture(); await value.controller().prepareManualBrowser()
  value.setIdentity(null); value.setRunning(false); value.setListener(false)
  await assert.rejects(value.controller().readManualBrowserEndpoint(), safeFailure('missing-browser'))
  await value.controller().closeManualBrowser()
  assert.deepEqual(value.closes, [])
  assert.equal(value.files.has(BUCKLER_MANUAL_LAUNCH_PATH), false)
  assert.equal(value.files.has(BUCKLER_MANUAL_DEBUG_PATH), false)
})

test('missing debug readiness fails without saving launch metadata or reading browser-managed profile files', async () => {
  const value = fixture(); value.setDebugText(null)
  await assert.rejects(value.controller().prepareManualBrowser(), safeFailure('launch-failed'))
  assert.equal(value.files.has(BUCKLER_MANUAL_LAUNCH_PATH), false)
  assert.ok(value.readPaths.every(path => path.endsWith('manual-browser-launch.lock')))
  assert.deepEqual(value.closes, [8172])
})

test('metadata staging failure safely closes its already identified process and removes only matching debug metadata', async () => {
  const value = fixture()
  const originalWrite = value.io.writeFile
  value.io.writeFile = async (path, bytes) => {
    if (path.includes('manual-browser-launch.json.tmp-')) throw new Error('private-fixture-staging-error')
    await originalWrite(path, bytes)
  }
  await assert.rejects(value.controller().prepareManualBrowser(), safeFailure('io-failed'))
  assert.deepEqual(value.closes, [8172])
  assert.equal(value.files.has(BUCKLER_MANUAL_DEBUG_PATH), false)
  assert.equal(value.files.has(BUCKLER_MANUAL_LAUNCH_PATH), false)
  assert.ok(value.infos.has(BUCKLER_MANUAL_PROFILE_PATH))
})

test('failed listener verification closes its identified Edge and cleans matching metadata after the profile is no longer running', async () => {
  const value = fixture(); value.setListener(false)
  await assert.rejects(value.controller().prepareManualBrowser(), safeFailure('identity-mismatch'))
  assert.deepEqual(value.closes, [8172])
  assert.equal(value.files.has(BUCKLER_MANUAL_DEBUG_PATH), false)
  assert.equal(value.files.has(BUCKLER_MANUAL_LAUNCH_PATH), false)
  value.setListener(true)
  await value.controller().prepareManualBrowser()
  assert.equal(value.launches.length, 2)
})

test('browser automatically removing DevToolsActivePort on exit still permits safe launcher metadata cleanup', async () => {
  const value = fixture(); await value.controller().prepareManualBrowser()
  const originalClose = value.runtime.closeProcess
  value.runtime.closeProcess = async (pid, createdAt, profile) => {
    await originalClose(pid, createdAt, profile)
    value.files.delete(BUCKLER_MANUAL_DEBUG_PATH); value.infos.delete(BUCKLER_MANUAL_DEBUG_PATH)
  }
  await value.controller().closeManualBrowser()
  assert.equal(value.files.has(BUCKLER_MANUAL_LAUNCH_PATH), false)
  assert.deepEqual(value.closes, [8172])
})

test('metadata unlink failure after successful close can be retried without the debug file and without killing another process', async () => {
  const value = fixture(); await value.controller().prepareManualBrowser()
  const originalUnlink = value.io.unlink
  let failOnce = true
  value.io.unlink = async path => {
    if (path === BUCKLER_MANUAL_LAUNCH_PATH && failOnce) { failOnce = false; throw new Error('private-fixture-unlink-error') }
    await originalUnlink(path)
  }
  await assert.rejects(value.controller().closeManualBrowser(), safeFailure('io-failed'))
  assert.equal(value.files.has(BUCKLER_MANUAL_DEBUG_PATH), false)
  assert.equal(value.files.has(BUCKLER_MANUAL_LAUNCH_PATH), true)
  await value.controller().closeManualBrowser()
  assert.equal(value.files.has(BUCKLER_MANUAL_LAUNCH_PATH), false)
  assert.deepEqual(value.closes, [8172])
})

test('partial startup never kills a process whose creation time or profile changes before cleanup', async () => {
  const value = fixture(); value.setDebugText(null)
  value.runtime.sleep = async () => { value.setIdentity({ ...value.identity(), dedicatedProfile: false }) }
  await assert.rejects(value.controller().prepareManualBrowser(), safeFailure('launch-failed'))
  assert.deepEqual(value.closes, [])
})

test('unsupported platforms and injected OS errors fail with fixed messages and no partial metadata', async () => {
  const value = fixture()
  await assert.rejects(createManualBrowserController({ io: value.io, runtime: value.runtime, platform: 'linux' }).prepareManualBrowser(), safeFailure('unsupported-platform'))
  assert.equal(value.paths.length, 0)
  value.runtime.launch = async () => { throw new Error('private-fixture-os-error') }
  await assert.rejects(value.controller().prepareManualBrowser(), safeFailure('io-failed'))
  assert.equal(value.files.has(BUCKLER_MANUAL_LAUNCH_PATH), false)
})

test('login-only Edge has no debugging flags and only its fixed launch record is read on close', async () => {
  const value = fixture(); const controller = value.controller()
  assert.deepEqual(manualLoginEdgeArguments(), [`--user-data-dir=${BUCKLER_MANUAL_PROFILE_PATH}`, '--new-window', BUCKLER_AUTH_PROBE_URL])
  assert.ok(!manualLoginEdgeArguments().some(argument => /debug|automation|user-agent|headless|proxy/i.test(argument)))
  const launch = await controller.prepareManualLoginBrowser()
  assert.equal(launch.processId, 8172)
  const record = JSON.parse(value.files.get(BUCKLER_MANUAL_LOGIN_PATH)!.toString())
  assert.deepEqual(Object.keys(record).sort(), ['launchId', 'processCreatedAt', 'processId', 'profilePath', 'schemaVersion', 'startedAt'])
  assert.equal(value.files.has(BUCKLER_MANUAL_DEBUG_PATH), false)
  assert.equal(value.files.has(BUCKLER_MANUAL_LAUNCH_PATH), false)
  assert.ok(value.readPaths.every(path => path.endsWith('manual-browser-launch.lock')))
  const opaqueProfile = BUCKLER_MANUAL_PROFILE_PATH + '/browser-managed-cookie-fixture'
  value.put(opaqueProfile, 'offline-opaque-profile-fixture')
  await controller.closeManualLoginBrowser()
  assert.deepEqual(value.closes, [8172])
  assert.equal(value.files.has(BUCKLER_MANUAL_LOGIN_PATH), false)
  assert.ok(value.files.has(opaqueProfile))
  assert.ok(value.readPaths.every(path => path === BUCKLER_MANUAL_LOGIN_PATH || path.endsWith('manual-browser-launch.lock')))
})

test('capture restart closes exactly the plain process and reuses the same profile in a new verified debug process', async () => {
  const value = fixture(); const controller = value.controller()
  const initial = await controller.prepareManualLoginBrowser()
  const opaqueProfile = BUCKLER_MANUAL_PROFILE_PATH + '/browser-managed-cookie-fixture'
  value.put(opaqueProfile, 'offline-opaque-profile-fixture')
  const captured = await controller.restartManualBrowserForCapture()
  assert.deepEqual(value.closes, [initial.processId])
  assert.equal(captured.processId, 8173)
  assert.notEqual(captured.launchId, initial.launchId)
  assert.notEqual(captured.processCreatedAt, initial.processCreatedAt)
  assert.equal(captured.profilePath, initial.profilePath)
  assert.deepEqual(value.launches, [manualLoginEdgeArguments(), manualEdgeArguments()])
  assert.equal(value.files.has(BUCKLER_MANUAL_LOGIN_PATH), false)
  assert.ok(value.files.has(BUCKLER_MANUAL_LAUNCH_PATH))
  assert.ok(value.files.has(opaqueProfile))
  assert.ok(!value.paths.includes(opaqueProfile))
  assert.equal((await controller.readManualBrowserEndpoint()).launch.processId, captured.processId)
})

test('login and debug launches are mutually exclusive and cannot use each other’s close or capture operations', async () => {
  const plain = fixture(); await plain.controller().prepareManualLoginBrowser()
  await assert.rejects(plain.controller().prepareManualBrowser(), safeFailure('already-open'))
  await assert.rejects(plain.controller().prepareManualLoginBrowser(), safeFailure('already-open'))
  await assert.rejects(plain.controller().readManualBrowserEndpoint(), safeFailure('already-open'))
  await assert.rejects(plain.controller().closeManualBrowser(), safeFailure('already-open'))
  assert.equal(plain.launches.length, 1)
  assert.deepEqual(plain.closes, [])
  const debug = fixture(); await debug.controller().prepareManualBrowser()
  await assert.rejects(debug.controller().prepareManualLoginBrowser(), safeFailure('already-open'))
  await assert.rejects(debug.controller().closeManualLoginBrowser(), safeFailure('already-open'))
  await assert.rejects(debug.controller().restartManualBrowserForCapture(), safeFailure('already-open'))
  assert.equal(debug.launches.length, 1)
  assert.deepEqual(debug.closes, [])
})

test('plain metadata tampering, PID reuse, ordinary profile and unsigned Edge prevent close and restart', async () => {
  for (const mutate of [
    (value: ReturnType<typeof fixture>) => {
      const record = JSON.parse(value.files.get(BUCKLER_MANUAL_LOGIN_PATH)!.toString())
      value.put(BUCKLER_MANUAL_LOGIN_PATH, JSON.stringify({ ...record, profilePath: 'other-profile' }))
    },
    (value: ReturnType<typeof fixture>) => {
      const record = JSON.parse(value.files.get(BUCKLER_MANUAL_LOGIN_PATH)!.toString())
      value.put(BUCKLER_MANUAL_LOGIN_PATH, JSON.stringify({ ...record, extra: 'private-fixture-secret' }))
    },
    (value: ReturnType<typeof fixture>) => value.setIdentity({ ...value.identity(), createdAt: '2026-10-14T13:00:00.000Z' }),
    (value: ReturnType<typeof fixture>) => value.setIdentity({ ...value.identity(), dedicatedProfile: false }),
    (value: ReturnType<typeof fixture>) => value.setIdentity({ ...value.identity(), officialEdge: false }),
  ]) {
    const value = fixture(); await value.controller().prepareManualLoginBrowser(); mutate(value)
    await assert.rejects(value.controller().closeManualLoginBrowser(), safeFailure('identity-mismatch'))
    await assert.rejects(value.controller().restartManualBrowserForCapture(), safeFailure('identity-mismatch'))
    assert.deepEqual(value.closes, [])
    assert.equal(value.launches.length, 1)
    assert.ok(!value.readPaths.includes(BUCKLER_MANUAL_DEBUG_PATH))
  }
})

test('plain metadata links are refused before reading their target or closing any process', async () => {
  const value = fixture(); await value.controller().prepareManualLoginBrowser()
  const readsBefore = value.readPaths.length
  value.infos.set(BUCKLER_MANUAL_LOGIN_PATH, { ...value.infos.get(BUCKLER_MANUAL_LOGIN_PATH)!, reparsePoint: true })
  await assert.rejects(value.controller().closeManualLoginBrowser(), safeFailure('unsafe-path'))
  await assert.rejects(value.controller().restartManualBrowserForCapture(), safeFailure('unsafe-path'))
  assert.equal(value.readPaths.length, readsBefore)
  assert.deepEqual(value.closes, [])
})

test('plain startup staging failure closes only its own process without reading debug or profile contents', async () => {
  const value = fixture(); const originalWrite = value.io.writeFile
  value.io.writeFile = async (path, bytes) => {
    if (path.includes('manual-browser-login.json.tmp-')) throw new Error('private-fixture-staging-error')
    await originalWrite(path, bytes)
  }
  await assert.rejects(value.controller().prepareManualLoginBrowser(), safeFailure('io-failed'))
  assert.deepEqual(value.closes, [8172])
  assert.equal(value.files.has(BUCKLER_MANUAL_LOGIN_PATH), false)
  assert.ok(value.readPaths.every(path => path.endsWith('manual-browser-launch.lock')))
  assert.ok(value.infos.has(BUCKLER_MANUAL_PROFILE_PATH))
})

test('plain metadata unlink failure can be retried after the user’s dedicated browser has exited', async () => {
  const value = fixture(); await value.controller().prepareManualLoginBrowser()
  const originalUnlink = value.io.unlink; let failOnce = true
  value.io.unlink = async path => {
    if (path === BUCKLER_MANUAL_LOGIN_PATH && failOnce) { failOnce = false; throw new Error('private-fixture-unlink-error') }
    await originalUnlink(path)
  }
  await assert.rejects(value.controller().closeManualLoginBrowser(), safeFailure('io-failed'))
  await value.controller().closeManualLoginBrowser()
  assert.equal(value.files.has(BUCKLER_MANUAL_LOGIN_PATH), false)
  assert.deepEqual(value.closes, [8172])
})

test('cancelled plain startup never launches or cleans up its own already verified process after launch', async () => {
  const before = fixture(); const beforeSignal = new AbortController(); beforeSignal.abort()
  await assert.rejects(before.controller().prepareManualLoginBrowser(beforeSignal.signal), safeFailure('cancelled'))
  assert.deepEqual(before.launches, []); assert.deepEqual(before.paths, [])
  const during = fixture(); const duringSignal = new AbortController(); const originalLaunch = during.runtime.launch
  during.runtime.launch = async (profile, args) => { const pid = await originalLaunch(profile, args); duringSignal.abort(); return pid }
  await assert.rejects(during.controller().prepareManualLoginBrowser(duringSignal.signal), safeFailure('cancelled'))
  assert.deepEqual(during.closes, [8172])
  assert.equal(during.files.has(BUCKLER_MANUAL_LOGIN_PATH), false)
  assert.ok(!during.readPaths.includes(BUCKLER_MANUAL_DEBUG_PATH))
})

test('restart cancellation before close preserves plain Edge; cancellation after close starts no debug Edge', async () => {
  const before = fixture(); await before.controller().prepareManualLoginBrowser()
  const beforeSignal = new AbortController(); beforeSignal.abort()
  await assert.rejects(before.controller().restartManualBrowserForCapture(beforeSignal.signal), safeFailure('cancelled'))
  assert.deepEqual(before.closes, []); assert.equal(before.launches.length, 1)
  assert.ok(before.files.has(BUCKLER_MANUAL_LOGIN_PATH))
  const during = fixture(); await during.controller().prepareManualLoginBrowser()
  const duringSignal = new AbortController(); const originalClose = during.runtime.closeProcess
  during.runtime.closeProcess = async (...args) => { await originalClose(...args); duringSignal.abort() }
  await assert.rejects(during.controller().restartManualBrowserForCapture(duringSignal.signal), safeFailure('cancelled'))
  assert.deepEqual(during.closes, [8172]); assert.equal(during.launches.length, 1)
  assert.equal(during.files.has(BUCKLER_MANUAL_LOGIN_PATH), false)
})

test('restart cancellation after debug launch closes only that new dedicated process and removes its metadata', async () => {
  const value = fixture(); await value.controller().prepareManualLoginBrowser()
  const signal = new AbortController(); const originalLaunch = value.runtime.launch
  value.runtime.launch = async (profile, args) => { const pid = await originalLaunch(profile, args); signal.abort(); return pid }
  await assert.rejects(value.controller().restartManualBrowserForCapture(signal.signal), safeFailure('cancelled'))
  assert.deepEqual(value.closes, [8172, 8173])
  assert.equal(value.files.has(BUCKLER_MANUAL_LOGIN_PATH), false)
  assert.equal(value.files.has(BUCKLER_MANUAL_LAUNCH_PATH), false)
  assert.equal(value.files.has(BUCKLER_MANUAL_DEBUG_PATH), false)
  assert.ok(value.infos.has(BUCKLER_MANUAL_PROFILE_PATH))
})
