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
    const { useState } = React

    const NS = 'noworkspace'
    /** `id` of this plugin's row in cordis.patch.yml; the loader may qualify it for us. */
    const ENTRY_ID = 'noworkspace-session'
    /**
     * Settings namespaces this plugin's row may appear under. The Host keys a
     * config form by the loader *entry* id, which is the patch id with an
     * `include:` qualifier, and a bundle re-export can add the package name; the
     * probing client reports `unavailable` for every spelling it does not serve,
     * so the served one is picked from the describe mirror instead of assumed.
     */
    const ENTRY_IDS = [ENTRY_ID, `include:${ENTRY_ID}`, 'dsh-plugin-noworkspace-session']
    /** Distinctive fragment that identifies this plugin's namespace in the mirror. */
    const NAMESPACE_HINT = 'noworkspace'
    /** Owner-prop prefix that marks this plugin's sessions to the Host half. */
    const SESSION_PREFIX = 'session-nws-'
    /** Workspace-title prefix the Host half stamps; the sweep recognizes its own mounts by it. */
    const MOUNT_TITLE_PREFIX = '无项目任务 · '
    /** How long a just-created mount is protected while `openSession` catches up. */
    const ADOPTION_WINDOW_MS = 15000
    /** A mount never seen as the current Session is held this long before it counts as abandoned. */
    const MOUNT_MIN_AGE_MS = 60000
    /** Safety-net re-check; subscriptions already retire a group the moment the operator moves away. */
    const MOUNT_SWEEP_INTERVAL_MS = 3000
    const DEFAULT_DIR = '~/Documents/dsh'
    /** Tab-type identity in the right sidebar registry; also the guide card's slot key. */
    const SIDEBAR_TYPE_ID = 'dsh-plugin-noworkspace-session'

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
      'settings.unavailable': '该设置项在宿主中不可写（配置命名空间未暴露）',
      'card.title': '非工作区会话',
      'card.description': '在无项目任务的临时目录中新建会话，并在主视图打开',
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
      'settings.unavailable': 'This setting is not writable on the host (config namespace not exposed)',
      'card.title': 'Session without a workspace',
      'card.description': 'Start a session in the no-project task folder and open it in the main view',
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
/* The guide capsule below copies the shipped card's own sheet
   (ui-sidebar-right GuideBody.module.css .entry): same 380px cell, 56px
   minimum, 14/20 padding, 0.5px border on the l3 border token, radius-xl and
   the layer-1 fill. A custom card replaces the shipped one wholesale, so these
   specs have to travel with it to stay indistinguishable in the column. */
