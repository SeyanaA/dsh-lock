#!/usr/bin/env node
/**
 * Host state-machine test: first-run, setup, unlock, wrong-password lockout,
 * 48-hour re-lock, restart lock, password change and the 4396 reset file.
 */
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, unlinkSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pluginDir = join(here, '..')
const mod = await import(join(pluginDir, 'index.js'))
const {
  LockStore,
  LockError,
  DEFAULT_PASSWORD,
  MIN_PASSWORD_LENGTH,
  RELOCK_AFTER_MS,
  MAX_ATTEMPTS,
  hashPassword,
  verifyPassword,
  passwordFormatProblem,
  isRelockDue,
  requestGuardProblem,
  MAX_PASSWORD_LENGTH,
} = mod

const failures = []
const check = (ok, message) => { if (!ok) failures.push(message) }
const expectStatus = (fn, status, message) => {
  try {
    fn()
    failures.push(`${message}: expected LockError ${status}, nothing thrown`)
  } catch (error) {
    if (!(error instanceof LockError) || error.status !== status) {
      failures.push(`${message}: expected LockError ${status}, got ${error?.status ?? error}`)
    }
  }
}

const dirs = []
const makeStore = (nowRef) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-lock-test-'))
  dirs.push(dir)
  const clock = nowRef ?? { now: Date.now() }
  const store = new LockStore({ dir, now: () => clock.now, skipHelper: true })
  return { store, clock, dir }
}

// ------------------------------------------------------------------ password helpers
check(DEFAULT_PASSWORD === '4396', 'default password must be 4396')
check(MIN_PASSWORD_LENGTH === 4, 'minimum password length must be 4')
check(passwordFormatProblem('abc') === '密码至少 4 位', 'three-character password must be rejected')
check(passwordFormatProblem('abcd') === null, 'four-character password must be accepted')
check(passwordFormatProblem('日本語のパスワード') === null, 'content is unrestricted')
const hashed = hashPassword('abcd')
check(verifyPassword('abcd', hashed.salt, hashed.hash) === true, 'hash round-trip')
check(verifyPassword('abce', hashed.salt, hashed.hash) === false, 'wrong password must not verify')
check(isRelockDue({ configured: true, lastUnlockAt: 1000 }, 1000 + RELOCK_AFTER_MS) === true, '48h window must expire')
check(isRelockDue({ configured: true, lastUnlockAt: 1000 }, 1000 + RELOCK_AFTER_MS - 1) === false, '48h window must not expire early')
check(passwordFormatProblem('x'.repeat(MAX_PASSWORD_LENGTH + 1)) !== null, 'oversized passwords must be rejected')
const guardBase = {
  'content-type': 'application/json',
  'x-dsh-lock-client': '1',
  host: '127.0.0.1:54321',
  origin: 'http://127.0.0.1:54321',
}
check(requestGuardProblem({ headers: guardBase }, 'http://127.0.0.1:54321') === null, 'same-origin JSON client must pass the guard')
check(requestGuardProblem({ headers: { ...guardBase, 'x-dsh-lock-client': undefined } }, 'http://127.0.0.1:54321') !== null, 'missing client marker must be rejected')
check(requestGuardProblem({ headers: { ...guardBase, 'content-type': 'text/plain' } }, 'http://127.0.0.1:54321') !== null, 'non-JSON content type must be rejected')
check(requestGuardProblem({ headers: { ...guardBase, origin: 'https://evil.example' } }, 'http://127.0.0.1:54321') !== null, 'cross-site origin must be rejected')
check(requestGuardProblem({ headers: { ...guardBase, 'sec-fetch-site': 'cross-site' } }, 'http://127.0.0.1:54321') !== null, 'cross-site fetch metadata must be rejected')
check(requestGuardProblem({ headers: { ...guardBase, origin: 'http://localhost:54321' } }, 'http://127.0.0.1:54321') === null, 'loopback alias origins on the same port are trusted')

// ------------------------------------------------------------------ first run + setup
const { store, clock, dir } = makeStore()
let status = store.startup()
check(status.configured === false && status.locked === true, 'first run must start locked and unconfigured')
check(status.reason === 'first-run', 'first run reason')
expectStatus(() => store.setup('abc', false), 400, 'short setup password')
check(store.isConfigured() === false, 'failed setup must not configure the store')
store.setup('abcd', true) // biometric flag ignored when skipHelper (unavailable)
status = store.status()
check(status.configured === true && status.locked === false, 'setup must unlock the session')
check(status.biometricEnabled === false, 'biometric must stay off when unavailable')

// ------------------------------------------------------------------ manual lock + wrong password
store.lockNow('manual')
check(store.status().locked === true, 'manual lock must lock')
expectStatus(() => store.unlock('nope'), 401, 'wrong password')
store.unlock('abcd')
check(store.status().locked === false, 'correct password must unlock')

// ------------------------------------------------------------------ 48h relock
clock.now += RELOCK_AFTER_MS + 1000
status = store.status()
check(status.locked === true && status.reason === 'timeout', '48h idle must relock with the timeout reason')
store.unlock('abcd')
check(store.status().locked === false, 'correct password after relock')

