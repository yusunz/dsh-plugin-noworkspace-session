/**
 * dsh-plugin-noworkspace-session — browser half.
 *
 * Two registrations, both additive — this plugin replaces no host UI:
 *   1. `conversation.input.dock` (list): one chip that starts a session outside
 *      every workspace. `conversation.hero.options` — the seat that would put it
 *      inside the hero row — is declared by newer harness builds only, so the
 *      registration is attempted there first and the dock takes over when the
 *      seat is absent. The shipped workspace picker is never touched, so its
 *      menu, modal and directory flow stay native.
 *   2. `settings.general.item` (list): the Codex-style default-folder row, read
 *      and written through the config form mirror (persists into the profile
 *      cordis.patch.yml).
 *
 * A session created here is ungrouped, so the shipped hero would render its
 * composer inert (`inert = hero && chipTitle === undefined`). The Host half
 * mounts the blank session in a temporary workspace at its own cwd, which makes
 * the native composer live; the first user message then retires that workspace
 * and the session falls back to Ungrouped. This half only waits for the mount
 * before opening the session.
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-noworkspace-session',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect } = React

    const NS = 'noworkspace'
    /** Loader row id in cordis.patch.yml; also the config-form namespace. */
    const ENTRY_ID = 'noworkspace-session'
    /** Owner-prop prefix that marks this plugin's sessions to the Host half. */
    const SESSION_PREFIX = 'session-nws-'
    const DEFAULT_DIR = '~/Documents/dsh'

    const zh = {
      'chip.label': '不在工作区中工作',
      'chip.title': '在无项目任务文件夹中新建会话（不占用任何工作区）',
      'chip.busy': '正在创建…',
      'chip.error': '创建失败：{message}',
      'chip.noHome': '无法确定宿主主目录',
      'settings.title': '无项目任务文件夹',
      'settings.description': '在项目外启动的任务默认存储数据的位置。',
      'settings.change': '更改',
      'settings.reset': '重置',
      'settings.error': '保存失败：{message}',
      'settings.writeFailed': '宿主拒绝了这次写入',
    }

    const en = {
      'chip.label': 'Work without a workspace',
      'chip.title': 'Start a session in the no-project task folder (occupies no workspace)',
      'chip.busy': 'Creating…',
      'chip.error': 'Could not create: {message}',
      'chip.noHome': 'Cannot determine the host home directory',
      'settings.title': 'Default folder for no-project tasks',
      'settings.description': 'Where tasks started outside a project store their data.',
      'settings.change': 'Change',
      'settings.reset': 'Reset',
      'settings.error': 'Save failed: {message}',
      'settings.writeFailed': 'The host rejected this write',
    }

    /* Chip geometry mirrors the agent-preset seat in the hero row
       (ui-agent-preset AgentPresetSeat.module.css): same min-height, 8px side
       padding, 4px gap and hover fill, so the two read as one line.
       Harness builds without `conversation.hero.options` offer no additive seat
       in that row, so the chip rides the composer dock and lifts itself onto the
       row's baseline instead: the dock row collapses to zero height with -3px
       vertical margins (cancelling the two stack gaps it would otherwise add),
       and the chip is anchored one stack gap above it, right-aligned to the card
       edge opposite the workspace chip.
       The lifted box spans the row's width but must stay transparent to pointer
       events — otherwise it would swallow clicks on the native workspace chip
       sitting in the same line. */
    const CSS = `
.nws-dock{position:relative;height:0;display:flex;justify-content:flex-end;margin:-3px 0}
.nws-dockInner{position:absolute;left:0;right:0;bottom:calc(100% + var(--dsh-composer-stack-gap,6px));display:flex;justify-content:flex-end;max-width:calc(var(--dsh-composer-card-max-width,952px) - 4 * var(--dsh-composer-dock-inset,4px));margin:0 auto;pointer-events:none}
.nws-dockInner>*{pointer-events:auto}
.nws-chip{display:inline-flex;align-items:center;gap:4px;min-width:0;max-width:min(100%,240px);min-height:28px;padding:0 8px;border:none;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:13px;line-height:20px;font-weight:500;white-space:nowrap;cursor:pointer}
.nws-chip:not(:disabled):hover{background:var(--dsw-alias-interactive-bg-hover)}
.nws-chip:disabled{cursor:default;color:var(--dsw-alias-label-secondary)}
.nws-chip:focus-visible{outline:1px solid var(--dsw-alias-brand-primary);outline-offset:-1px}
.nws-chipIcon{flex:none;display:inline-flex;color:currentColor}
.nws-chipLabel{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nws-chipError{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}
.nws-row{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px 24px;padding:16px 0;border-bottom:.5px solid var(--dsw-alias-border-l2)}
.nws-rowMain{flex:1;min-width:200px}
.nws-rowTitle{font-size:14px;line-height:20px}
.nws-rowDesc{margin-top:4px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.nws-rowError{margin-top:6px;color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}
.nws-rowControls{display:flex;align-items:center;gap:8px;flex:none}
.nws-path{color:var(--dsw-alias-label-secondary);font-family:var(--ds-font-family-code,monospace);font-size:12px;max-width:340px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;direction:ltr;text-align:right}
.nws-btn{padding:5px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm,4px);background:transparent;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:13px;line-height:18px;cursor:pointer;white-space:nowrap}
.nws-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.nws-btn:disabled{opacity:.45;cursor:default}
.nws-btnQuiet{border-color:transparent;color:var(--dsw-alias-label-secondary)}
.nws-btnQuiet:hover:not(:disabled){color:var(--dsw-alias-label-primary)}
`

    // ---- small helpers -------------------------------------------------

    /** RFC4122-ish id: crypto.randomUUID when available, Math.random fallback. */
    function uid() {
      if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID()
      return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0
        const v = c === 'x' ? r : (r & 0x3) | 0x8
        return v.toString(16)
      })
    }

    /** Expand a leading `~` against the host home; non-`~` paths pass through. */
    function expandHome(path, home) {
      if (path === '~') return home ?? path
      if (path.startsWith('~/') || path.startsWith('~\\')) {
        if (!home) return path
        const sep = home.includes('\\') ? '\\' : '/'
        return home.replace(/[\\/]+$/, '') + sep + path.slice(2).replace(/\//g, sep)
      }
      return path
    }

    /** Fold any thrown value into one operator-facing message (keeps Host codes). */
    function msg(e) {
      if (e && typeof e === 'object') {
        if (e.error && typeof e.error.message === 'string' && e.error.message) {
          return (e.error.code ? e.error.code + ': ' : '') + e.error.message
        }
        if (typeof e.message === 'string' && e.message) return e.message
      }
      return String(e)
    }

    /** The session the main panel currently shows (`retainedBy.mainView`, same read the sidebar uses). */
    function mainSessionId(list) {
      for (const id of list.ids) {
        const summary = list.byId[id]
        if (summary !== undefined && (summary.retainedBy?.mainView ?? 0) > 0) return id
      }
      return undefined
    }

    const svg = (children) => h('svg', {
      viewBox: '0 0 16 16', width: 16, height: 16, fill: 'none', stroke: 'currentColor',
      strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round',
      'aria-hidden': true, focusable: false, className: 'nws-chipIcon',
    }, children)
    const icoNoWorkspace = () => svg([
      h('path', { d: 'M1.5 4.4c0-.66.54-1.2 1.2-1.2h3l1.4 1.5h6.2c.66 0 1.2.54 1.2 1.2v6.5c0 .66-.54 1.2-1.2 1.2H2.7c-.66 0-1.2-.54-1.2-1.2V4.4Z' }),
      h('path', { d: 'M3 13 13 3' }),
    ])

    // ---- 1. hero entry: start a session outside every workspace --------

    /** The chip itself, shared by both seats; no host component is replaced. */
    function UngroupedChip({ start, t }) {
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      const onClick = async () => {
        if (busy) return
        setBusy(true)
        setError(null)
        try { await start() } catch (e) { setError(msg(e)) } finally { setBusy(false) }
      }
      return h('button', {
        type: 'button', className: 'nws-chip', disabled: busy, title: t('chip.title'),
        onClick: () => { void onClick() },
      },
        icoNoWorkspace(),
        h('span', { className: 'nws-chipLabel' }, busy ? t('chip.busy') : t('chip.label')),
        error !== null && h('span', { className: 'nws-chipError', role: 'alert' }, t('chip.error', { message: error })))
    }

    /**
     * Seat for the settled hero row (`conversation.hero.options`), which newer
     * harness builds declare next to the workspace picker. Absent from the
     * installed build, so its registration silently never fires there.
     */
    function HeroChip({ start, t }) {
      return h(UngroupedChip, { start, t })
    }

    /**
     * Seat that exists in every build: the composer stack's full-width dock,
     * which sits between the hero row and the input card. It renders for every
     * Session, so it shows the entry only where the shipped composer would be
     * inert — a blank Session that is not already ours. Reads the standard
     * `useSessions` seat rather than owner props, which the installed build's
     * dock registration need not carry.
     */
    function DockChip({ start, seatTaken, useSessions, t }) {
      const list = useSessions((s) => s)
      const current = mainSessionId(list)
      const summary = current === undefined ? undefined : list.byId[current]
      const own = typeof current === 'string' && current.startsWith(SESSION_PREFIX)
      if (seatTaken() || summary === undefined || summary.blank !== true || own) return null
      return h('div', { className: 'nws-dock' },
        h('div', { className: 'nws-dockInner' }, h(UngroupedChip, { start, t })))
    }

    // ---- 2. settings row ----------------------------------------------

    /** Codex-style row: current folder + Change/Reset over the config form mirror. */
    function DefaultDirRow({ useDirForm, change, reset, homeOf, t }) {
      const snap = useDirForm((s) => s)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      const raw = snap && typeof snap.value === 'object' && snap.value && typeof snap.value.defaultDir === 'string' && snap.value.defaultDir.trim() !== ''
        ? snap.value.defaultDir
        : DEFAULT_DIR
      let shown = raw
      try { shown = expandHome(raw, homeOf()) } catch { shown = raw }
      const writable = snap === undefined || snap.status === undefined ? false : (snap.status === 'ready' && snap.writable !== false)
      const overridden = snap !== undefined && snap.user !== undefined
      const run = async (fn) => {
        if (busy) return
        setBusy(true)
        setError(null)
        try { await fn() } catch (e) { setError(msg(e)) } finally { setBusy(false) }
      }
      return h('div', { className: 'nws-row' },
        h('div', { className: 'nws-rowMain' },
          h('div', { className: 'nws-rowTitle' }, t('settings.title')),
          h('div', { className: 'nws-rowDesc' }, t('settings.description')),
          error !== null && h('div', { className: 'nws-rowError', role: 'alert' }, t('settings.error', { message: error }))),
        h('div', { className: 'nws-rowControls' },
          h('span', { className: 'nws-path', title: shown }, shown),
          h('button', { type: 'button', className: 'nws-btn', disabled: !writable || busy, onClick: () => void run(change) }, t('settings.change')),
          h('button', { type: 'button', className: 'nws-btn nws-btnQuiet', disabled: !writable || !overridden || busy, onClick: () => void run(reset) }, t('settings.reset'))))
    }

    // ---- assembly -------------------------------------------------------

    function apply(ctx) {
      const style = document.createElement('style')
      style.setAttribute('data-plugin', 'dsh-plugin-noworkspace-session')
      style.textContent = CSS
      document.head.appendChild(style)
      ctx.effect(() => () => { style.remove() }, 'noworkspace-session: styles')

      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'noworkspace-session: dictionaries')
      const t = ctx.locale.bind(NS)

      const hostHome = () => {
        try { return ctx.remote && ctx.remote.$host ? ctx.remote.$host.home : undefined } catch { return undefined }
      }
      const readDefaultDir = () => {
        try {
          const forms = ctx.get('configForms')
          const form = forms ? forms.get(ENTRY_ID) : undefined
          const snap = form ? form.getSnapshot() : undefined
          const v = snap && snap.value ? snap.value.defaultDir : undefined
          if (typeof v === 'string' && v.trim() !== '') return v.trim()
        } catch { /* form unavailable → schema default */ }
        return DEFAULT_DIR
      }

      /** Create the session under `<defaultDir>\<date>\<time>`; Host mkdirs recursively. */
      const createUngrouped = async () => {
        const home = hostHome()
        const raw = readDefaultDir()
        if (raw.startsWith('~') && !home) throw new Error(t('chip.noHome'))
        const base = expandHome(raw, home).replace(/[\\/]+$/, '')
        const sep = base.includes('\\') ? '\\' : '/'
        const now = new Date()
        const pad = (n) => String(n).padStart(2, '0')
        const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
        const time = `${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`
        const cwd = `${base}${sep}${date}${sep}${time}`
        const sessionId = `${SESSION_PREFIX}${uid()}`
        const created = await ctx.sessions.create({ cwd, sessionId })
        await waitForWorkspaceMount(created, cwd)
        return created
      }

      /**
       * Wait until the Host half mounted the session in its own workspace. The
       * native composer is inert until then, so opening early would flash the
       * "choose a workspace" bar. A timeout still opens the session.
       */
      const waitForWorkspaceMount = async (sessionId, path) => {
        const mounted = () => ctx.workspaces.list.getSnapshot().items
          .some((w) => w.path === path && w.sessionIds.includes(sessionId))
        const deadline = Date.now() + 4000
        while (Date.now() < deadline) {
          if (mounted()) return
          await new Promise((resolve) => { setTimeout(resolve, 50) })
        }
      }

      /** Chip action: reuse the current blank scratch session, else create and open one. */
      const start = async () => {
        const list = ctx.sessions.list.getSnapshot()
        const current = mainSessionId(list)
        if (typeof current === 'string' && current.startsWith(SESSION_PREFIX) && list.byId[current]?.blank === true) {
          ctx.uiWorkspace.openSession(current)
          return
        }
        ctx.uiWorkspace.openSession(await createUngrouped())
      }

      // 1) the entry itself, in whichever additive seat this harness declares.
      //    Both registrations are inert when their slot is absent: `slots.inject`
      //    only installs while the owning declaration is live, so the newer
      //    `conversation.hero.options` seat stays empty on today's build and the
      //    dock takes over. `heroSeatLive` keeps a future build from showing both.
      let heroSeatLive = false
      ctx.effect(() => ctx.slots.inject('conversation.hero.options', () => {
        heroSeatLive = true
        return ctx.slots.register({
          name: 'conversation.hero.options',
          id: 'noworkspace-ungrouped',
          order: 10,
          locale: NS,
          inject: () => ({ start }),
        }, HeroChip)
      }), 'noworkspace-session: hero options chip')

      ctx.effect(() => ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
        name: 'conversation.input.dock',
        id: 'noworkspace-ungrouped',
        order: 10,
        locale: NS,
        inject: () => ({ start, seatTaken: () => heroSeatLive }),
      }, DockChip)), 'noworkspace-session: composer dock chip')

      // 2) settings row — only when the config-form mirror is present
      ctx.inject(['configForms'], (child) => {
        const form = child.configForms.get(ENTRY_ID)
        const change = async () => {
          const path = await ctx.uiWorkspace.pickDirectory()
          if (!path) return
          const ok = await form.set('defaultDir', path)
          if (!ok) throw new Error(t('settings.writeFailed'))
        }
        const reset = async () => {
          const ok = await form.unset('defaultDir')
          if (!ok) throw new Error(t('settings.writeFailed'))
        }
        child.effect(() => child.slots.inject('settings.general.item', () => child.slots.register({
          name: 'settings.general.item',
          id: 'noworkspace-default-dir',
          order: 50,
          locale: NS,
          inject: () => ({ hooks: { dirForm: form }, change, reset, homeOf: hostHome }),
        }, DefaultDirRow)), 'noworkspace-session: settings row')
      })
    }

    return {
      inject: ['slots', 'locale', 'remote', 'sessions', 'uiWorkspace', 'workspaces'],
      apply,
    }
  },
})
