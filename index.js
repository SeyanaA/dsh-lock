/**
 * dsh-lock — host half.
 *
 * A local-only re-authentication gate for DeepSeek Harness Desktop:
 *
 * - every process start locks the UI again;
 * - a verified session older than 48 hours locks again on the next status poll;
 * - unlock with the plugin password (at least 4 characters, any content) or,
 *   on a Mac with Touch ID enrolled, with the macOS system sheet through
 *   LocalAuthentication (`deviceOwnerAuthentication`, so the login password is
 *   the system-level fallback).
 *
 * The password is stored as a scrypt hash in `$DSH_HOME/dsh-lock/state.json`.
 * Nothing leaves this machine; no session content is read.
 */
import { execFile } from 'node:child_process'
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-lock'
export const inject = ['webServer']

/** Route table, all loopback-local through the DSH web server. */
export const ROUTES = {
  status: '/api/dsh-lock/status',
  setup: '/api/dsh-lock/setup',
  unlock: '/api/dsh-lock/unlock',
  biometric: '/api/dsh-lock/biometric',
  lock: '/api/dsh-lock/lock',
  password: '/api/dsh-lock/password',
  biometricSetting: '/api/dsh-lock/biometric-setting',
  report: '/api/dsh-lock/report',
}

/** The password restored by the terminal reset command. */
export const DEFAULT_PASSWORD = '4396'
/** Minimum password length; any content is accepted. */
export const MIN_PASSWORD_LENGTH = 4
/** Defensive upper bound so a giant body cannot pin scrypt. */
export const MAX_PASSWORD_LENGTH = 256
/** A verified session older than this locks again. */
export const RELOCK_AFTER_MS = 48 * 60 * 60 * 1000
/** Persisted state format version. */
export const STATE_VERSION = 1
/** Wrong attempts before a temporary lockout. */
export const MAX_ATTEMPTS = 5
/** First lockout duration; doubles on each further burst of wrong attempts. */
export const LOCKOUT_BASE_MS = 30 * 1000

const HERE = dirname(fileURLToPath(import.meta.url))
const HELPER_PATH = join(HERE, 'bin', 'dsh-auth-helper')
const RESET_COMMAND = join(HERE, 'bin', 'reset-password')

/** A rejected request carrying the HTTP status the route should answer with. */
export class LockError extends Error {
  /**
   * @param {number} status - HTTP status.
   * @param {string} message - user-facing reason.
   * @param {object|null} extra - optional structured detail.
   */
  constructor(status, message, extra = null) {
    super(message)
    this.status = status
    this.extra = extra
  }
}

/**
 * @param {string} password - candidate password.
 * @returns a user-facing problem, or null when it is acceptable.
 */
export function passwordFormatProblem(password) {
  if (typeof password !== 'string') return '密码必须是非空字符串'
  if (password.length < MIN_PASSWORD_LENGTH) return `密码至少 ${MIN_PASSWORD_LENGTH} 位`
  if (password.length > MAX_PASSWORD_LENGTH) return `密码最长 ${MAX_PASSWORD_LENGTH} 位`
  return null
}

/**
 * @param {string} password - plain password.
 * @param {Buffer} [salt] - optional salt (tests use a fixed one).
 * @returns `{ salt, hash }` as base64 strings.
 */
export function hashPassword(password, salt = randomBytes(16)) {
  return {
    salt: salt.toString('base64'),
    hash: scryptSync(password, salt, 32).toString('base64'),
  }
}

/**
 * Constant-time verification of a password against a stored hash.
 * @param {string} password - plain password.
 * @param {string} saltBase64 - stored salt.
 * @param {string} hashBase64 - stored hash.
 * @returns whether the password matches.
 */
export function verifyPassword(password, saltBase64, hashBase64) {
  try {
    const expected = Buffer.from(hashBase64, 'base64')
    const actual = scryptSync(password, Buffer.from(saltBase64, 'base64'), expected.length)
    return timingSafeEqual(expected, actual)
  } catch {
    return false
  }
}

/**
 * @param {object} state - lock state.
 * @param {number} now - epoch milliseconds.
 * @returns whether the 48-hour re-lock window has expired.
 */
