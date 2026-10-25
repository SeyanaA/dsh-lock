#!/usr/bin/env node
/**
 * Client render test.
 *
 * Loads the browser bundle under a mock module loader and a tiny hooks runtime,
 * then checks the overlay + settings registrations, every gate mode, the two
 * Liquid Glass success animations, and that Touch ID is never raised on its
 * own — only the first deliberate gesture on the lock screen arms it.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pluginDir = join(here, '..')
const code = readFileSync(join(pluginDir, 'client.js'), 'utf8')

const failures = []
const check = (ok, message) => { if (!ok) failures.push(message) }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const fakeElement = () => ({
  setAttribute() {}, getAttribute() { return null }, appendChild() {}, remove() {},
  textContent: '', style: {}, addEventListener() {}, removeEventListener() {},
  querySelector() { return null }, querySelectorAll() { return [] }, parentElement: null,
})
const documentListeners = new Map()
const addDocumentListener = (type, fn) => {
  const list = documentListeners.get(type) ?? []
  list.push(fn)
  documentListeners.set(type, list)
}
const removeDocumentListener = (type, fn) => {
  const list = documentListeners.get(type)
  if (list === undefined) return
  const index = list.indexOf(fn)
  if (index >= 0) list.splice(index, 1)
}
const fireDocument = (type, event) => {
  for (const fn of [...(documentListeners.get(type) ?? [])]) fn(event)
}
globalThis.document = {
  head: { appendChild() {} },
  body: { appendChild() {} },
  documentElement: fakeElement(),
  cookie: '',
  createElement: () => fakeElement(),
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener: addDocumentListener,
  removeEventListener: removeDocumentListener,
}

// ------------------------------------------------------------------ tiny hooks runtime
const hooks = []
let hookIndex = 0
let effectDeps = new Map()
let pendingEffects = []
let renderQueued = false
let mountedComponent = null
let latestTree = null

const depsEqual = (left, right) => {
  if (!Array.isArray(left) || !Array.isArray(right)) return false
  if (left.length !== right.length) return false
  return left.every((value, index) => Object.is(value, right[index]))
}

function scheduleRender() {
  if (renderQueued) return
  renderQueued = true
  queueMicrotask(() => {
    renderQueued = false
    if (mountedComponent !== null) renderMounted()
  })
}

const React = {
  Fragment: Symbol('Fragment'),
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useState(initial) {
    const index = hookIndex++
    if (!(index in hooks)) hooks[index] = typeof initial === 'function' ? initial() : initial
    const set = (value) => {
      const next = typeof value === 'function' ? value(hooks[index]) : value
      if (next === hooks[index]) return
      hooks[index] = next
      scheduleRender()
    }
    return [hooks[index], set]
  },
  useRef(initial) {
    const index = hookIndex++
    if (!(index in hooks)) hooks[index] = { current: initial }
    return hooks[index]
  },
  useMemo(factory, deps) {
    const index = hookIndex++
    const previous = hooks[index]
    if (previous !== undefined && depsEqual(previous.deps, deps)) return previous.value
    const value = factory()
    hooks[index] = { value, deps: Array.isArray(deps) ? deps.slice() : deps }
    return value
  },
  useCallback(fn, deps) {
    const index = hookIndex++
    const previous = hooks[index]
    if (previous !== undefined && depsEqual(previous.deps, deps)) return previous.fn
    hooks[index] = { fn, deps: Array.isArray(deps) ? deps.slice() : deps }
    return fn
  },
  useEffect(effect, deps) {
    const index = hookIndex++
    const previous = effectDeps.get(index)
    const changed = previous === undefined || !depsEqual(previous, deps)
    if (!changed) return
    effectDeps.set(index, Array.isArray(deps) ? deps.slice() : deps)
    pendingEffects.push(effect)
  },
  useLayoutEffect(effect, deps) { React.useEffect(effect, deps) },
  useSyncExternalStore(getSnapshot) { hookIndex++; return getSnapshot() },
}

function expand(node) {
  if (node === null || node === undefined || node === false) return null
  if (Array.isArray(node)) return node.map(expand)
  if (typeof node !== 'object') return node
  if (typeof node.type === 'function') return expand(node.type({ ...node.props, children: node.children }))
  return { ...node, children: (node.children ?? []).map(expand) }
}
function collectText(node, out = []) {
  if (node === null || node === undefined || node === false) return out
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, out)
    return out
  }
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (typeof node === 'object' && Array.isArray(node.children)) collectText(node.children, out)
  return out
}
const textOf = (node) => collectText(expand(node)).join(' ')
const classesOf = (tree) => {
  const found = []
  const walk = (node) => {
    if (node === null || node === undefined) return
    if (Array.isArray(node)) { for (const child of node) walk(child); return }
    if (typeof node !== 'object') return
    if (typeof node.props?.className === 'string') found.push(node.props.className)
    if (Array.isArray(node.children)) for (const child of node.children) walk(child)
  }
  walk(tree)
  return found.join(' ')
}
function renderMounted() {
  hookIndex = 0
  pendingEffects = []
  latestTree = expand(React.createElement(mountedComponent, {}))
  for (const effect of pendingEffects) {
    try {
      effect()
    } catch (error) {
      failures.push('effect threw: ' + String(error))
    }
  }
}

// ------------------------------------------------------------------ fetched status state
const requests = []
let statusPayload = {
  ok: true,
  locked: true,
  configured: true,
  reason: 'restart',
  passwordIsDefault: false,
  biometricEnabled: true,
  biometricAvailable: true,
  minPasswordLength: 4,
  relockAfterMs: 48 * 60 * 60 * 1000,
  lastUnlockAt: 1760000000000,
  resetCommand: '/Users/me/.dsh/local-plugins/dsh-lock/bin/reset-password',
}
let unlockedByBiometric = false
globalThis.fetch = async (url, options = {}) => {
  const path = String(url)
  requests.push({ path, method: options.method ?? 'GET', body: options.body, headers: options.headers })
  if (path.endsWith('/biometric')) {
    unlockedByBiometric = true
    statusPayload = { ...statusPayload, locked: false, reason: '', lastUnlockAt: Date.now() }
    return { ok: true, status: 200, json: async () => ({ ok: true, status: statusPayload }) }
  }
  if (path.endsWith('/report')) return { ok: true, status: 200, json: async () => ({ ok: true }) }
  if (path.includes('/status')) return { ok: true, status: 200, json: async () => statusPayload }
  return { ok: true, status: 200, json: async () => ({ ok: true }) }
}
globalThis.localStorage = { getItem: () => null, setItem: () => {} }
globalThis.setInterval = () => 0
globalThis.clearInterval = () => {}
const loaded = {}
const windowMock = {
  addEventListener() {}, removeEventListener() {},
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
  setInterval: () => 0,
  clearInterval: () => {},
  __ModuleLoader__: {
    load({ id, factory }) {
      loaded.id = id
      loaded.module = factory((name) => {
        if (name === 'react') return React
        throw new Error('unexpected require: ' + name)
      })
    },
  },
}
globalThis.window = windowMock
// eslint-disable-next-line no-eval
eval(code)

check(loaded.id === 'dsh-lock', `bundle id ${String(loaded.id)}`)
const registrations = []
const ctx = {
  effect(fn, label) {
    try {
      const dispose = fn()
      if (typeof dispose === 'function') dispose()
    } catch (error) {
      failures.push(label + ': ' + error)
    }
  },
  slots: {
    inject(name, callback) { callback(); return () => {} },
    register(options, component) { registrations.push({ options, component }); return () => {} },
  },
  locale: { register() { return () => {} }, bind() { return (key) => key } },
}
loaded.module.apply(ctx)

check(registrations.some((entry) => entry.options.name === 'shell.overlay' && entry.options.id === 'dsh-lock'), 'lock overlay must be registered in shell.overlay')
check(registrations.some((entry) => entry.options.name === 'settings.section' && entry.options.id === 'dsh-lock'), 'security settings section must be registered')
check(requests.some((request) => request.path.includes('/api/dsh-lock/report')), 'client must report its load to the host')

const api = loaded.module.__test
const statusUnlock = {
  configured: true,
  locked: true,
  reason: 'restart',
  passwordIsDefault: true,
  biometricEnabled: true,
  biometricAvailable: true,
  relockAfterMs: 48 * 60 * 60 * 1000,
  minPasswordLength: 4,
  lastUnlockAt: 1760000000000,
  resetCommand: '/Users/me/.dsh/local-plugins/dsh-lock/bin/reset-password',
}
const statusSetup = {
  configured: false,
  locked: true,
  reason: 'first-run',
  passwordIsDefault: false,
  biometricEnabled: false,
  biometricAvailable: true,
  minPasswordLength: 4,
  relockAfterMs: 48 * 60 * 60 * 1000,
  resetCommand: '/Users/me/.dsh/local-plugins/dsh-lock/bin/reset-password',
}
const noop = () => {}

// ------------------------------------------------------------------ setup screen
const setupText = textOf(api.LockScreen({
  status: statusSetup,
  mode: 'setup',
  password: '',
  confirm: '',
  useBiometric: true,
  busy: false,
  biometricBusy: false,
  error: '',
  retryAfterMs: 0,
  help: false,
  success: null,
  biometricPending: false,
  onPassword: noop,
  onConfirm: noop,
  onBiometricToggle: noop,
  onSubmit: noop,
  onBiometric: noop,
  onHelpToggle: noop,
}))
check(setupText.includes('设置解锁密码'), 'setup screen title')
check(setupText.includes('新密码') && setupText.includes('确认密码'), 'setup screen fields')
check(setupText.includes('至少 4 位'), 'setup screen password hint')
check(setupText.includes('Touch ID') && setupText.includes('轻触锁屏'), 'setup screen explains the Touch ID gesture')
check(setupText.includes('设置并解锁'), 'setup screen submit')

// ------------------------------------------------------------------ unlock screen
const unlockText = textOf(api.LockScreen({
  status: statusUnlock,
  mode: 'unlock',
  password: '',
  confirm: '',
  useBiometric: true,
  busy: false,
  biometricBusy: false,
  error: '',
  retryAfterMs: 0,
  help: true,
  success: null,
  biometricPending: false,
  onPassword: noop,
  onConfirm: noop,
  onBiometricToggle: noop,
  onSubmit: noop,
  onBiometric: noop,
  onHelpToggle: noop,
}))
check(unlockText.includes('已锁定'), 'unlock screen title')
check(unlockText.includes('DSH 重新启动后需要重新验证'), 'unlock screen restart reason')
check(unlockText.includes('轻触锁屏空白处或按 Enter'), 'unlock screen explains how to raise Touch ID')
check(unlockText.includes('忘记密码'), 'unlock screen recovery hint')
check(unlockText.includes('4396'), 'unlock screen default-password warning')
check(unlockText.includes('reset-password'), 'unlock screen terminal command')

const pendingText = textOf(api.LockScreen({
  status: statusUnlock,
  mode: 'unlock',
  password: '',
  confirm: '',
  useBiometric: true,
  busy: false,
  biometricBusy: true,
  error: '',
  retryAfterMs: 0,
  help: false,
  success: null,
  biometricPending: true,
  onPassword: noop,
  onConfirm: noop,
  onBiometricToggle: noop,
  onSubmit: noop,
  onBiometric: noop,
  onHelpToggle: noop,
}))
check(pendingText.includes('Touch ID 已唤起'), 'pending Touch ID state copy')

// ------------------------------------------------------------------ success animations
const biometricSuccess = expand(api.LockScreen({
  status: statusUnlock,
  mode: 'unlock',
  success: { method: 'biometric' },
  password: '', confirm: '', useBiometric: true, busy: false, biometricBusy: false,
  error: '', retryAfterMs: 0, help: false, biometricPending: false,
  onPassword: noop, onConfirm: noop, onBiometricToggle: noop, onSubmit: noop, onBiometric: noop, onHelpToggle: noop,
}))
const biometricText = collectText(biometricSuccess).join(' ')
check(biometricText.includes('指纹验证通过') && biometricText.includes('正在进入'), 'fingerprint success animation copy')
check(classesOf(biometricSuccess).includes('dshl-successBiometric'), 'fingerprint success styling')
check(classesOf(biometricSuccess).includes('dshl-successCheck'), 'fingerprint success draws a check mark')
check(classesOf(biometricSuccess).includes('dshl-overlaySuccess'), 'overlay fade-out animation class')

const passwordSuccess = expand(api.LockScreen({
  status: statusUnlock,
  mode: 'unlock',
  success: { method: 'password' },
  password: '', confirm: '', useBiometric: true, busy: false, biometricBusy: false,
  error: '', retryAfterMs: 0, help: false, biometricPending: false,
  onPassword: noop, onConfirm: noop, onBiometricToggle: noop, onSubmit: noop, onBiometric: noop, onHelpToggle: noop,
}))
check(collectText(passwordSuccess).join(' ').includes('密码验证通过'), 'password success animation copy')
check(classesOf(passwordSuccess).includes('dshl-successPassword'), 'password success styling')
check(classesOf(passwordSuccess).includes('dshl-successCheck'), 'password success draws a check mark')
check(classesOf(passwordSuccess).includes('dshl-shackleOpen'), 'password success opens the lock')

// ------------------------------------------------------------------ settings page
const settingsText = textOf(api.SettingsView({
  status: statusUnlock,
  currentPassword: '',
  nextPassword: '',
  confirmPassword: '',
  feedback: '',
  feedbackError: false,
  onCurrentPassword: noop,
  onNextPassword: noop,
  onConfirmPassword: noop,
  onLockNow: noop,
  onChangePassword: noop,
  onToggleBiometric: noop,
}))
check(settingsText.includes('锁定状态'), 'settings: status section')
check(settingsText.includes('修改密码'), 'settings: password section')
check(settingsText.includes('Touch ID'), 'settings: biometric section')
check(settingsText.includes('立即锁定'), 'settings: lock-now action')

// ------------------------------------------------------------------ one-click header lock button
check(
  registrations.some((entry) => entry.options.name === 'conversation.session.header.utilities' && entry.options.id === 'dsh-lock-lock'),
  'one-click lock button must be registered in the header utilities',
)
const buttonTree = expand(React.createElement(api.LockButton, {}))
const lockButton = (() => {
  let found = null
  const walk = (node) => {
    if (found !== null || node === null || node === undefined) return
    if (Array.isArray(node)) { for (const child of node) walk(child); return }
    if (typeof node !== 'object') return
    if (node.type === 'button' && node.props?.['aria-label'] === '锁定 DSH') found = node
    if (Array.isArray(node.children)) for (const child of node.children) walk(child)
  }
  walk(buttonTree)
  return found
})()
check(lockButton !== null, 'header lock button renders a button with an accessible label')
check(typeof lockButton?.props?.className === 'string' && lockButton.props.className.includes('dshl-lockButton'), 'header lock button styling')
const lockRequestsBefore = requests.filter((request) => request.path.endsWith('/api/dsh-lock/lock')).length
lockButton.props.onClick()
await sleep(40)
check(requests.filter((request) => request.path.endsWith('/api/dsh-lock/lock')).length === lockRequestsBefore + 1, 'clicking the header lock button calls the lock route')

// ------------------------------------------------------------------ live overlay: no auto prompt, gesture-armed Touch ID
// Earlier direct component renders shared the global hook slots; reset them so
// the mounted overlay starts from a clean first render.
hooks.length = 0
effectDeps.clear()
mountedComponent = api.LockOverlay
renderMounted()
check(collectText(latestTree).join(' ').includes('正在读取锁定状态'), 'the gate covers the app before the first status arrives')
await sleep(300)
check(!requests.some((request) => request.path.includes('/api/dsh-lock/biometric')), 'the gate must never raise the biometric sheet on its own')
check(collectText(latestTree).join(' ').includes('轻触锁屏空白处或按 Enter'), 'the unlock screen explains the Touch ID gesture')

// A click inside a field or on a button must not arm the sheet.
fireDocument('pointerdown', { target: { closest: () => ({}) } })
await sleep(150)
check(!requests.some((request) => request.path.includes('/api/dsh-lock/biometric')), 'field/button interactions must not arm Touch ID')

// The first deliberate gesture on the lock screen arms the system sheet.
fireDocument('pointerdown', { target: { closest: () => null } })
await sleep(250)
check(requests.some((request) => request.path.includes('/api/dsh-lock/biometric')), 'the first lock-screen gesture must raise the biometric sheet')
check(collectText(latestTree).join(' ').includes('指纹验证通过'), 'the automatic-success path plays the new fingerprint animation')
check(classesOf(latestTree).includes('dshl-successCheck'), 'the success animation draws the check mark')
await sleep(1250)
const afterUnlockText = latestTree === null ? '' : collectText(latestTree).join(' ')
check(afterUnlockText === '' || !afterUnlockText.includes('指纹验证通过'), 'the gate disappears after the success animation')

// The client marks every request so the hardened host can trust it.
check(
  requests.some((request) => request.method === 'POST' && request.headers?.['x-dsh-lock-client'] === '1'),
  'client requests carry the dsh-lock marker header',
)
check(
  requests.some((request) => request.method === 'POST' && request.headers?.['content-type'] === 'application/json'),
  'client mutations are JSON requests',
)

if (failures.length > 0) {
  console.error('client-render: FAIL')
  for (const failure of failures) console.error('  - ' + failure)
  process.exit(1)
}
console.log('client-render: PASS (slots, modes, Liquid Glass success animations, gesture-armed Touch ID, settings)')
