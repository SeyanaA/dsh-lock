/**
 * dsh-lock — browser half.
 *
 * Two surfaces:
 *
 * - `shell.overlay` — the full-screen lock gate. It renders whenever the host
 *   reports a locked session (after every DSH start, after 48 hours without
 *   verification, or after a manual lock). First run goes through the same
 *   surface in "set a password" mode.
 * - `settings.section` — the "安全锁定" settings page: change the password,
 *   toggle Touch ID, lock immediately, and read the terminal reset command.
 *
 * Passwords are only posted to the loopback host route; Touch ID is handled by
 * the host's native LocalAuthentication helper and never touches this bundle.
 */

window.__ModuleLoader__.load({
  id: 'dsh-lock',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement

    const NS = 'dsh-lock'
    const VERSION = '0.1.6'
    const BASE = '/api/dsh-lock'
    const API = {
      status: BASE + '/status',
      setup: BASE + '/setup',
      unlock: BASE + '/unlock',
      biometric: BASE + '/biometric',
      lock: BASE + '/lock',
      password: BASE + '/password',
      biometricSetting: BASE + '/biometric-setting',
      report: BASE + '/report',
    }

    const zh = {
      'settings.label': '安全锁定',
      'overlay.title': 'DeepSeek Harness 已锁定',
      'overlay.setupTitle': '设置解锁密码',
      'lockButton.label': '锁定',
    }
    const en = {
      'settings.label': 'Security Lock',
      'overlay.title': 'DeepSeek Harness is locked',
      'overlay.setupTitle': 'Set an unlock password',
      'lockButton.label': 'Lock',
    }

    //#region module-scope gate signal

    /**
     * Small store shared by the overlay and the settings page so a manual lock
     * shows the gate immediately instead of waiting for the next poll.
     */
    const gate = { locked: null, listeners: new Set() }
    function emitGate(locked) {
      gate.locked = locked
      for (const listener of [...gate.listeners]) {
        try {
          listener(locked)
        } catch {
          // A listener unmounting must not break the others.
        }
      }
    }
    function subscribeGate(listener) {
      gate.listeners.add(listener)
      return () => gate.listeners.delete(listener)
    }

    //#endregion

    //#region transport

    /**
     * @param {string} url - host route.
     * @param {object} [options] - `{method, body}`.
     * @returns the parsed JSON payload.
     */
    async function api(url, options = {}) {
      const response = await fetch(url, {
        method: options.method ?? 'GET',
        cache: 'no-store',
        // The host only accepts same-origin, JSON, explicitly-marked requests,
        // so a random local page cannot lock DSH or spam biometric prompts.
        headers: options.body === undefined
          ? { accept: 'application/json', 'x-dsh-lock-client': '1' }
          : { accept: 'application/json', 'x-dsh-lock-client': '1', 'content-type': 'application/json' },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      })
      let payload = null
      try {
        payload = await response.json()
      } catch {
        payload = null
      }
      if (payload === null || typeof payload !== 'object') {
        throw new Error(`HTTP ${response.status}`)
      }
      if (!response.ok || payload.ok === false) {
        const error = new Error(typeof payload.error === 'string' ? payload.error : `HTTP ${response.status}`)
        error.status = response.status
        error.retryAfterMs = typeof payload.retryAfterMs === 'number' ? payload.retryAfterMs : 0
        throw error
      }
      return payload
    }

    /** Which UI surfaces this activation actually registered. */
    const surfaces = { overlay: false, settings: false, lockButton: false }

    /** Best-effort diagnostics so a load can be verified from the host side. */
    function report(phase, extra) {
      void api(API.report, {
        method: 'POST',
        body: { phase, overlay: surfaces.overlay, settings: surfaces.settings, version: VERSION, ...extra },
      }).catch(() => undefined)
    }

    //#endregion

    //#region formatting

    /** @param {number} milliseconds - duration. */
    function formatRelative(milliseconds) {
      if (typeof milliseconds !== 'number' || !Number.isFinite(milliseconds) || milliseconds <= 0) return ''
      const seconds = Math.round(milliseconds / 1000)
      if (seconds < 60) return `${seconds} 秒`
      const minutes = Math.round(seconds / 60)
      if (minutes < 60) return `${minutes} 分钟`
      const hours = Math.round(minutes / 60)
      if (hours < 48) return `${hours} 小时`
      return `${Math.round(hours / 24)} 天`
    }

    /** @param {number} epochMs - timestamp. */
    function formatTime(epochMs) {
      if (typeof epochMs !== 'number' || epochMs <= 0) return '—'
      const date = new Date(epochMs)
      return date.toLocaleString('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      })
    }

    /** The human reason under the lock heading. */
    function reasonText(status) {
      if (status === null) return ''
      if (!status.configured) return '首次使用：请先设置解锁密码（至少 4 位，内容不限）。'
      if (status.reason === 'timeout') return `已超过 ${Math.round((status.relockAfterMs ?? 0) / 3600000)} 小时未验证，请重新解锁。`
      if (status.reason === 'restart') return 'DSH 重新启动后需要重新验证。'
      if (status.reason === 'manual') return '已手动锁定，请验证以继续。'
      if (status.reason === 'reset') return '密码已恢复为默认密码，请先输入 4396 解锁。'
      return '请验证以继续使用 DeepSeek Harness。'
    }

    //#endregion

    //#region shared UI atoms

    /** @param {object} props - icon props. */
    function LockGlyph(props) {
      const size = props.size ?? 28
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        'aria-hidden': 'true',
      }, [
        h('rect', {
          key: 'body',
          x: 4,
          y: 10,
          width: 16,
          height: 10,
          rx: 2.6,
          stroke: 'currentColor',
          strokeWidth: 1.7,
        }),
        h('path', {
          key: 'shackle',
          d: 'M8 10V7.5a4 4 0 0 1 8 0V10',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
        }),
        h('circle', { key: 'dot', cx: 12, cy: 15, r: 1.4, fill: 'currentColor' }),
      ])
    }

    /** The unlocked variant of the icon, used by the password success animation. */
    function LockOpenGlyph(props) {
      const size = props.size ?? 30
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        'aria-hidden': 'true',
      }, [
        h('rect', {
          key: 'body',
          x: 4,
          y: 10,
          width: 16,
          height: 10,
          rx: 2.6,
          stroke: 'currentColor',
          strokeWidth: 1.7,
        }),
        h('path', {
          key: 'shackle',
          className: 'dshl-shackleOpen',
          d: 'M8 10V7.5a4 4 0 0 1 8 0V10',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
        }),
        h('circle', { key: 'dot', cx: 12, cy: 15, r: 1.4, fill: 'currentColor' }),
      ])
    }

    /** @param {object} props - icon props. */
    function FingerprintGlyph(props) {
      const size = props.size ?? 16
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        'aria-hidden': 'true',
      }, [
        h('path', {
          key: 'a',
          d: 'M6.2 11.2V9.6a5.8 5.8 0 0 1 11.6 0v2.2M8.6 12.4v-2.8a3.4 3.4 0 0 1 6.8 0v1.6M11 13.4v-2.2a1.4 1.4 0 0 1 2.8 0v3.4c0 2.4-.8 4.6-2.2 6.2M6.4 15.2c.3 1.6-.1 3.3-1.2 4.6M16.6 15.4c-.2 1.8.2 3.6 1.3 5',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinecap: 'round',
        }),
      ])
    }

    /** @param {object} props - field props. */
    function PasswordField(props) {
      return h('label', { className: 'dshl-field' }, [
        h('span', { key: 'label', className: 'dshl-fieldLabel' }, props.label),
        h('input', {
          key: 'input',
          className: 'dshl-input',
          type: 'password',
          value: props.value ?? '',
          autoFocus: props.autoFocus === true,
          autoComplete: props.autoComplete ?? 'off',
          placeholder: props.placeholder ?? '',
          onChange: (event) => props.onChange(event.target.value),
          onKeyDown: props.onKeyDown,
        }),
      ])
    }


    //#endregion

    //#region unlock animations

    /**
     * The brief success animation shown after a password or a Touch ID unlock,
     * before the gate fades away.
     * @param {object} props - `{ method: 'password'|'biometric' }`.
     */
    function SuccessView(props) {
      const biometric = props.method === 'biometric'
      return h('div', {
        className: 'dshl-success ' + (biometric ? 'dshl-successBiometric' : 'dshl-successPassword'),
      }, [
        h('div', { key: 'aura', className: 'dshl-successAura' }),
        h('div', {
          key: 'icon',
          className: 'dshl-successIcon ' + (biometric ? 'dshl-successIconBiometric' : 'dshl-successIconPassword'),
        }, [
          h('span', { key: 'glyph', className: 'dshl-successGlyph' }, biometric
            ? h(FingerprintGlyph, { size: 30 })
            : h(LockOpenGlyph, { size: 28 })),
          h('span', { key: 'ring', className: 'dshl-successRing' }),
          h('svg', { key: 'check', className: 'dshl-successCheck', viewBox: '0 0 24 24', 'aria-hidden': 'true' },
            h('path', { d: 'M6.4 12.4l3.5 3.5 7.7-8.3' })),
        ]),
        h('div', { key: 'title', className: 'dshl-successTitle' }, biometric ? '指纹验证通过' : '密码验证通过'),
        h('div', { key: 'hint', className: 'dshl-successHint' }, '正在进入…'),
      ])
    }

    //#endregion

    //#region lock screen (presentational)

    /**
     * The gate's visual body. Props are explicit so tests can render every mode.
     * @param {object} props - screen props from the controller.
     */
    function LockScreen(props) {
      const status = props.status
      const setup = props.mode === 'setup'
      const checking = props.mode === 'checking'
      const lockedSeconds = Math.max(0, Math.ceil((props.retryAfterMs ?? 0) / 1000))
      if (props.success !== null && props.success !== undefined) {
        return h('div', { className: 'dshl-overlay dshl-overlaySuccess', role: 'dialog', 'aria-modal': 'true' }, [
          h('div', { key: 'panel', className: 'dshl-panel dshl-panelSuccess' }, h(SuccessView, { method: props.success.method })),
        ])
      }
      return h('div', { className: 'dshl-overlay', role: 'dialog', 'aria-modal': 'true' }, [
        h('div', { key: 'panel', className: 'dshl-panel' }, [
          h('div', { key: 'glyph', className: 'dshl-glyph' }, h(LockGlyph, { size: 26 })),
          h('h1', { key: 'title', className: 'dshl-title' }, setup ? '设置解锁密码' : checking ? '正在验证…' : 'DeepSeek Harness 已锁定'),
          checking
            ? h('div', { key: 'checking', className: 'dshl-checking' }, [
              h('span', { key: 'spinner', className: 'dshl-spinner' }),
              h('span', { key: 'text' }, '正在读取锁定状态…'),
              typeof props.onRetry === 'function' ? h('button', {
                key: 'retry',
                type: 'button',
                className: 'dshl-link',
                onClick: props.onRetry,
              }, '重试') : null,
            ])
            : h('p', { key: 'hint', className: 'dshl-hint' }, reasonText(status)),
          status !== null && status.passwordIsDefault && !setup
            ? h('p', { key: 'default', className: 'dshl-note dshl-noteWarn' }, '当前为默认密码 4396。解锁后请到 设置 → 安全锁定 修改。')
            : null,
          setup
            ? h(SetupForm, { key: 'form', ...props })
            : h(UnlockForm, {
              ...props,
              biometricAutomated: status !== null && status.biometricEnabled === true && status.biometricAvailable === true,
            }),
          props.error !== '' ? h('p', { key: 'error', className: 'dshl-error' }, props.error) : null,
          lockedSeconds > 0
            ? h('p', { key: 'lockout', className: 'dshl-note dshl-noteWarn' }, `尝试次数过多，请 ${lockedSeconds} 秒后再试。`)
            : null,
          props.help === true && status !== null && !setup
            ? h('div', { key: 'help', className: 'dshl-help' }, [
              h('div', { key: 'title', className: 'dshl-helpTitle' }, '忘记密码？'),
              h('div', { key: 'body', className: 'dshl-helpBody' }, '在终端执行下面的命令，密码会恢复为默认密码 4396：'),
              h('code', { key: 'cmd', className: 'dshl-code' }, status.resetCommand ?? ''),
            ])
            : null,
        ]),
      ])
    }

    /** First-run password creation. */
    function SetupForm(props) {
      return h('div', { className: 'dshl-form' }, [
        h(PasswordField, {
          key: 'password',
          label: '新密码',
          value: props.password,
          autoFocus: true,
          autoComplete: 'new-password',
          placeholder: '至少 4 位，内容不限',
          onChange: props.onPassword,
        }),
        h(PasswordField, {
          key: 'confirm',
          label: '确认密码',
          value: props.confirm,
          autoComplete: 'new-password',
          placeholder: '再输入一次',
          onChange: props.onConfirm,
          onKeyDown: (event) => {
            if (event.key === 'Enter') props.onSubmit()
          },
        }),
        props.status !== null && props.status.biometricAvailable === true
          ? h('p', { key: 'bio', className: 'dshl-footnote dshl-footnoteTight' }, '检测到 Touch ID：设置完成后，轻触锁屏空白处或按 Enter 即可唤起系统验证（可在设置中关闭）。')
          : h('p', { key: 'bio', className: 'dshl-footnote dshl-footnoteTight' }, '此 Mac 未检测到可用 Touch ID，请使用密码解锁。'),
        h('button', {
          key: 'submit',
          type: 'button',
          className: 'dshl-primary',
          disabled: props.busy === true,
          onClick: props.onSubmit,
        }, props.busy === true ? '正在保存…' : '设置并解锁'),
      ])
    }

    /** Password / Touch ID unlock. */
    function UnlockForm(props) {
      const status = props.status
      const biometricReady = status !== null && status.biometricEnabled === true && status.biometricAvailable === true
      return h('div', { className: 'dshl-form' }, [
        biometricReady
          ? h('p', { key: 'autoHint', className: 'dshl-autoHint' }, [
            h(FingerprintGlyph, { key: 'icon', size: 15 }),
            h('span', { key: 'text' }, props.biometricBusy === true
              ? 'Touch ID 已唤起，把手指放上去即可解锁…'
              : '轻触锁屏空白处或按 Enter 唤起 Touch ID，然后把手指放上去解锁。'),
          ])
          : null,
        h(PasswordField, {
          key: 'password',
          label: '密码',
          value: props.password,
          autoFocus: true,
          autoComplete: 'current-password',
          placeholder: '输入解锁密码',
          onChange: props.onPassword,
          onKeyDown: (event) => {
            if (event.key === 'Enter') props.onSubmit()
          },
        }),
        h('div', { key: 'actions', className: 'dshl-actions' }, [
          h('button', {
            key: 'unlock',
            type: 'button',
            className: 'dshl-primary',
            disabled: props.busy === true || props.biometricBusy === true,
            onClick: props.onSubmit,
          }, props.busy === true ? '正在解锁…' : '解锁'),
          biometricReady
            ? h('button', {
              key: 'bio',
              type: 'button',
              className: 'dshl-secondary',
              disabled: props.busy === true || props.biometricBusy === true,
              onClick: props.onBiometric,
            }, [h(FingerprintGlyph, { key: 'icon' }), props.biometricBusy === true ? '等待验证…' : 'Touch ID'])
            : null,
        ]),
        biometricReady
          ? null
          : h('p', { key: 'biohint', className: 'dshl-footnote' }, '可在 设置 → 安全锁定 中启用 Touch ID。'),
        h('button', {
          key: 'helpToggle',
          type: 'button',
          className: 'dshl-link',
          onClick: props.onHelpToggle,
        }, props.help === true ? '收起找回方式' : '忘记密码？'),
      ])
    }

    //#endregion

    //#region lock screen (controller)

    /** The live gate: polls status, renders the overlay while locked. */
    function LockOverlay() {
      const [status, setStatus] = React.useState(null)
      const [error, setError] = React.useState('')
      const [password, setPassword] = React.useState('')
      const [confirm, setConfirm] = React.useState('')
      const [useBiometric, setUseBiometric] = React.useState(true)
      const [busy, setBusy] = React.useState(false)
      const [biometricBusy, setBiometricBusy] = React.useState(false)
      const [retryAfterMs, setRetryAfterMs] = React.useState(0)
      const [help, setHelp] = React.useState(false)
      const [failedFetches, setFailedFetches] = React.useState(0)
      const [success, setSuccess] = React.useState(null)
      const [biometricPending, setBiometricPending] = React.useState(false)
      const interactionArmed = React.useRef(false)

      const lastReportedMode = React.useRef(null)

      const refresh = React.useCallback(async () => {
        try {
          const payload = await api(API.status)
          setStatus(payload)
          setError('')
          setFailedFetches(0)
          const mode = !payload.configured ? 'setup' : payload.locked ? 'unlock' : 'unlocked'
          if (lastReportedMode.current !== mode) {
            lastReportedMode.current = mode
            report('status', { mode, locked: payload.locked === true, configured: payload.configured === true })
          }
        } catch (failure) {
          setFailedFetches((previous) => previous + 1)
          setError(failure instanceof Error ? failure.message : String(failure))
        }
      }, [])

      React.useEffect(() => {
        void refresh()
        const timer = setInterval(() => {
          void refresh()
        }, 20_000)
        const onFocus = () => {
          void refresh()
        }
        window.addEventListener('focus', onFocus)
        document.addEventListener('visibilitychange', onFocus)
        const unsubscribe = subscribeGate((locked) => {
          if (locked === false) {
            void refresh()
          } else {
            setStatus((previous) => (previous === null ? previous : { ...previous, locked: true }))
          }
        })
        return () => {
          clearInterval(timer)
          window.removeEventListener('focus', onFocus)
          document.removeEventListener('visibilitychange', onFocus)
          unsubscribe()
        }
      }, [refresh])

      // Fail closed: while the status is unknown (or unreachable) the gate
      // stays up, so a broken status route can never reveal the app.
      const shown = status === null || status.locked === true
      const mode = status === null ? 'checking' : !status.configured ? 'setup' : 'unlock'

      // macOS has no passive Touch ID sensor API: the system sheet is the only
      // way to authenticate. To stay on the safe side of the platform's review
      // rules we never raise it on our own — the first deliberate gesture on the
      // lock screen (a click anywhere outside a field/button, or Enter) arms it.
      React.useEffect(() => {
        if (!shown || mode !== 'unlock' || success !== null) return undefined
        if (status === null || status.biometricEnabled !== true || status.biometricAvailable !== true) return undefined
        if (busy || biometricBusy) return undefined
        if (interactionArmed.current) return undefined
        const isInteractive = (target) => {
          if (target === null || target === undefined) return false
          if (typeof target.closest !== 'function') return false
          return target.closest('.dshl-input, .dshl-field, button, input, textarea, select, a, label') !== null
        }
        const arm = (event) => {
          if (event !== null && typeof event === 'object' && isInteractive(event.target)) return
          if (interactionArmed.current) return
          interactionArmed.current = true
          void unlockWithBiometrics()
        }
        const onKey = (event) => {
          if (event.key === 'Escape' || event.metaKey || event.ctrlKey || event.altKey) return
          arm(event)
        }
        const onPointer = (event) => arm(event)
        document.addEventListener('keydown', onKey, true)
        document.addEventListener('pointerdown', onPointer, true)
        return () => {
          document.removeEventListener('keydown', onKey, true)
          document.removeEventListener('pointerdown', onPointer, true)
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [shown, mode, success, status, busy, biometricBusy])

      React.useEffect(() => {
        if (status !== null && status.locked !== true) interactionArmed.current = false
      }, [status])

      React.useEffect(() => {
        if (!shown) return undefined
        // Keep background shortcuts from stealing focus while the gate is up.
        const trap = (event) => {
          const target = event.target
          if (target !== null && typeof target === 'object' && typeof target.closest === 'function' && target.closest('.dshl-overlay') !== null) return
          event.preventDefault()
          event.stopPropagation()
        }
        document.addEventListener('keydown', trap, true)
        document.addEventListener('keyup', trap, true)
        return () => {
          document.removeEventListener('keydown', trap, true)
          document.removeEventListener('keyup', trap, true)
        }
      }, [shown])

      if (!shown) return null

      // Keep the success animation on screen briefly, then reveal the app.
      const finishUnlock = (nextStatus, method) => {
        setSuccess({ method })
        setBiometricPending(false)
        setBusy(false)
        setError('')
        report('unlock-success', { mode: 'unlocked', method, locked: false, configured: nextStatus?.configured === true })
        window.setTimeout(() => {
          setSuccess(null)
          setStatus(nextStatus)
          setPassword('')
          setConfirm('')
          interactionArmed.current = false
          emitGate(false)
          report('unlocked', { mode: 'unlocked', locked: false, configured: nextStatus?.configured === true })
        }, 1_000)
      }

      const submit = async () => {
        if (busy) return
        setError('')
        if (mode === 'setup') {
          if (password.length < (status?.minPasswordLength ?? 4)) {
            setError(`密码至少 ${status?.minPasswordLength ?? 4} 位`)
            return
          }
          if (password !== confirm) {
            setError('两次输入的密码不一致')
            return
          }
        } else if (password.length === 0) {
          if (status !== null && status.biometricEnabled === true && status.biometricAvailable === true) {
            // Enter on an empty field means "use Touch ID" — no separate click.
            interactionArmed.current = true
            await unlockWithBiometrics()
            return
          }
          setError('请输入密码')
          return
        }
        setBusy(true)
        try {
          const payload = mode === 'setup'
            ? await api(API.setup, { method: 'POST', body: { password, biometric: status?.biometricAvailable === true } })
            : await api(API.unlock, { method: 'POST', body: { password } })
          finishUnlock(payload.status, 'password')
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
          setRetryAfterMs(typeof failure?.retryAfterMs === 'number' ? failure.retryAfterMs : 0)
        } finally {
          setBusy(false)
        }
      }

      const unlockWithBiometrics = async () => {
        if (busy || biometricBusy) return
        setError('')
        setRetryAfterMs(0)
        setBiometricBusy(true)
        setBiometricPending(true)
        try {
          const payload = await api(API.biometric, { method: 'POST', body: {} })
          finishUnlock(payload.status, 'biometric')
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setBiometricBusy(false)
          setBiometricPending(false)
        }
      }

      if (status === null) {
        return h(LockScreen, {
          status: null,
          mode: 'checking',
          error: failedFetches > 2 ? '无法连接解锁服务，请确认 dsh-lock 插件已正确安装。' : '',
          password: '',
          confirm: '',
          useBiometric: false,
          busy: false,
          biometricBusy: false,
          retryAfterMs: 0,
          help: false,
          success: null,
          biometricPending: false,
          onPassword: () => {},
          onConfirm: () => {},
          onBiometricToggle: () => {},
          onSubmit: () => {},
          onBiometric: () => {},
          onHelpToggle: () => {},
          onRetry: () => {
            void refresh()
          },
        })
      }

      return h(LockScreen, {
        status,
        mode,
        error,
        password,
        confirm,
        useBiometric,
        busy,
        biometricBusy,
        retryAfterMs,
        help,
        success,
        biometricPending,
        onPassword: (value) => setPassword(value),
        onConfirm: (value) => setConfirm(value),
        onBiometricToggle: (value) => setUseBiometric(value),
        onSubmit: () => {
          void submit()
        },
        onBiometric: () => {
          void unlockWithBiometrics()
        },
        onHelpToggle: () => setHelp((previous) => !previous),
      })
    }

    //#endregion

    //#region settings page (presentational)

    /**
     * The "安全锁定" settings page body.
     * @param {object} props - settings props from the controller.
     */
    function SettingsView(props) {
      const status = props.status
      const unavailable = status !== null && status.biometricAvailable !== true
      return h('div', { className: 'dshl-settings' }, [
        h('section', { key: 'state', className: 'dshl-section' }, [
          h('h2', { key: 'title', className: 'dshl-sectionTitle' }, '锁定状态'),
          h('div', { key: 'grid', className: 'dshl-grid' }, [
            h('span', { key: 'k1', className: 'dshl-key' }, '规则'),
            h('span', { key: 'v1' }, '每次启动 DSH、或 48 小时未验证后，需要重新解锁。'),
            h('span', { key: 'k2', className: 'dshl-key' }, '当前会话'),
            h('span', { key: 'v2' }, status === null ? '读取中…' : status.locked ? '已锁定' : '已解锁'),
            h('span', { key: 'k3', className: 'dshl-key' }, '上次验证'),
            h('span', { key: 'v3' }, status === null ? '—' : formatTime(status.lastUnlockAt)),
            h('span', { key: 'k4', className: 'dshl-key' }, '密码'),
            h('span', { key: 'v4' }, status !== null && status.passwordIsDefault ? '默认密码 4396（建议修改）' : '已自定义'),
            h('span', { key: 'k5', className: 'dshl-key' }, 'Touch ID'),
            h('span', { key: 'v5' }, status === null
              ? '读取中…'
              : unavailable
                ? '此 Mac 不可用（需支持并录入 Touch ID）'
                : status.biometricEnabled ? '已启用' : '未启用'),
          ]),
          h('div', { key: 'actions', className: 'dshl-actions' }, [
            h('button', {
              key: 'lock',
              type: 'button',
              className: 'dshl-secondary',
              onClick: props.onLockNow,
            }, '立即锁定'),
          ]),
        ]),

        h('section', { key: 'password', className: 'dshl-section' }, [
          h('h2', { key: 'title', className: 'dshl-sectionTitle' }, '修改密码'),
          h(PasswordField, {
            key: 'current',
            label: '当前密码',
            value: props.currentPassword,
            autoComplete: 'current-password',
            onChange: props.onCurrentPassword,
          }),
          h(PasswordField, {
            key: 'next',
            label: '新密码',
            value: props.nextPassword,
            autoComplete: 'new-password',
            placeholder: '至少 4 位，内容不限',
            onChange: props.onNextPassword,
          }),
          h(PasswordField, {
            key: 'confirm',
            label: '确认新密码',
            value: props.confirmPassword,
            autoComplete: 'new-password',
            onChange: props.onConfirmPassword,
          }),
          h('div', { key: 'actions', className: 'dshl-actions' }, [
            h('button', {
              key: 'save',
              type: 'button',
              className: 'dshl-primary',
              onClick: props.onChangePassword,
            }, '保存新密码'),
          ]),
        ]),

        h('section', { key: 'biometric', className: 'dshl-section' }, [
          h('h2', { key: 'title', className: 'dshl-sectionTitle' }, 'Touch ID'),
          h('label', { key: 'toggle', className: 'dshl-check' }, [
            h('input', {
              key: 'input',
              type: 'checkbox',
              checked: status !== null && status.biometricEnabled === true,
              disabled: status === null || unavailable,
              onChange: (event) => props.onToggleBiometric(event.target.checked),
            }),
            h('span', { key: 'text' }, unavailable
              ? '此 Mac 不可用（需要支持并已录入 Touch ID）'
              : '允许使用 Touch ID 解锁（认证失败时可回退到系统登录密码）'),
          ]),
        ]),

        h('section', { key: 'recovery', className: 'dshl-section' }, [
          h('h2', { key: 'title', className: 'dshl-sectionTitle' }, '忘记密码'),
          h('p', { key: 'body', className: 'dshl-helpBody' }, '在终端执行下面的命令后，密码会恢复为默认密码 4396；重新打开 DSH 时输入 4396 解锁，再回到这里设置新密码。'),
          h('code', { key: 'cmd', className: 'dshl-code' }, status === null ? '' : status.resetCommand ?? ''),
        ]),

        props.feedback !== ''
          ? h('p', { key: 'feedback', className: props.feedbackError === true ? 'dshl-error' : 'dshl-ok' }, props.feedback)
          : null,
      ])
    }

    //#endregion

    //#region header lock button

    /** One-click lock control shown in the Session header's right-hand utilities. */
    function LockButton() {
      const [busy, setBusy] = React.useState(false)
      const [pressed, setPressed] = React.useState(false)

      const lockNow = async () => {
        if (busy) return
        setBusy(true)
        setPressed(true)
        try {
          await api(API.lock, { method: 'POST', body: {} })
          emitGate(true)
          report('locked', { mode: 'locked', locked: true })
          window.setTimeout(() => setPressed(false), 520)
        } catch (error) {
          report('lock-failed', { mode: 'locked', locked: false })
          setPressed(false)
        } finally {
          setBusy(false)
        }
      }

      return h('button', {
        type: 'button',
        className: 'dshl-lockButton' + (pressed ? ' dshl-lockButtonPressed' : ''),
        title: '锁定 DSH',
        'aria-label': '锁定 DSH',
        disabled: busy,
        onClick: () => {
          void lockNow()
        },
      }, h(LockGlyph, { size: 17 }))
    }

    //#endregion

    //#region settings page (controller)

    /** The settings section registered under Settings → 安全锁定. */
    function LockSettings() {
      const [status, setStatus] = React.useState(null)
      const [currentPassword, setCurrentPassword] = React.useState('')
      const [nextPassword, setNextPassword] = React.useState('')
      const [confirmPassword, setConfirmPassword] = React.useState('')
      const [feedback, setFeedback] = React.useState('')
      const [feedbackError, setFeedbackError] = React.useState(false)

      const refresh = React.useCallback(async () => {
        try {
          const payload = await api(API.status)
          setStatus(payload)
        } catch (failure) {
          setFeedback(failure instanceof Error ? failure.message : String(failure))
          setFeedbackError(true)
        }
      }, [])

      React.useEffect(() => {
        void refresh()
        const onFocus = () => {
          void refresh()
        }
        window.addEventListener('focus', onFocus)
        document.addEventListener('visibilitychange', onFocus)
        return () => {
          window.removeEventListener('focus', onFocus)
          document.removeEventListener('visibilitychange', onFocus)
        }
      }, [refresh])

      const notify = (message, isError) => {
        setFeedback(message)
        setFeedbackError(isError === true)
        report('settings', { mode: 'settings', locked: status?.locked === true, configured: status?.configured === true })
      }

      const lockNow = async () => {
        try {
          const payload = await api(API.lock, { method: 'POST', body: {} })
          setStatus(payload.status)
          emitGate(true)
          notify('已锁定。', false)
        } catch (failure) {
          notify(failure instanceof Error ? failure.message : String(failure), true)
        }
      }

      const changePassword = async () => {
        if (nextPassword !== confirmPassword) {
          notify('两次输入的新密码不一致', true)
          return
        }
        try {
          const payload = await api(API.password, {
            method: 'POST',
            body: { currentPassword, newPassword: nextPassword },
          })
          setStatus(payload.status)
          setCurrentPassword('')
          setNextPassword('')
          setConfirmPassword('')
          notify('密码已更新。', false)
        } catch (failure) {
          notify(failure instanceof Error ? failure.message : String(failure), true)
        }
      }

      const toggleBiometric = async (enabled) => {
        try {
          const payload = await api(API.biometricSetting, { method: 'POST', body: { enabled } })
          setStatus(payload.status)
          notify(enabled ? '已启用 Touch ID。' : '已关闭 Touch ID。', false)
        } catch (failure) {
          notify(failure instanceof Error ? failure.message : String(failure), true)
        }
      }

      return h(SettingsView, {
        status,
        currentPassword,
        nextPassword,
        confirmPassword,
        feedback,
        feedbackError,
        onCurrentPassword: (value) => setCurrentPassword(value),
        onNextPassword: (value) => setNextPassword(value),
        onConfirmPassword: (value) => setConfirmPassword(value),
        onLockNow: () => {
          void lockNow()
        },
        onChangePassword: () => {
          void changePassword()
        },
        onToggleBiometric: (enabled) => {
          void toggleBiometric(enabled)
        },
      })
    }

    //#endregion

    //#region styles

    /** Inject or refresh the plugin stylesheet. */
    function ensureStyle() {
      const attr = 'dsh-lock-style'
      const existing = document.querySelector('style[' + attr + ']')
      const tag = existing !== null ? existing : document.createElement('style')
      tag.setAttribute(attr, '')
      tag.textContent = [
        // ---- Liquid Glass, macOS 26 direction ---------------------------------
        // Material rules from Apple's HIG: controls float on a separate glass
        // layer, shapes are capsules with concentric radii, tint is reserved for
        // the primary action, and specular edges come from white highlight
        // lines rather than heavy outer glows.
        '.dshl-overlay{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box;background:radial-gradient(85% 65% at 12% 6%,rgba(122,162,255,.34),transparent 60%),radial-gradient(70% 55% at 92% 10%,rgba(186,150,255,.26),transparent 62%),radial-gradient(85% 70% at 48% 108%,rgba(120,220,210,.24),transparent 64%),color-mix(in srgb,var(--dsw-alias-bg-layer-1,#eef1f7) 46%,transparent);backdrop-filter:blur(46px) saturate(180%);-webkit-backdrop-filter:blur(46px) saturate(180%);animation:dshl-overlayIn .26s ease-out}',
        '.dshl-overlay *{box-sizing:border-box}',
        '.dshl-panel{position:relative;width:100%;max-width:396px;padding:28px 28px 22px;border-radius:32px;background:linear-gradient(166deg,rgba(255,255,255,.34),rgba(255,255,255,.10) 48%,rgba(255,255,255,.02)),color-mix(in srgb,var(--dsw-alias-bg-layer-1,#fff) 56%,transparent);border:1px solid color-mix(in srgb,var(--dsw-alias-border-l2,rgba(120,130,150,.35)) 32%,rgba(255,255,255,.62));box-shadow:0 32px 90px rgba(30,41,59,.20),0 6px 20px rgba(30,41,59,.07),inset 0 1px 0 rgba(255,255,255,.72),inset 0 -1px 0 rgba(16,24,40,.04),inset 0 0 0 1px rgba(255,255,255,.12);backdrop-filter:blur(36px) saturate(190%);-webkit-backdrop-filter:blur(36px) saturate(190%);color:var(--dsw-alias-label-primary,#111827);overflow:hidden;animation:dshl-panelIn .42s cubic-bezier(.22,1,.36,1) both}',
        '.dshl-panel::before{content:"";position:absolute;inset:0 0 auto;height:44%;border-radius:inherit;background:linear-gradient(180deg,rgba(255,255,255,.38),rgba(255,255,255,0));pointer-events:none;opacity:.62}',
        '.dshl-glyph{position:relative;display:inline-flex;align-items:center;justify-content:center;width:48px;height:48px;border-radius:15px;margin-bottom:15px;color:#0a84ff;background:linear-gradient(160deg,rgba(10,132,255,.15),rgba(10,132,255,.05));box-shadow:inset 0 1px 0 rgba(255,255,255,.55),inset 0 0 0 1px rgba(255,255,255,.18)}',
        '.dshl-title{margin:0 0 7px;font-size:21px;font-weight:650;line-height:1.3;letter-spacing:.1px}',
        '.dshl-hint{margin:0 0 16px;font-size:13.5px;line-height:1.6;color:var(--dsw-alias-label-secondary,#5b6472)}',
        '.dshl-note{margin:0 0 14px;padding:9px 12px;border-radius:14px;font-size:12px;line-height:1.55;background:color-mix(in srgb,var(--dsw-alias-bg-layer-2,#fff) 52%,transparent);border:1px solid color-mix(in srgb,var(--dsw-alias-border-l3,rgba(120,130,150,.28)) 45%,rgba(255,255,255,.6));color:var(--dsw-alias-label-secondary,#5b6472)}',
        '.dshl-noteWarn{background:linear-gradient(180deg,rgba(255,149,0,.16),rgba(255,149,0,.08));border-color:rgba(255,149,0,.28);color:#b26a00}',
        '.dshl-form{display:flex;flex-direction:column;gap:14px}',
        '.dshl-field{display:flex;flex-direction:column;gap:7px}',
        '.dshl-fieldLabel{font-size:12px;font-weight:500;color:var(--dsw-alias-label-secondary,#5b6472)}',
        // Capsule text field, modeled on the macOS 26 search/password field:
        // translucent fill, a hairline light border, and a quiet focus ring.
        '.dshl-input{width:100%;height:42px;padding:0 17px;border-radius:999px;border:1px solid color-mix(in srgb,var(--dsw-alias-border-l2,rgba(120,130,150,.35)) 30%,rgba(255,255,255,.6));background:color-mix(in srgb,var(--dsw-alias-bg-layer-2,#fff) 52%,transparent);color:inherit;font:inherit;font-size:14.5px;outline:none;box-shadow:inset 0 1px 2px rgba(16,24,40,.045);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);transition:border-color .18s ease,box-shadow .18s ease,background .18s ease}',
        '.dshl-input::placeholder{color:color-mix(in srgb,var(--dsw-alias-label-tertiary,#8a8f98) 88%,transparent)}',
        '.dshl-input:focus{border-color:rgba(10,132,255,.55);box-shadow:0 0 0 4px rgba(10,132,255,.14),inset 0 1px 2px rgba(16,24,40,.04)}',
        '.dshl-actions{display:flex;gap:10px;margin-top:2px}',
        // Primary action: the only tinted glass on the screen.
        '.dshl-primary{flex:1;height:43px;padding:0 20px;border:1px solid rgba(255,255,255,.30);border-radius:999px;background:linear-gradient(180deg,rgba(61,155,255,.96),rgba(10,132,255,.96));color:#fff;font:inherit;font-size:14.5px;font-weight:600;letter-spacing:.2px;cursor:pointer;box-shadow:0 7px 18px rgba(10,132,255,.22),inset 0 1px 0 rgba(255,255,255,.36),inset 0 -1px 0 rgba(0,0,0,.08);transition:transform .18s cubic-bezier(.22,1,.36,1),box-shadow .18s ease,filter .18s ease}',
        '.dshl-primary:hover:not(:disabled){filter:brightness(1.04);box-shadow:0 10px 24px rgba(10,132,255,.30),inset 0 1px 0 rgba(255,255,255,.46),inset 0 -1px 0 rgba(0,0,0,.10)}',
        '.dshl-primary:active:not(:disabled){transform:scale(.975)}',
        '.dshl-primary:disabled{opacity:.55;cursor:default}',
        // Secondary control: untinted glass capsule with a hairline edge.
        '.dshl-secondary{display:inline-flex;align-items:center;justify-content:center;gap:7px;height:43px;padding:0 20px;border-radius:999px;border:1px solid color-mix(in srgb,var(--dsw-alias-border-l2,rgba(120,130,150,.35)) 28%,rgba(255,255,255,.62));background:linear-gradient(180deg,rgba(255,255,255,.38),rgba(255,255,255,.14)),color-mix(in srgb,var(--dsw-alias-bg-layer-2,#fff) 34%,transparent);color:inherit;font:inherit;font-size:14.5px;font-weight:500;cursor:pointer;box-shadow:0 2px 6px rgba(16,24,40,.05),inset 0 1px 0 rgba(255,255,255,.55);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);transition:transform .18s cubic-bezier(.22,1,.36,1),box-shadow .18s ease,filter .18s ease}',
        '.dshl-secondary:hover:not(:disabled){filter:brightness(1.02);box-shadow:0 4px 12px rgba(16,24,40,.08),inset 0 1px 0 rgba(255,255,255,.72)}',
        '.dshl-secondary:active:not(:disabled){transform:scale(.975)}',
        '.dshl-secondary:disabled{opacity:.55;cursor:default}',
        '.dshl-link{align-self:flex-start;margin-top:2px;padding:0;border:0;background:transparent;color:#0a84ff;font:inherit;font-size:12.5px;text-decoration:none;cursor:pointer;opacity:.92;transition:opacity .16s ease}',
        '.dshl-link:hover{opacity:1;text-decoration:underline}',
        '.dshl-check{display:flex;align-items:flex-start;gap:8px;font-size:12.5px;line-height:1.5;color:var(--dsw-alias-label-secondary,#5b6472);cursor:pointer}',
        '.dshl-check input{margin-top:2px;accent-color:#0a84ff}',
        '.dshl-footnote{margin:2px 0 0;font-size:12px;color:var(--dsw-alias-label-tertiary,#6b7280)}',
        '.dshl-footnoteTight{margin:0}',
        '.dshl-error{margin:2px 0 0;font-size:12.5px;line-height:1.5;color:#ff3b30}',
        '.dshl-ok{margin:2px 0 0;font-size:12.5px;line-height:1.5;color:#248a3d}',
        '.dshl-help{margin-top:16px;padding-top:16px;border-top:1px solid color-mix(in srgb,var(--dsw-alias-border-l3,rgba(120,130,150,.28)) 55%,rgba(255,255,255,.4))}',
        '.dshl-helpTitle{font-size:12px;font-weight:600;margin-bottom:4px}',
        '.dshl-helpBody{margin:0 0 8px;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary,#5b6472)}',
        '.dshl-code{display:block;padding:10px 14px;border-radius:14px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-2,#fff) 42%,transparent);border:1px solid color-mix(in srgb,var(--dsw-alias-border-l3,rgba(120,130,150,.28)) 50%,rgba(255,255,255,.45));color:var(--dsw-alias-label-secondary,#4b5563);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;line-height:1.5;white-space:pre-wrap;word-break:break-all}',
        // ---- lock-screen extras ------------------------------------------------
        '.dshl-checking{display:flex;align-items:center;gap:10px;font-size:13px;color:var(--dsw-alias-label-secondary,#5b6472)}',
        '.dshl-spinner{width:15px;height:15px;border-radius:50%;border:2px solid rgba(10,132,255,.22);border-top-color:#0a84ff;animation:dshl-spin .8s linear infinite}',
        '.dshl-autoHint{display:flex;align-items:center;gap:8px;margin:0 0 2px;font-size:12.5px;line-height:1.5;color:var(--dsw-alias-label-secondary,#5b6472)}',
        '.dshl-autoHint svg{flex:none;opacity:.75;animation:dshl-breathe 1.9s ease-in-out infinite}',
        // ---- success animation -------------------------------------------------
        '.dshl-overlaySuccess{animation:dshl-overlayOut .55s cubic-bezier(.4,0,.2,1) .44s forwards}',
        '.dshl-panelSuccess{display:flex;align-items:center;justify-content:center;min-height:200px;padding:16px 24px;background:transparent;border:0;box-shadow:none;backdrop-filter:none;-webkit-backdrop-filter:none;animation:none}',
        '.dshl-panelSuccess::before{display:none}',
        '.dshl-success{position:relative;display:flex;flex-direction:column;align-items:center;gap:10px;padding:16px 0 8px;text-align:center;animation:dshl-successIn .45s cubic-bezier(.22,1,.36,1) both}',
        '.dshl-successAura{position:absolute;top:8px;width:160px;height:160px;border-radius:50%;filter:blur(36px);opacity:0;animation:dshl-aura 1.4s ease-out .08s forwards}',
        '.dshl-successBiometric .dshl-successAura{background:rgba(52,199,89,.40)}',
        '.dshl-successPassword .dshl-successAura{background:rgba(10,132,255,.42)}',
        '.dshl-successIcon{position:relative;display:flex;align-items:center;justify-content:center;width:82px;height:82px;border-radius:50%;animation:dshl-iconIn .6s cubic-bezier(.22,1,.36,1) .04s both}',
        '.dshl-successBiometric .dshl-successIcon{color:#248a3d;background:linear-gradient(160deg,rgba(52,199,89,.24),rgba(52,199,89,.04));box-shadow:inset 0 1px 0 rgba(255,255,255,.55),0 14px 36px rgba(52,199,89,.20)}',
        '.dshl-successPassword .dshl-successIcon{color:#0a84ff;background:linear-gradient(160deg,rgba(10,132,255,.24),rgba(10,132,255,.05));box-shadow:inset 0 1px 0 rgba(255,255,255,.55),0 14px 36px rgba(10,132,255,.20)}',
        '.dshl-successGlyph{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;opacity:.48;animation:dshl-glyphOut .55s ease-out .14s forwards}',
        '.dshl-successRing{position:absolute;inset:0;border-radius:50%;border:1px solid currentColor;opacity:0;animation:dshl-ringFade 1.1s cubic-bezier(.4,0,.2,1) .06s forwards}',
        '.dshl-successCheck{position:relative;width:46px;height:46px;fill:none;stroke:#fff;stroke-width:2.4;stroke-linecap:round;stroke-linejoin:round;stroke-dasharray:27;stroke-dashoffset:27;filter:drop-shadow(0 1px 6px rgba(0,0,0,.22));animation:dshl-checkDraw .55s cubic-bezier(.22,1,.36,1) .22s forwards}',
        '.dshl-successTitle{font-size:15px;font-weight:600;letter-spacing:.1px;opacity:0;animation:dshl-rise .45s cubic-bezier(.22,1,.36,1) .36s forwards}',
        '.dshl-successBiometric .dshl-successTitle{color:#1e7c3a}',
        '.dshl-successPassword .dshl-successTitle{color:#0a6ed1}',
        '.dshl-successHint{font-size:12px;color:var(--dsw-alias-label-tertiary,#6b7280);opacity:0;animation:dshl-rise .45s cubic-bezier(.22,1,.36,1) .48s forwards}',
        '.dshl-shackleOpen{animation:dshl-lift .55s cubic-bezier(.22,1,.36,1) forwards}',
        // ---- header lock button -------------------------------------------------
        '.dshl-lockButton{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;padding:0;border:1px solid transparent;border-radius:10px;background:transparent;color:var(--dsw-alias-label-secondary,#5b6472);cursor:pointer;transition:background .18s ease,color .18s ease,transform .18s cubic-bezier(.22,1,.36,1),border-color .18s ease,box-shadow .18s ease}',
        '.dshl-lockButton:hover{background:linear-gradient(180deg,rgba(255,255,255,.30),rgba(255,255,255,.08)),color-mix(in srgb,var(--dsw-alias-bg-layer-2,#fff) 45%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-border-l3,rgba(120,130,150,.3)) 55%,rgba(255,255,255,.6));color:var(--dsw-alias-label-primary,#111827);box-shadow:inset 0 1px 0 rgba(255,255,255,.5),0 3px 10px rgba(16,24,40,.07)}',
        '.dshl-lockButton:active{transform:scale(.94)}',
        '.dshl-lockButton:disabled{opacity:.55;cursor:default}',
        '.dshl-lockButtonPressed{animation:dshl-lockPress .5s cubic-bezier(.22,1,.36,1)}',
        // ---- settings page ------------------------------------------------------
        '.dshl-settings{display:flex;flex-direction:column;gap:18px;max-width:760px;padding:2px 0}',
        '.dshl-section{display:flex;flex-direction:column;gap:10px;padding:18px 20px;border-radius:22px;background:linear-gradient(165deg,rgba(255,255,255,.34),rgba(255,255,255,.06)),color-mix(in srgb,var(--dsw-alias-bg-layer-1,#fff) 62%,transparent);border:1px solid color-mix(in srgb,var(--dsw-alias-border-l2,rgba(120,130,150,.35)) 45%,rgba(255,255,255,.6));box-shadow:inset 0 1px 0 rgba(255,255,255,.6),0 10px 28px rgba(16,24,40,.07);backdrop-filter:blur(18px) saturate(150%);-webkit-backdrop-filter:blur(18px) saturate(150%)}',
        '.dshl-sectionTitle{margin:0;font-size:13px;font-weight:650;letter-spacing:.1px}',
        '.dshl-grid{display:grid;grid-template-columns:88px minmax(0,1fr);gap:8px 16px;font-size:12.5px;line-height:1.5}',
        '.dshl-key{color:var(--dsw-alias-label-tertiary,#6b7280)}',
        // ---- keyframes ---------------------------------------------------------
        '@keyframes dshl-overlayIn{from{opacity:0}to{opacity:1}}',
        '@keyframes dshl-panelIn{from{opacity:0;transform:translateY(10px) scale(.982)}to{opacity:1;transform:none}}',
        '@keyframes dshl-successIn{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:none}}',
        '@keyframes dshl-iconIn{from{opacity:0;transform:scale(.88)}to{opacity:1;transform:scale(1)}}',
        '@keyframes dshl-glyphOut{from{opacity:.48;transform:scale(1)}to{opacity:0;transform:scale(.78)}}',
        '@keyframes dshl-ringFade{0%{opacity:.4;transform:scale(.92)}70%{opacity:.12}100%{opacity:0;transform:scale(1.26)}}',
        '@keyframes dshl-checkDraw{0%{stroke-dashoffset:27;opacity:0}35%{opacity:1}100%{stroke-dashoffset:0;opacity:1}}',
        '@keyframes dshl-aura{0%{opacity:0;transform:scale(.72)}55%{opacity:.40}100%{opacity:.14;transform:scale(1.06)}}',
        '@keyframes dshl-rise{from{opacity:0;transform:translateY(3px)}to{opacity:1;transform:none}}',
        '@keyframes dshl-overlayOut{to{opacity:0;transform:scale(.996)}}',
        '@keyframes dshl-lift{to{transform:translateY(-3px)}}',
        '@keyframes dshl-breathe{0%,100%{opacity:.45}50%{opacity:.85}}',
        '@keyframes dshl-spin{to{transform:rotate(360deg)}}',
        '@keyframes dshl-lockPress{0%{transform:scale(1)}35%{transform:scale(.86)}70%{transform:scale(1.06)}100%{transform:scale(1)}}',
        '@media (prefers-reduced-transparency:reduce){.dshl-overlay{background:rgba(16,20,28,.82);backdrop-filter:none;-webkit-backdrop-filter:none}.dshl-panel{background:var(--dsw-alias-bg-layer-1,#fff);backdrop-filter:none;-webkit-backdrop-filter:none}}',
      ].join('\n')
      if (existing === null) document.head.appendChild(tag)
    }

    //#endregion

    //#region apply

    /**
     * Register the gate overlay and the settings page.
     * @param {object} ctx - client plugin context.
     */
    function apply(ctx) {
      ensureStyle()
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-lock: copy')
      const t = ctx.locale.bind(NS)
      report('mounted', { locked: false, configured: false })
      ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'dsh-lock',
        order: 1000,
        label: () => t('overlay.title'),
      }, LockOverlay)), 'dsh-lock: lock overlay')
      surfaces.overlay = true
      ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'dsh-lock',
        order: 60,
        label: () => t('settings.label'),
      }, LockSettings)), 'dsh-lock: settings section')
      surfaces.settings = true
      ctx.effect(() => ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
        name: 'conversation.session.header.utilities',
        id: 'dsh-lock-lock',
        order: 900,
        label: () => t('lockButton.label'),
      }, LockButton)), 'dsh-lock: header lock button')
      surfaces.lockButton = true
      report('ready')
    }

    const inject = ['slots', 'locale']

    exports.apply = apply
    exports.inject = inject
    exports.__test = {
      VERSION,
      LockOverlay,
      LockSettings,
      LockButton,
      LockGlyph,
      FingerprintGlyph,
      LockScreen,
      SetupForm,
      UnlockForm,
      SettingsView,
      reasonText,
      formatRelative,
      formatTime,
    }

    return module.exports
  },
})