export function isRelockDue(state, now = Date.now()) {
  if (state === null || typeof state !== 'object' || state.configured !== true) return false
  const lastUnlockAt = typeof state.lastUnlockAt === 'number' ? state.lastUnlockAt : 0
  return lastUnlockAt > 0 && now - lastUnlockAt >= RELOCK_AFTER_MS
}

/** The directory holding the plugin state. */
export function stateDir() {
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'dsh-lock')
}

/** The state file path. */
export function stateFile() {
  return join(stateDir(), 'state.json')
}

/** A fresh, unconfigured lock state (first run). */
function emptyState() {
  return {
    version: STATE_VERSION,
    configured: false,
    passwordIsDefault: false,
    salt: '',
    hash: '',
    biometric: false,
    locked: true,
    lastUnlockAt: 0,
    reason: 'first-run',
    failedAttempts: 0,
    lockedUntil: 0,
    updatedAt: Date.now(),
  }
}

/**
 * Validate a parsed state document; anything else is treated as absent.
 * @param {unknown} raw - parsed JSON.
 * @returns a normalised state, or null.
 */
function normaliseState(raw) {
  if (raw === null || typeof raw !== 'object') return null
  if (raw.version !== STATE_VERSION) return null
  const state = emptyState()
  state.configured = raw.configured === true
  state.passwordIsDefault = raw.passwordIsDefault === true
  state.salt = typeof raw.salt === 'string' ? raw.salt : ''
  state.hash = typeof raw.hash === 'string' ? raw.hash : ''
  state.biometric = raw.biometric === true
  state.locked = raw.locked !== false
  state.lastUnlockAt = typeof raw.lastUnlockAt === 'number' && raw.lastUnlockAt >= 0 ? raw.lastUnlockAt : 0
  state.reason = typeof raw.reason === 'string' ? raw.reason : ''
  state.failedAttempts = typeof raw.failedAttempts === 'number' && raw.failedAttempts >= 0 ? raw.failedAttempts : 0
  state.lockedUntil = typeof raw.lockedUntil === 'number' && raw.lockedUntil >= 0 ? raw.lockedUntil : 0
  state.updatedAt = typeof raw.updatedAt === 'number' ? raw.updatedAt : Date.now()
  if (state.configured) {
    if (state.salt === '' || state.hash === '') return null
  } else {
    state.salt = ''
    state.hash = ''
    state.biometric = false
  }
  return state
}

/**
 * Run the native Touch ID helper.
 * @param {string[]} args - helper arguments.
 * @param {number} timeout - kill the helper after this many milliseconds.
 * @returns `{ code, stdout, stderr }`.
 */
export function runHelper(args, timeout = 10_000) {
  return new Promise((resolve) => {
    execFile(HELPER_PATH, args, { timeout, killSignal: 'SIGKILL' }, (error, stdout, stderr) => {
      let code = 0
      if (error !== null && error !== undefined) {
        if (error.killed === true) code = 124
        else if (typeof error.code === 'number') code = error.code
        else code = 1
      }
      resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
    })
  })
}

/**
 * @returns whether Touch ID is available and enrolled on this Mac.
 */
export async function checkBiometricAvailability() {
  if (process.platform !== 'darwin') return false
  const result = await runHelper(['--check'], 8_000)
  return result.code === 0
}

/** The lock state machine, optionally redirected to a temp directory by tests. */
export class LockStore {
  /**
   * @param {object} options - test seams.
   * @param {string} [options.dir] - state directory.
   * @param {() => number} [options.now] - clock.
   * @param {string} [options.helperPath] - helper binary override.
   * @param {boolean} [options.skipHelper] - never touch the native helper.
   */
  constructor(options = {}) {
    this.dir = options.dir ?? stateDir()
    this.file = join(this.dir, 'state.json')
    this.now = options.now ?? (() => Date.now())
    this.helperPath = options.helperPath ?? HELPER_PATH
    this.skipHelper = options.skipHelper === true
    this.biometricAvailable = this.skipHelper ? false : null
    this.biometricInFlight = false
    this.lastClientReport = null
    this.state = null
    this.mtimeMs = -1
  }