// ------------------------------------------------------------------ restart lock
const restarted = new LockStore({ dir, now: () => clock.now, skipHelper: true })
status = restarted.startup()
check(status.locked === true && status.reason === 'restart', 'a new process start must lock again')
restarted.unlock('abcd')

// ------------------------------------------------------------------ lockout after wrong attempts
restarted.lockNow('manual')
for (let index = 1; index < MAX_ATTEMPTS; index += 1) {
  expectStatus(() => restarted.unlock(`wrong-${index}`), 401, `wrong attempt ${index}`)
}
expectStatus(() => restarted.unlock('another-wrong'), 429, 'attempt limit')
expectStatus(() => restarted.unlock('abcd'), 429, 'correct password while locked out')
clock.now += 31_000
restarted.unlock('abcd')
check(restarted.status().locked === false, 'password works after the lockout window')

// ------------------------------------------------------------------ change password
restarted.changePassword('abcd', 'newpass')
check(restarted.status().passwordIsDefault === false, 'custom password flag')
restarted.lockNow('manual')
expectStatus(() => restarted.unlock('abcd'), 401, 'old password after change')
restarted.unlock('newpass')
expectStatus(() => restarted.changePassword('wrong', 'other'), 401, 'change password needs the current one')

// ------------------------------------------------------------------ default-password reset file
const resetDir = makeStore()
copyFileSync(join(pluginDir, 'bin', 'default-state.json'), join(resetDir.dir, 'state.json'))
const resetStore = new LockStore({ dir: resetDir.dir, now: () => resetDir.clock.now, skipHelper: true })
status = resetStore.startup()
check(status.configured === true && status.locked === true && status.passwordIsDefault === true, 'reset state must be locked with the default password')
resetStore.unlock(DEFAULT_PASSWORD)
check(resetStore.status().locked === false, '4396 must unlock the reset state')

// ------------------------------------------------------------------ independent app lock
const independentStore = makeStore()
independentStore.store.startup()
independentStore.store.setup('abcd', false)
check(independentStore.store.status().independentLock === false, 'the independent app lock must default to off')
independentStore.store.setIndependentLock(true)
status = independentStore.store.status()
check(status.independentLock === true, 'the independent app lock must report enabled')
check(status.biometricEnabled === false, 'the independent app lock must disable the local unlock')
check(independentStore.store.biometricEnabled() === false, 'independent lock must gate biometricEnabled()')
independentStore.store.lockNow('manual')
expectStatus(() => independentStore.store.setIndependentLock(false), 401, 'toggling the app lock needs an unlocked session')
independentStore.store.unlock('abcd')
check(independentStore.store.status().locked === false, 'the plugin password still unlocks with the app lock on')
// Persisted and still enforced after a restart of the host process.
const independentReload = new LockStore({ dir: independentStore.dir, now: () => independentStore.clock.now, skipHelper: true })
status = independentReload.startup()
check(status.independentLock === true, 'the independent app lock must survive a restart')
independentReload.unlock('abcd')
independentReload.setIndependentLock(false)
status = independentReload.status()
check(status.independentLock === false, 'the independent app lock can be turned back off')

// ------------------------------------------------------------------ reset command keeps the posture
const postureRoot = mkdtempSync(join(tmpdir(), 'dsh-lock-reset-'))
dirs.push(postureRoot)
const postureHome = join(postureRoot, 'home')
mkdirSync(join(postureHome, 'dsh-lock'), { recursive: true })
const postureState = {
  ...JSON.parse(readFileSync(join(pluginDir, 'bin', 'default-state.json'), 'utf8')),
  independent: true,
  biometric: true,
}
writeFileSync(join(postureHome, 'dsh-lock', 'state.json'), JSON.stringify(postureState))
const resetRun = spawnSync('bash', [join(pluginDir, 'bin', 'reset-password')], {
  env: { ...process.env, DSH_HOME: postureHome },
  encoding: 'utf8',
})
check(resetRun.status === 0, 'the reset command must succeed: ' + String(resetRun.stderr || '').slice(0, 200))
const resetState = JSON.parse(readFileSync(join(postureHome, 'dsh-lock', 'state.json'), 'utf8'))
check(resetState.passwordIsDefault === true, 'the reset command must restore the default password')
check(resetState.independent === true, 'the reset command must keep the independent app lock enabled')
check(resetState.biometric === true, 'the reset command must keep the local-unlock preference')

// ------------------------------------------------------------------ deleted state → first run
const removed = makeStore()
removed.store.startup()
removed.store.setup('abcd', false)
unlinkSync(join(removed.dir, 'state.json'))
removed.store.refreshIfChanged()
check(removed.store.isConfigured() === false, 'deleting the state file must return to first-run')

for (const dirPath of dirs) {
  try {
    rmSync(dirPath, { recursive: true, force: true })
  } catch {
    // Temp cleanup is best effort.
  }
}

if (failures.length > 0) {
  console.error('host-lock: FAIL')
  for (const failure of failures) console.error('  - ' + failure)
  process.exit(1)
}
console.log('host-lock: PASS (first-run, setup, unlock, lockout, 48h, restart, change, reset, independent lock)')
