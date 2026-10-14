import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const script = fileURLToPath(new URL('./probe-buckler-auth.ts', import.meta.url))

test('help works without an interactive terminal or browser launch', () => {
  const result = spawnSync(process.execPath, [script, '--help'], { encoding: 'utf8', timeout: 10_000 })
  assert.equal(result.status, 0)
  assert.match(result.stdout, /手動ログイン/)
  assert.match(result.stdout, /別起動/)
  assert.equal(result.stderr, '')
})

test('invalid input and noninteractive execution fail before any browser use and do not echo input', () => {
  const secret = 'private-token-must-not-be-echoed'
  const invalid = spawnSync(process.execPath, [script, '--url', secret], { encoding: 'utf8', timeout: 10_000 })
  assert.equal(invalid.status, 1)
  assert.ok(!invalid.stderr.includes(secret))
  const noninteractive = spawnSync(process.execPath, [script], { encoding: 'utf8', timeout: 10_000 })
  assert.equal(noninteractive.status, 1)
  assert.match(noninteractive.stderr, /対話ターミナル/)
})