  /** Read the state file when it changed on disk (setup, reset, another window). */
  refreshIfChanged() {
    let stat = null
    try {
      stat = statSync(this.file)
    } catch {
      stat = null
    }
    if (stat === null) {
      if (this.state !== null && this.state.configured === true) {
        // A deleted state file means "forget everything": first-run setup.
        this.state = emptyState()
      }
      this.mtimeMs = -1
      return
    }
    if (stat.mtimeMs === this.mtimeMs) return
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8'))
      const state = normaliseState(parsed)
      if (state !== null) {
        this.state = state
        this.mtimeMs = stat.mtimeMs
      }
    } catch {
      // A torn or hand-edited file keeps the in-memory state; never crash.
    }
  }

  /** Write the state atomically. */
  save() {
    mkdirSync(this.dir, { recursive: true })
    const temporary = join(this.dir, `.state.${process.pid}.tmp`)
    writeFileSync(temporary, JSON.stringify(this.state, null, 2) + '\n', { mode: 0o600 })
    renameSync(temporary, this.file)
    try {
      chmodSync(this.file, 0o600)
    } catch {
      // Best effort on exotic filesystems.
    }
    this.mtimeMs = statSync(this.file).mtimeMs
  }

  /**
   * Load the persisted state and apply the restart lock.
   * @returns the status snapshot.
   */
  startup() {
    this.refreshIfChanged()
    if (this.state === null) this.state = emptyState()
    if (this.state.configured) {
      this.state.locked = true
      this.state.reason = 'restart'
    } else {
      this.state.locked = true
      this.state.reason = 'first-run'
    }
    this.state.failedAttempts = 0
    this.state.lockedUntil = 0
    this.state.updatedAt = this.now()
    this.save()
    return this.status()
  }

  /** @returns whether the store has a configured password. */
  isConfigured() {
    this.refreshIfChanged()
    return this.state !== null && this.state.configured === true
  }

  /** @returns whether Touch ID unlock is configured. */
  biometricEnabled() {
    this.refreshIfChanged()
    return this.state !== null && this.state.configured === true && this.state.biometric === true
  }

  /** @returns whether the current session is unlocked. */
  isUnlocked() {
    this.refreshIfChanged()
    if (this.state === null || this.state.configured !== true) return false
    if (this.state.locked === true) return false
    return !isRelockDue(this.state, this.now())
  }

  /** Resolve Touch ID availability once per process. */
  async ensureBiometric() {
    if (this.skipHelper) return false
    if (this.biometricAvailable === null) {
      this.biometricAvailable = await checkBiometricAvailability()
    }
    return this.biometricAvailable
  }

  /** The public status document consumed by the client half. */
  status() {
    this.refreshIfChanged()
    if (this.state === null) this.state = emptyState()
    if (isRelockDue(this.state, this.now())) {
      this.state.locked = true
      this.state.reason = 'timeout'
      this.state.updatedAt = this.now()
      this.save()
    }
    const state = this.state
    return {
      ok: true,
      locked: state.configured !== true ? true : state.locked === true,
      configured: state.configured === true,
      passwordIsDefault: state.passwordIsDefault === true,
      reason: state.configured === true ? state.reason ?? '' : 'first-run',
      biometricEnabled: state.configured === true && state.biometric === true,
      biometricAvailable: this.biometricAvailable === true,
      minPasswordLength: MIN_PASSWORD_LENGTH,
      relockAfterMs: RELOCK_AFTER_MS,
      lastUnlockAt: state.lastUnlockAt,
      failedAttempts: state.failedAttempts,
      lockedUntil: state.lockedUntil,
      resetCommand: RESET_COMMAND,
      platformSupported: process.platform === 'darwin',
      serverTime: this.now(),
    }
  }

  /**
   * First-run configuration.
   * @param {string} password - at least four characters.
   * @param {boolean} biometric - enable Touch ID when available.
   */
  setup(password, biometric) {
    this.refreshIfChanged()
    if (this.state !== null && this.state.configured === true) {
      throw new LockError(409, '已经设置过密码，请在 设置 → 安全锁定 中修改')
    }
    const problem = passwordFormatProblem(password)
    if (problem !== null) throw new LockError(400, problem)
    const hashed = hashPassword(password)
    this.state = {
      ...emptyState(),
      configured: true,
      passwordIsDefault: false,
      salt: hashed.salt,
      hash: hashed.hash,
      biometric: biometric === true && this.biometricAvailable === true,
      locked: false,
      reason: '',
      lastUnlockAt: this.now(),
      updatedAt: this.now(),
    }
    this.save()
  }

  /** @returns the number of milliseconds a lockout still lasts, or 0. */
  lockoutRemaining() {
    this.refreshIfChanged()
    if (this.state === null) return 0
    const until = this.state.lockedUntil
    return until > this.now() ? until - this.now() : 0
  }

  /**
   * @param {string} password - candidate password.
   */
  unlock(password) {
    this.refreshIfChanged()
    if (this.state === null || this.state.configured !== true) {
      throw new LockError(409, '尚未设置密码，请先完成首次设置')
    }
    const remaining = this.lockoutRemaining()
    if (remaining > 0) {
      throw new LockError(429, '尝试次数过多，请稍后再试', { retryAfterMs: remaining })
    }
    const ok = verifyPassword(password, this.state.salt, this.state.hash)
    if (!ok) {
      this.state.failedAttempts += 1
      if (this.state.failedAttempts >= MAX_ATTEMPTS) {
        const burst = Math.floor(this.state.failedAttempts / MAX_ATTEMPTS) - 1
        const duration = LOCKOUT_BASE_MS * 2 ** Math.max(0, Math.min(4, burst))
        this.state.lockedUntil = this.now() + duration
        this.state.updatedAt = this.now()
        this.save()
        throw new LockError(429, '尝试次数过多，请稍后再试', { retryAfterMs: duration })
      }
      this.state.updatedAt = this.now()
      this.save()
      throw new LockError(401, '密码不正确')
    }
    this.unlockNow()
  }

  /** Mark the session verified after a biometric success. */
  unlockNow() {
    this.state.locked = false
    this.state.reason = ''
    this.state.lastUnlockAt = this.now()
    this.state.failedAttempts = 0
    this.state.lockedUntil = 0
    this.state.updatedAt = this.now()
    this.save()
  }

  /** @param {string} reason - why the UI locked. */
  lockNow(reason = 'manual') {
    this.refreshIfChanged()
    if (this.state === null) this.state = emptyState()
    this.state.locked = true
    this.state.reason = reason
    this.state.updatedAt = this.now()
    this.save()
  }

  /**
   * Change the password for an unlocked session.
   * @param {string} currentPassword - the password in use.
   * @param {string} nextPassword - at least four characters.
   */
  changePassword(currentPassword, nextPassword) {
    if (!this.isUnlocked()) throw new LockError(401, '当前会话未解锁')
    const problem = passwordFormatProblem(nextPassword)
    if (problem !== null) throw new LockError(400, problem)
    if (!verifyPassword(currentPassword, this.state.salt, this.state.hash)) {
      throw new LockError(401, '当前密码不正确')
    }
    const hashed = hashPassword(nextPassword)
    this.state.salt = hashed.salt
    this.state.hash = hashed.hash
    this.state.passwordIsDefault = false
    this.state.updatedAt = this.now()
    this.save()
  }

  /**
   * Enable or disable Touch ID for an unlocked session.
   * @param {boolean} enabled - desired state.
   */
  setBiometric(enabled) {
    if (!this.isUnlocked()) throw new LockError(401, '当前会话未解锁')
    if (enabled === true && this.biometricAvailable !== true) {
      throw new LockError(400, '当前 Mac 不支持 Touch ID 或尚未录入指纹')
    }
    this.state.biometric = enabled === true
    this.state.updatedAt = this.now()
    this.save()
  }
}

