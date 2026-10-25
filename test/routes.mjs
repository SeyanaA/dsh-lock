#!/usr/bin/env node
/**
 * Route integration test: mounts the host half against a temp DSH_HOME and a
 * fake web server, then exercises the hardened endpoints (guard, first-run
 * setup, lock, unlock, password change) without touching the live profile.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pluginDir = join(here, '..')

const home = mkdtempSync(join(tmpdir(), 'dsh-lock-routes-'))
process.env.DSH_HOME = home

const mod = await import(join(pluginDir, 'index.js'))
const routes = new Map()
const effects = []
const ctx = {
  effect(fn) {
    const dispose = fn()
    if (typeof dispose === 'function') effects.push(dispose)
    return dispose
  },
  webServer: {
    register(route) {
      routes.set(route.path, route.handler)
      return () => routes.delete(route.path)
    },
    getOrigin() {
      return 'http://127.0.0.1:54321'
    },
  },
}
mod.apply(ctx)

const failures = []
const check = (ok, message) => { if (!ok) failures.push(message) }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const ORIGIN = 'http://127.0.0.1:54321'
const goodHeaders = {
  host: '127.0.0.1:54321',
  origin: ORIGIN,
  'content-type': 'application/json',
  'x-dsh-lock-client': '1',
  'user-agent': 'dsh-lock-test',
}
function call(path, method = 'GET', options = {}) {
  const headers = options.headers ?? goodHeaders
  const body = options.body === undefined ? null : JSON.stringify(options.body)
  const request = Readable.from(body === null ? [] : [Buffer.from(body)])
  request.method = method
  request.url = path
  request.headers = headers
  const handler = routes.get(path)
  return new Promise((resolve) => {
    const response = {
      status: 0,
      headers: {},
      writeHead(status, headersOut) {
        this.status = status
        this.headers = headersOut ?? {}
      },
      end(payload) {
        let parsed = null
        try {
          parsed = payload ? JSON.parse(payload) : null
        } catch {
          parsed = payload ?? null
        }
        resolve({ status: this.status, headers: this.headers, body: parsed })
      },
    }
    if (handler === undefined) {
      failures.push('missing route: ' + path)
      response.writeHead(404)
      response.end(null)
      return
    }
    Promise.resolve(handler(request, response)).catch((error) => {
      failures.push(`${method} ${path} threw: ${String(error)}`)
      response.writeHead(500)
      response.end(null)
    })
  })
}

await sleep(50)

const status = await call(mod.ROUTES.status)
check(status.status === 200, `status should be 200, got ${status.status}`)
check(status.body?.locked === true && status.body?.configured === false, 'the mounted store must start locked and unconfigured')
check(status.headers['x-content-type-options'] === 'nosniff', 'responses must set nosniff')

const noMarker = await call(mod.ROUTES.setup, 'POST', {
  headers: { ...goodHeaders, 'x-dsh-lock-client': undefined },
  body: { password: 'abcd' },
})
check(noMarker.status === 403, `setup without marker should be 403, got ${noMarker.status}`)

const noJson = await call(mod.ROUTES.setup, 'POST', {
  headers: { ...goodHeaders, 'content-type': 'text/plain' },
  body: { password: 'abcd' },
})
check(noJson.status === 403, `setup without JSON should be 403, got ${noJson.status}`)

const evilOrigin = await call(mod.ROUTES.setup, 'POST', {
  headers: { ...goodHeaders, origin: 'https://evil.example' },
  body: { password: 'abcd' },
})
check(evilOrigin.status === 403, `setup from a foreign origin should be 403, got ${evilOrigin.status}`)

const setup = await call(mod.ROUTES.setup, 'POST', { body: { password: 'abcd', biometric: false } })
check(setup.status === 200 && setup.body?.status?.configured === true, 'proper setup should configure and unlock')
check(setup.body?.status?.locked === false, 'setup should leave the session unlocked')

const locked = await call(mod.ROUTES.lock, 'POST', { body: {} })
check(locked.status === 200 && locked.body?.status?.locked === true, 'lock should lock the session')

const openAgain = await call(mod.ROUTES.unlock, 'POST', { body: { password: 'abcd' } })
check(openAgain.status === 200 && openAgain.body?.status?.locked === false, 'unlock should accept the configured password')

const wrong = await call(mod.ROUTES.unlock, 'POST', { body: { password: 'nope' } })
check(wrong.status === 401, `wrong password should be 401, got ${wrong.status}`)

const changed = await call(mod.ROUTES.password, 'POST', {
  body: { currentPassword: 'abcd', newPassword: 'newpass' },
})
check(changed.status === 200 && changed.body?.status?.passwordIsDefault === false, 'password change should succeed when unlocked')

const lockAgain = await call(mod.ROUTES.lock, 'POST', { body: {} })
check(lockAgain.status === 200, 'second lock should succeed')
const oldPassword = await call(mod.ROUTES.unlock, 'POST', { body: { password: 'abcd' } })
check(oldPassword.status === 401, 'the old password must stop working after a change')
const newPassword = await call(mod.ROUTES.unlock, 'POST', { body: { password: 'newpass' } })
check(newPassword.status === 200, 'the new password must work')

const biometricUnguarded = await call(mod.ROUTES.biometric, 'POST', {
  headers: { ...goodHeaders, 'x-dsh-lock-client': undefined },
  body: {},
})
check(biometricUnguarded.status === 403, 'the biometric route must be guarded (no prompt without the client marker)')

for (const dispose of effects.reverse()) {
  try {
    await dispose()
  } catch {
    // Effects are best effort in this harness.
  }
}
try {
  rmSync(home, { recursive: true, force: true })
} catch {
  // Temp cleanup is best effort.
}

if (failures.length > 0) {
  console.error('routes: FAIL')
  for (const failure of failures) console.error('  - ' + failure)
  process.exit(1)
}
console.log('routes: PASS (guarded setup/lock/unlock/password-change + headers)')