.nws-card{display:flex;gap:14px;align-items:center;box-sizing:border-box;width:100%;min-height:56px;padding:14px 20px;color:var(--dsw-alias-label-primary);font:inherit;text-align:left;background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-xl,10px);cursor:pointer}
.nws-card:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.nws-card:disabled{cursor:default;opacity:.65}
.nws-card:focus-visible{outline:1px solid var(--dsw-alias-brand-primary);outline-offset:-1px}
.nws-cardIcon{display:flex;flex:none;align-items:center;justify-content:center;width:26px;height:26px;color:var(--dsw-alias-label-secondary)}
.nws-cardText{display:flex;flex:1;flex-direction:column;gap:3px;min-width:0}
.nws-cardTitle{overflow:hidden;font-size:14px;line-height:1.4;white-space:nowrap;text-overflow:ellipsis}
.nws-cardDesc{overflow:hidden;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1.4;white-space:nowrap;text-overflow:ellipsis}
.nws-cardError{overflow:hidden;color:var(--dsw-alias-state-error-primary);font-size:11px;line-height:1.4;white-space:nowrap;text-overflow:ellipsis}
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

    const svg = (children, size) => h('svg', {
      viewBox: '0 0 16 16', width: size, height: size, fill: 'none', stroke: 'currentColor',
      strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round',
      'aria-hidden': true, focusable: false, className: 'nws-chipIcon',
    }, children)
    const icoNoWorkspace = (size = 16) => svg([
      h('path', { d: 'M1.5 4.4c0-.66.54-1.2 1.2-1.2h3l1.4 1.5h6.2c.66 0 1.2.54 1.2 1.2v6.5c0 .66-.54 1.2-1.2 1.2H2.7c-.66 0-1.2-.54-1.2-1.2V4.4Z' }),
      h('path', { d: 'M3 13 13 3' }),
    ], size)

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
     * Glyph for the guide capsule; the registry wants a component, not an element.
     * @param props - `size` in pixels, as the guide's icon contract passes it.
     * @returns the element to draw.
     */
    function GuideIcon({ size }) {
      return icoNoWorkspace(typeof size === 'number' ? size : 22)
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

    /**
     * Card in the right sidebar's guide ("开始") page.
     *
     * The guide entry is a tab *type* seat: a registered type contributes its
     * entry capsule and the shipped card would open a pane of that type. This
     * plugin has no pane, so it registers the seat's own card and spends the
     * click on the same action as the chip — create the session and open it in
     * the main view. `title`/`description` come from the guide entry the tab
     * registry carries, so the copy stays localized in one place.
     */
    function GuideCard({ title, description, start, t }) {
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      const onClick = async () => {
        if (busy) return
        setBusy(true)
        setError(null)
        try { await start() } catch (e) { setError(msg(e)) } finally { setBusy(false) }
      }
      return h('button', {
        type: 'button', className: 'nws-card', disabled: busy,
        // The guide only prints a description while it lists few entries, so the
        // hover hint keeps the copy available in a crowded one.
        title: description === undefined ? title : `${title} — ${description}`,
        'data-sidebar-right-guide-entry': 'noworkspace',
        onClick: () => { void onClick() },
      },
        h('span', { className: 'nws-cardIcon', 'aria-hidden': 'true' }, icoNoWorkspace(24)),
        h('span', { className: 'nws-cardText' },
          h('span', { className: 'nws-cardTitle' }, busy ? t('chip.busy') : title),
          // No fallback copy: the guide passes a description only while it lists
          // few enough entries, and a card that always carried one would stand
          // out beside its neighbours the moment the guide drops theirs.
          error !== null
            ? h('span', { className: 'nws-cardError', role: 'alert' }, t('chip.error', { message: error }))
            : description !== undefined && h('span', { className: 'nws-cardDesc' }, description)))
    }

    // ---- 2. settings row ----------------------------------------------

    /**
     * Codex-style row: current folder + Change/Reset over the config form mirror.
     *
     * The buttons only stay disabled while a write is in flight, or when the Host
     * reports the namespace as not exposed at all. Gating on `status === 'ready'`
     * or `writable` looks stricter but leaves the row permanently inert whenever
     * the mirror still reports `loading`, which is indistinguishable from a
     * broken write and takes the operator's only recovery action away.
     */
    function DefaultDirRow({ useDirForm, change, reset, homeOf, t }) {
      const snap = useDirForm((s) => s)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      const value = snap?.value
      const raw = value !== null && typeof value === 'object' && typeof value.defaultDir === 'string' && value.defaultDir.trim() !== ''
        ? value.defaultDir.trim()
        : DEFAULT_DIR
      let shown = raw
      try { shown = expandHome(raw, homeOf()) } catch { shown = raw }
      // `user` is the raw user layer: a field's presence there is what marks it
      // overridden, so comparing values would miss an override equal to the default.
      const userLayer = snap?.user
      const overridden = userLayer !== null && typeof userLayer === 'object'
        && Object.prototype.hasOwnProperty.call(userLayer, 'defaultDir')
      const unavailable = snap !== undefined && snap.status === 'unavailable'
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
          error !== null && h('div', { className: 'nws-rowError', role: 'alert' }, t('settings.error', { message: error })),
          unavailable && h('div', { className: 'nws-rowError', role: 'alert' }, t('settings.unavailable'))),
        h('div', { className: 'nws-rowControls' },
          h('span', { className: 'nws-path', title: shown }, shown),
          h('button', { type: 'button', className: 'nws-btn', disabled: busy || unavailable, onClick: () => void run(change) }, t('settings.change')),
          h('button', { type: 'button', className: 'nws-btn nws-btnQuiet', disabled: busy || unavailable || !overridden, onClick: () => void run(reset) }, t('settings.reset'))))
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
      /** Config-form service; captured from the optional declaration, so a profile without it stays usable. */
      let configForms
      /**
       * The settings namespace the Host actually serves for this plugin, read from
       * the describe mirror: it is the loader *entry* id (`include:`-qualified),
       * and a wrong guess answers `unavailable` forever.
       */
      const resolveNamespace = () => {
        try {
          const forms = configForms ?? ctx.get('configForms')
          const served = (forms?.describe?.().getSnapshot()?.view?.namespaces ?? [])
            .map((view) => view.ns)
            .filter((name) => typeof name === 'string')
          return served.find((name) => name.includes(NAMESPACE_HINT))
            ?? ENTRY_IDS.find((id) => served.includes(id))
            ?? ENTRY_ID
        } catch { return ENTRY_ID }
      }
      const readDefaultDir = () => {
        try {
          const forms = configForms ?? ctx.get('configForms')
          const form = forms ? forms.get(resolveNamespace()) : undefined
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
        // Tracked BEFORE the create call, and keyed on the id this half minted:
        // the Host mounts the session *during* that call, so a sweep triggered by
        // the resulting workspace change must already recognize the mount as ours.
        tracked.set(sessionId, Date.now())
        adopting.set(sessionId, Date.now() + ADOPTION_WINDOW_MS)
        const created = await ctx.sessions.create({ cwd, sessionId })
        await waitForWorkspaceMount(created, cwd)
        ctx.uiWorkspace.openSession(created)
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

      /**
       * Chip action: reuse the current blank scratch session, else create one —
       * `createUngrouped` opens it once the Host has mounted it.
       */
      const start = async () => {
        const list = ctx.sessions.list.getSnapshot()
        const current = mainSessionId(list)
        if (typeof current === 'string' && current.startsWith(SESSION_PREFIX) && list.byId[current]?.blank === true) {
          ctx.uiWorkspace.openSession(current)
          return
        }
        await createUngrouped()
      }

      /**
       * Retire a mount that no longer needs to exist: its blank session was
       * abandoned without a first message (the sidebar hides blank rows, so the
       * group would otherwise linger as an empty workspace), or the Host half's
       * first-message retirement did not run.
       *
       * Adoption is what makes this prompt without racing the Host: a mount is
       * held while its session is the current one and, before that, for the
       * moment between `sessions.create` and `openSession`. The instant the
       * session becomes current it leaves both windows, so moving elsewhere
       * retires the group on the spot. A mount that never becomes current is
       * held for `MOUNT_MIN_AGE_MS` in case adoption is merely slow.
       */
      /**
       * Scratch sessions this page created, keyed by the id it minted. A mount is
       * only ever retired when it belongs to one of these: anything else (a mount
       * from another page load, a previous process, or a build that registered
       * after the Host had already mounted) is left for the Host's startup sweep
       * rather than deleted on a guess.
       */
      const tracked = new Map()
      /**
       * Tracked sessions `openSession` has not adopted yet: the only window where
       * a mount must survive while it is neither current nor watched. Cleared the
       * moment the session turns current, with a time fallback.
       */
      const adopting = new Map()
      /** Scratch sessions that have been the current Session at least once. */
      const adopted = new Set()
      /** Milliseconds since one Session row's last durable activity. */
      const ageOf = (summary) => (typeof summary?.updatedAt === 'number' ? Date.now() - summary.updatedAt : 0)
      const sweep = () => {
        const sessions = ctx.sessions.list.getSnapshot()
        const current = mainSessionId(sessions)
        // Before a current Session exists the app is still restoring, and a
        // mount deleted here could be the blank Session that restore needs.
        if (current === undefined) return
        const currentRow = sessions.byId[current]
        if (typeof current === 'string' && current.startsWith(SESSION_PREFIX) && currentRow?.blank === true) {
          // Adoption complete: from here the session is an ordinary page, and
          // leaving it must retire the mount on the spot.
          adopted.add(current)
          adopting.delete(current)
        }
        const now = Date.now()
        for (const [id, deadline] of adopting) if (deadline <= now) adopting.delete(id)
        for (const workspace of ctx.workspaces.list.getSnapshot().items) {
          if (typeof workspace.title !== 'string' || !workspace.title.startsWith(MOUNT_TITLE_PREFIX)) continue
          const owned = workspace.sessionIds.find((id) => tracked.has(id))
          if (owned === undefined) continue
          // Still inside the creation → openSession window.
          if (adopting.has(owned)) continue
          // The page the operator is looking at right now.
          if (workspace.sessionIds.includes(current)) continue
          // Never adopted and its session is still young: hold it, in case
          // adoption is slow or the page was reloaded mid-adoption.
          if (!adopted.has(owned) && ageOf(sessions.byId[owned]) < MOUNT_MIN_AGE_MS) continue
          void ctx.workspaces.delete(workspace.workspaceId).catch(() => { /* retried on the next pass */ })
        }
      }

      ctx.effect(() => {
        const stop = ctx.sessions.list.subscribe(sweep)
        const stopWorkspaces = ctx.workspaces.list.subscribe(sweep)
        // The subscriptions fire on every session/workspace change, which is what
        // makes moving away retire the group on the spot; the timer only exists so
        // a missed change still converges within a few seconds, and so a mount held
        // by the age guard above is retired once it grows old enough.
        const timer = setInterval(sweep, MOUNT_SWEEP_INTERVAL_MS)
        sweep()
        return () => { stop(); stopWorkspaces(); clearInterval(timer) }
      }, 'noworkspace-session: abandoned-mount sweep')

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

      // 2) settings row — only while the Host actually serves our namespace.
      //    The namespace is the loader *entry* id, which carries the `include:`
      //    qualifier (`include:noworkspace-session`), so it is read from the
      //    describe mirror instead of hardcoded: a wrong id reports `unavailable`
      //    forever and leaves the row permanently unwritable.
      ctx.inject(['configForms'], (child) => {
        const forms = child.configForms
        configForms = forms
        child.effect(() => forms.whileServed(ENTRY_IDS, (served) => {
          const namespace = [...served].find((name) => name.includes(NAMESPACE_HINT)) ?? resolveNamespace()
          const form = forms.get(namespace)
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
          return child.slots.inject('settings.general.item', () => child.slots.register({
            name: 'settings.general.item',
            id: 'noworkspace-default-dir',
            order: 50,
            locale: NS,
            inject: () => ({ hooks: { dirForm: form }, change, reset, homeOf: hostHome }),
          }, DefaultDirRow))
        }), 'noworkspace-session: settings row')
      })

      // 3) right sidebar guide card — the tab *type* carries the capsule the
      //    guide page renders, and the seat's own card spends the click on
      //    `start()`. The type is registered without a pane body on purpose: a
      //    session belongs to the conversation surface, which the right column
      //    has no seat for, so opening a pane of this kind is not a path.
      ctx.inject(['sidebarRightTabs'], (child) => {
        child.effect(() => child.sidebarRightTabs.register({
          id: SIDEBAR_TYPE_ID,
          kind: 'noworkspace',
          multiple: false,
          title: () => t('card.title'),
          guide: [{
            id: 'new',
            order: 30,
            title: () => t('card.title'),
            description: () => t('card.description'),
            icon: GuideIcon,
          }],
        }), 'noworkspace-session: sidebar tab type')
        child.effect(() => child.slots.inject('sidebar.right.tab.guide.entry', () => child.slots.register({
          name: 'sidebar.right.tab.guide.entry', key: SIDEBAR_TYPE_ID, locale: NS,
          inject: () => ({ start }),
        }, GuideCard)), 'noworkspace-session: sidebar guide card')
      })
    }

    return {
      inject: ['slots', 'locale', 'remote', 'sessions', 'uiWorkspace', 'workspaces'],
      apply,
    }
  },
})