/**
 * Reject state-changing requests that did not come from the DSH web page.
 *
 * DSH's loopback routes have no network authentication of their own, so the
 * plugin additionally requires: an explicit client marker header, a JSON
 * content type, no cross-site Origin and no cross-site Sec-Fetch-Site. That
 * stops a random local page (or DNS-rebinding attempt) from locking the UI or
 * spamming the biometric sheet.
 *
 * @param {object} req - incoming request.
 * @param {string|undefined} allowedOrigin - the exact DSH web origin when known.
 * @returns a user-facing rejection reason, or null when the request may proceed.
 */
export function requestGuardProblem(req, allowedOrigin) {
  const headers = req !== null && typeof req === 'object' && req.headers !== null && typeof req.headers === 'object'
    ? req.headers
    : {}
  const contentType = String(headers['content-type'] ?? '').toLowerCase()
  if (!contentType.startsWith('application/json')) return '需要 application/json 请求'
  if (headers['x-dsh-lock-client'] !== '1') return '缺少 dsh-lock 客户端标识'
  const site = headers['sec-fetch-site']
  if (typeof site === 'string' && site !== '' && site !== 'same-origin' && site !== 'none') return '跨站请求不被允许'
  const origin = headers.origin
  if (typeof origin === 'string' && origin !== '') {
    let parsed = null
    try {
      parsed = new URL(origin)
    } catch {
      return '来源不被允许'
    }
    // The exact advertised origin is ideal; a loopback origin on the same port
    // as the Host header is equally trustworthy (127.0.0.1 vs localhost, or a
    // stale advertised URL). Everything else is rejected.
    const target = typeof allowedOrigin === 'string' && allowedOrigin !== '' ? allowedOrigin.replace(/\/$/, '') : null
    const exact = target !== null && origin.replace(/\/$/, '') === target
    const host = String(headers.host ?? '')
    const loopback = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '::1' || parsed.hostname === '[::1]'
    const samePort = host.includes(':') ? parsed.port === host.slice(host.lastIndexOf(':') + 1) : true
    if (!exact && !(loopback && samePort)) return '来源不被允许'
  }
  return null
}

/**
 * @param {import('node:http').ServerResponse} res - response.
 * @param {number} status - HTTP status.
 * @param {object} body - JSON body.
 */
function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

/**
 * @param {import('node:http').IncomingMessage} req - request.
 * @returns the parsed JSON body.
 */
function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 16 * 1024) {
        reject(new LockError(413, '请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({})
        return
      }
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        resolve(parsed !== null && typeof parsed === 'object' ? parsed : {})
      } catch {
        reject(new LockError(400, 'JSON 格式不正确'))
      }
    })
    req.on('error', reject)
  })
}

/**
 * Wrap a route handler with method check and error mapping.
 * @param {'GET'|'POST'} method - accepted method.
 * @param {(req: object, res: object) => Promise<void>|void} handler - the body.
 */
function route(method, handler, options = {}) {
  const guard = options.guard === true
  const allowedOrigin = options.allowedOrigin
  return async (req, res) => {
    if (req.method !== method) {
      sendJson(res, 405, { ok: false, error: `${method} only` })
      return
    }
    if (guard) {
      const problem = requestGuardProblem(req, allowedOrigin)
      if (problem !== null) {
        sendJson(res, 403, { ok: false, error: problem })
        return
      }
    }
    try {
      await handler(req, res)
    } catch (error) {
      if (error instanceof LockError) {
        sendJson(res, error.status, { ok: false, error: error.message, ...(error.extra ?? {}) })
        return
      }
      sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }
}

/**
 * Register the lock gate routes.
 * @param {object} ctx - host plugin context.
 */
export function apply(ctx) {
  const store = new LockStore()
  store.startup()
  void store.ensureBiometric()

  const allowedOrigin = typeof ctx.webServer.getOrigin === 'function' ? ctx.webServer.getOrigin() : undefined
  const mutation = (method, handler) => route(method, handler, { guard: true, allowedOrigin })

  /** Prompt-throttle: at most one sheet per 1.5 s and five per minute. */
  let lastPromptAt = 0
  let promptTimes = []
  const reservePrompt = () => {
    const now = Date.now()
    promptTimes = promptTimes.filter((at) => now - at < 60_000)
    if (now - lastPromptAt < 1_500) return 1_500 - (now - lastPromptAt)
    if (promptTimes.length >= 5) return 60_000 - (now - promptTimes[0])
    lastPromptAt = now
    promptTimes.push(now)
    return 0
  }

  const status = () => ({ ...store.status(), client: store.lastClientReport })

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTES.status,
    handler: route('GET', async (req, res) => {
      await store.ensureBiometric()
      const body = status()
      const diag = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('diag') === '1'
      sendJson(res, 200, diag ? { ...body, diag: true } : body)
    }),
  }), 'dsh-lock: status')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTES.setup,
    handler: mutation('POST', async (req, res) => {
      await store.ensureBiometric()
      const body = await readJson(req)
      store.setup(typeof body.password === 'string' ? body.password : '', body.biometric === true)
      sendJson(res, 200, { ok: true, status: status() })
    }),
  }), 'dsh-lock: setup')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTES.unlock,
    handler: mutation('POST', async (req, res) => {
      const body = await readJson(req)
      store.unlock(typeof body.password === 'string' ? body.password : '')
      sendJson(res, 200, { ok: true, status: status() })
    }),
  }), 'dsh-lock: unlock')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTES.biometric,
    handler: mutation('POST', async (req, res) => {
      const available = await store.ensureBiometric()
      if (!store.isConfigured()) throw new LockError(409, '尚未设置解锁方式')
      if (!store.biometricEnabled()) throw new LockError(400, '未启用 Touch ID')
      if (!available) throw new LockError(400, '当前 Mac 不支持 Touch ID 或尚未录入指纹')
      if (store.biometricInFlight) throw new LockError(429, '正在等待系统验证')
      const waitMs = reservePrompt()
      if (waitMs > 0) throw new LockError(429, '请稍后再试', { retryAfterMs: waitMs })
      store.biometricInFlight = true
      try {
        const result = await runHelper(['--auth', '解锁 DeepSeek Harness'], 120_000)
        if (result.code !== 0) {
          const message = result.code === 2
            ? '系统认证不可用'
            : result.code === 3
              ? '系统认证超时'
              : '系统验证未通过'
          throw new LockError(401, message)
        }
        store.unlockNow()
        sendJson(res, 200, { ok: true, status: status() })
      } finally {
        store.biometricInFlight = false
      }
    }),
  }), 'dsh-lock: biometric')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTES.lock,
    handler: route('POST', async (_req, res) => {
      store.lockNow('manual')
      sendJson(res, 200, { ok: true, status: status() })
    }),
  }), 'dsh-lock: lock')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTES.password,
    handler: mutation('POST', async (req, res) => {
      const body = await readJson(req)
      store.changePassword(
        typeof body.currentPassword === 'string' ? body.currentPassword : '',
        typeof body.newPassword === 'string' ? body.newPassword : '',
      )
      sendJson(res, 200, { ok: true, status: status() })
    }),
  }), 'dsh-lock: password')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTES.biometricSetting,
    handler: mutation('POST', async (req, res) => {
      const available = await store.ensureBiometric()
      const body = await readJson(req)
      if (body.enabled === true && !available) throw new LockError(400, '当前 Mac 不支持 Touch ID 或尚未录入指纹')
      store.setBiometric(body.enabled === true)
      sendJson(res, 200, { ok: true, status: status() })
    }),
  }), 'dsh-lock: biometric setting')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTES.report,
    handler: mutation('POST', async (req, res) => {
      const body = await readJson(req)
      store.lastClientReport = {
        at: Date.now(),
        userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'].slice(0, 160) : '',
        phase: typeof body.phase === 'string' ? body.phase.slice(0, 64) : '',
        mode: typeof body.mode === 'string' ? body.mode.slice(0, 64) : '',
        overlay: body.overlay === true,
        settings: body.settings === true,
        version: typeof body.version === 'string' ? body.version.slice(0, 32) : '',
        locked: body.locked === true,
        configured: body.configured === true,
      }
      sendJson(res, 200, { ok: true })
    }),
  }), 'dsh-lock: client report')
}
