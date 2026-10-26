/**
 * dsh-plugin-noworkspace-session — browser half.
 *
 * Three additive registrations, no shipped UI replaced: the hero row's options
 * chip (`conversation.hero.options`), the no-project folder row
 * (`settings.general.item`), and the right sidebar guide's tab type plus the
 * card and pane body it opens.
 *
 * Cross-half contract: this half builds the task folder, creates the session
 * with `sessions.create({ cwd })` (the Host mints the id), waits for the Host's
 * mount in the workspace store, then opens it. The Host owns mounting and
 * retirement; this half only abandons mounts it created or re-adopted on this
 * page, recognized by workspace membership alone (never title or path).
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-noworkspace-session',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState } = React

    // ---- CONTRACT -----------------------------------------------------

    /** Locale namespace owned by this plugin. */
    const NS = 'noworkspace'
    /** `id` of this plugin's row in cordis.patch.yml; the loader may qualify it. */
    const ENTRY_ID = 'noworkspace-session'
    /**
     * Settings namespaces this plugin's row may be served under: a bundled entry
     * is keyed by the loader entry id, which carries an `include:` qualifier, so
     * the served spelling is read from the settings mirror instead of assumed.
     */
    const ENTRY_IDS = [ENTRY_ID, `include:${ENTRY_ID}`, 'dsh-plugin-noworkspace-session']
    /** Distinctive fragment that identifies this plugin's namespace in the mirror. */
    const NAMESPACE_HINT = 'noworkspace'
    /** Tab-type identity in the right sidebar registry; also every guide seat's key. */
    const SIDEBAR_TYPE_ID = 'dsh-plugin-noworkspace-session'
    /** Tab kind: what an opened tab of this type is, and the guide card's DOM marker. */
    const SIDEBAR_KIND = 'noworkspace'
    /** Task folder used when the setting is unset or the Host home is unknown. */
    const DEFAULT_DIR = '~/Documents/dsh'
    /** A mount younger than this may still be in the create → openSession window. */
    const ADOPTION_WINDOW_MS = 15000
    /** A mount never seen as the current session is held this long before it counts as abandoned. */
    const MOUNT_MIN_AGE_MS = 60000
    /** Safety-net re-check; subscriptions already retire a mount the moment the operator moves away. */
    const MOUNT_SWEEP_INTERVAL_MS = 2000
    /** How long `openSession` waits for the Host's mount before opening anyway. */
    const MOUNT_WAIT_TIMEOUT_MS = 2000
    /** Shape of one session folder under the task root: `<date>/<time>`. */
    const TASK_DIR_PATTERN = /^\d{4}-\d{2}-\d{2}\/\d{2}-\d{2}-\d{2}$/

    // ---- LOCALE -------------------------------------------------------

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

    // ---- CSS ----------------------------------------------------------
    // Token-only. The chip mirrors the shipped workspace chip's geometry so the
    // two read as one line; the guide capsule copies the shipped card's own
    // sheet because a custom card replaces the shipped one wholesale.

    const CSS = `
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
.nws-btn{padding:5px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:13px;line-height:18px;cursor:pointer;white-space:nowrap}
.nws-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.nws-btn:disabled{opacity:.45;cursor:default}
.nws-btnQuiet{border-color:transparent;color:var(--dsw-alias-label-secondary)}
.nws-btnQuiet:hover:not(:disabled){color:var(--dsw-alias-label-primary)}
.nws-card{display:flex;gap:14px;align-items:center;box-sizing:border-box;width:100%;min-height:56px;padding:14px 20px;color:var(--dsw-alias-label-primary);font:inherit;text-align:left;background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-xl);cursor:pointer}
.nws-card:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.nws-card:disabled{cursor:default;opacity:.65}
.nws-card:focus-visible{outline:1px solid var(--dsw-alias-brand-primary);outline-offset:-1px}
.nws-cardIcon{display:flex;flex:none;align-items:center;justify-content:center;width:26px;height:26px;color:var(--dsw-alias-label-secondary)}
.nws-cardText{display:flex;flex:1;flex-direction:column;gap:3px;min-width:0}
.nws-cardTitle{overflow:hidden;font-size:14px;line-height:1.4;white-space:nowrap;text-overflow:ellipsis}
.nws-cardDesc{overflow:hidden;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1.4;white-space:nowrap;text-overflow:ellipsis}
.nws-cardError{overflow:hidden;color:var(--dsw-alias-state-error-primary);font-size:11px;line-height:1.4;white-space:nowrap;text-overflow:ellipsis}
.nws-pane{box-sizing:border-box;display:flex;flex:1;flex-direction:column;gap:12px;min-height:0;padding:20px 16px;overflow:auto;color:var(--dsw-alias-label-primary);font:inherit}
.nws-paneTitle{font-size:14px;font-weight:500;line-height:20px}
.nws-paneDesc{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.nws-paneError{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}
.nws-paneAction{align-self:flex-start}
`

    // ---- PURE ---------------------------------------------------------

    /** Fold any thrown value into one operator-facing message (keeps Host codes). */
    function msg(e) {
      if (e && typeof e === 'object') {
        const rpc = e.rpcError
        if (rpc && typeof rpc === 'object') {
          const code = typeof rpc.code === 'string' ? rpc.code : ''
          const text = typeof rpc.message === 'string' ? rpc.message : ''
          if (text !== '') return code === '' ? text : code + ': ' + text
        }
        if (typeof e.message === 'string' && e.message !== '') return e.message
      }
      return String(e)
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

    /** The session the main panel currently shows (`retainedBy.mainView`, the sidebar's own read). */
    function mainSessionId(list) {
      for (const id of list.ids) {
        const summary = list.byId[id]
        if (summary !== undefined && (summary.retainedBy?.mainView ?? 0) > 0) return id
      }
      return undefined
    }

    /** Zero-pad one date/time component. */
    const pad2 = (n) => String(n).padStart(2, '0')

    /** `<root>/<date>/<time>`: the per-session task folder for right now. */
    function taskCwdFor(root) {
      const sep = root.includes('\\') ? '\\' : '/'
      const now = new Date()
      const date = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`
      const time = `${pad2(now.getHours())}-${pad2(now.getMinutes())}-${pad2(now.getSeconds())}`
      return `${root}${sep}${date}${sep}${time}`
    }

    /** Path form a lexical comparison can use: slashes, no trailing slash, case folded where the Host does. */
    const normalizePath = (path, foldCase = true) => {
      const slashed = path.replace(/\\/g, '/').replace(/\/+$/, '')
      return foldCase ? slashed.toLowerCase() : slashed
    }

    /** Whether one cwd is exactly a task folder under `root`. */
    function isTaskCwd(cwd, root, foldCase = true) {
      if (typeof cwd !== 'string' || cwd === '' || root === undefined) return false
      const base = normalizePath(root, foldCase)
      const target = normalizePath(cwd, foldCase)
      if (base === '' || !target.startsWith(base + '/')) return false
      return TASK_DIR_PATTERN.test(target.slice(base.length + 1))
    }

    /** The served settings namespace belonging to this plugin, preferring its own hint. */
    function pickServed(served) {
      for (const name of served) if (name.includes(NAMESPACE_HINT)) return name
      for (const id of ENTRY_IDS) if (served.has(id)) return id
      return undefined
    }

    // ---- SESSION ------------------------------------------------------
    /**
     * Create the ungrouped session, wait for the Host's mount, open it.
     * @param deps Context, translator, and the task-folder setting reader.
     * @returns the chip action, the page-local mount ledger, the home reader, and current-session adoption.
     */
    function createSessionFlow({ ctx, t, readDefaultDir }) {
      /** Mounts this page created or re-adopted: sessionId -> { at, adopted, workspaceId? }. */
      const tracked = new Map()

      /** Host home; only a resolved value is cached, so an early undefined call retries. */
      let home
      const hostHome = () => {
        if (home !== undefined) return home
        try { home = ctx.remote && ctx.remote.$host ? ctx.remote.$host.home : undefined } catch { home = undefined }
        return home
      }

      /** Case folding follows the Host platform: Windows paths are case-insensitive. */
      const foldCase = () => (hostHome() === undefined ? true : hostHome().includes('\\'))

      /**
       * The task-folder root this half and the Host share: the configured
       * setting with `~` expanded.
       * @returns the absolute root, or undefined when it cannot be resolved.
       */
      const taskRoot = () => {
        const raw = readDefaultDir()
        const expanded = expandHome(raw, hostHome())
        // expandHome leaves an unfoldable `~` path untouched.
        if (expanded === raw && (raw === '~' || raw.startsWith('~/') || raw.startsWith('~\\'))) return undefined
        const root = expanded.replace(/[\\/]+$/, '')
        return root === '' ? undefined : root
      }

      /** The workspace currently holding this session, if any. */
      const workspaceHolding = (sessionId) => ctx.workspaces.list.getSnapshot().items
        .find((item) => item.sessionIds.includes(sessionId))

      /** Whether some workspace currently holds this session. */
      const isMounted = (sessionId) => workspaceHolding(sessionId) !== undefined

      /** Whether a task folder is already used by another session or mount. */
      const cwdInUse = (cwd) => {
        const key = normalizePath(cwd, foldCase())
        const list = ctx.sessions.list.getSnapshot()
        for (const id of list.ids) {
          const row = list.byId[id]
          if (typeof row?.cwd === 'string' && row.cwd !== '' && normalizePath(row.cwd, foldCase()) === key) return true
        }
        return ctx.workspaces.list.getSnapshot().items.some((item) => normalizePath(item.path, foldCase()) === key)
      }

      /** Resolve on the next local wall-clock second, so two clicks never share one folder. */
      const nextSecond = () => new Promise((resolve) => {
        setTimeout(resolve, 1000 - (Date.now() % 1000))
      })

      /**
       * Resolve once the Host's mount holds this session, or after a short wait.
       * A timed-out wait still opens, so a missing mount degrades to the shipped
       * "choose a workspace" state instead of a silent no-op.
       * @param sessionId Session whose mount the Host announces.
       */
      const waitForWorkspaceMount = (sessionId) => new Promise((resolve) => {
        let done = false
        let stop
        let timer
        const finish = () => {
          if (done) return
          done = true
          if (stop !== undefined) stop()
          if (timer !== undefined) clearTimeout(timer)
          resolve()
        }
        timer = setTimeout(finish, MOUNT_WAIT_TIMEOUT_MS)
        if (isMounted(sessionId)) {
          finish()
          return
        }
        stop = ctx.workspaces.list.subscribe(() => { if (isMounted(sessionId)) finish() })
        // A store may publish synchronously on subscribe; the flag keeps that path safe.
        if (done) stop()
      })

      /**
       * Open a tracked session and latch its adoption, so leaving it retires the
       * mount on the spot instead of waiting out the creation window.
       * @param sessionId Session to open.
       * @param workspaceId Mount recorded for it, when known.
       */
      const openTracked = (sessionId, workspaceId) => {
        const state = tracked.get(sessionId) ?? { at: Date.now(), adopted: false }
        state.adopted = true
        if (workspaceId !== undefined) state.workspaceId = workspaceId
        tracked.set(sessionId, state)
        ctx.uiWorkspace.openSession(sessionId)
      }

      /** Create a session in a fresh task folder, track its mount, then open it. */
      const createUngrouped = async () => {
        const root = taskRoot()
        if (root === undefined) throw new Error(t('chip.noHome'))
        let cwd = taskCwdFor(root)
        // Two clicks inside one second would share one folder and, through it, one
        // temporary mount; wait for the next second rather than collide.
        for (let attempt = 0; attempt < 3 && cwdInUse(cwd); attempt += 1) {
          await nextSecond()
          cwd = taskCwdFor(root)
        }
        const sessionId = await ctx.sessions.create({ cwd })
        // Tracked before the mount is awaited: the Host publishes the mount
        // during the create call, and the sweep must already own the row.
        tracked.set(sessionId, { at: Date.now(), adopted: false })
        await waitForWorkspaceMount(sessionId)
        openTracked(sessionId, workspaceHolding(sessionId)?.workspaceId)
        return sessionId
      }

      /**
       * Adopt the current session without a click. After a hard refresh the page's
       * ledger is empty while the Host still holds the mount, so leaving it must
       * retire that mount like any other abandoned scratch session.
       * @param list Session list snapshot.
       * @param current Current session id.
       */
      const adoptCurrent = (list, current) => {
        if (current === undefined || tracked.has(current)) return
        const summary = list.byId[current]
        if (summary?.blank !== true || !isTaskCwd(summary.cwd, taskRoot(), foldCase())) return
        const workspace = workspaceHolding(current)
        if (workspace === undefined) return
        tracked.set(current, { at: Date.now(), adopted: true, workspaceId: workspace.workspaceId })
      }

      /**
       * Chip action: reuse the current scratch session, else create one. Reuse
       * covers a session created earlier on this page and — after a hard refresh,
       * when the ledger is empty — a task-folder blank session the Host already
       * mounted; the chip therefore never opens an inert session with no mount.
       */
      const start = async () => {
        const list = ctx.sessions.list.getSnapshot()
        const current = mainSessionId(list)
        const summary = current === undefined ? undefined : list.byId[current]
        if (current !== undefined && summary?.blank === true) {
          if (tracked.has(current)) {
            openTracked(current)
            return current
          }
          const workspace = workspaceHolding(current)
          if (isTaskCwd(summary.cwd, taskRoot(), foldCase()) && workspace !== undefined) {
            tracked.set(current, { at: Date.now(), adopted: true, workspaceId: workspace.workspaceId })
            ctx.uiWorkspace.openSession(current)
            return current
          }
        }
        return await createUngrouped()
      }

      return { tracked, start, hostHome, adoptCurrent }
    }

    // ---- MOUNT-RETIRE -------------------------------------------------
    /**
     * Abandon the mounts this page opened and never used. Ordinary retirement
     * belongs to the Host (first user message) and empty folders are reclaimed
     * by its startup pass.
     * @param deps Context, the page-local mount ledger, and current-session adoption.
     * @returns the reconciler driven by the session and workspace stores.
     */
    function createMountRetire({ ctx, tracked, adoptCurrent }) {
      /**
       * Forget one ledger row and, only with the recorded workspace id, the mount
       * that still holds it — never a workspace found by membership alone, which
       * could be the operator's own.
       */
      const retire = (sessionId) => {
        const state = tracked.get(sessionId)
        tracked.delete(sessionId)
        if (state?.workspaceId === undefined) return
        const workspace = ctx.workspaces.list.getSnapshot().items
          .find((item) => item.workspaceId === state.workspaceId)
        if (workspace === undefined || !workspace.sessionIds.includes(sessionId)) return
        void ctx.workspaces.delete(workspace.workspaceId).catch(() => { /* already removed by the Host or another page */ })
      }

      /**
       * The current session marks its row adopted; a non-current row is retired
       * once it left the creation window and either turned non-blank (the Host's
       * retirement did not run) or was adopted, or grew older than the minimum.
       * An adopted row retires as soon as the operator moves away.
       */
      const sweep = () => {
        const sessions = ctx.sessions.list.getSnapshot()
        const current = mainSessionId(sessions)
        adoptCurrent(sessions, current)
        if (tracked.size === 0) return
        const now = Date.now()
        for (const [sessionId, state] of [...tracked]) {
          if (sessionId === current) {
            state.adopted = true
            continue
          }
          const age = now - state.at
          if (!state.adopted && age < ADOPTION_WINDOW_MS) continue
          const blank = sessions.byId[sessionId]?.blank === true
          if (!state.adopted && blank && age < MOUNT_MIN_AGE_MS) continue
          retire(sessionId)
        }
      }

      return { sweep }
    }

    // ---- UI -----------------------------------------------------------

    /** Folder-with-a-slash glyph on a 16-unit grid, stroke-compensated for the rendered size. */
    const icoNoWorkspace = (size = 16, stroke) => h('svg', {
      viewBox: '0 0 16 16', width: size, height: size, fill: 'none', stroke: 'currentColor',
      strokeWidth: stroke ?? (1.3 * 16) / size, strokeLinecap: 'round', strokeLinejoin: 'round',
      'aria-hidden': true, focusable: false, className: 'nws-chipIcon',
    }, [
      h('path', { d: 'M1.5 4.4c0-.66.54-1.2 1.2-1.2h3l1.4 1.5h6.2c.66 0 1.2.54 1.2 1.2v6.5c0 .66-.54 1.2-1.2 1.2H2.7c-.66 0-1.2-.54-1.2-1.2V4.4Z' }),
      h('path', { d: 'M3 13 13 3' }),
    ])

    /** Busy and error state for one `start()` trigger. */
    function useStart(start) {
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      const run = async () => {
        if (busy) return
        setBusy(true)
        setError(null)
        try { await start() } catch (e) { setError(msg(e)) } finally { setBusy(false) }
      }
      return { busy, error, run }
    }

    /** The hero-row chip; it starts a session outside every workspace. */
    function UngroupedChip({ start, t }) {
      const { busy, error, run } = useStart(start)
      return h('button', {
        type: 'button', className: 'nws-chip', disabled: busy, title: t('chip.title'),
        onClick: () => { void run() },
      },
        icoNoWorkspace(),
        h('span', { className: 'nws-chipLabel' }, busy ? t('chip.busy') : t('chip.label')),
        error !== null && h('span', { className: 'nws-chipError', role: 'alert' }, t('chip.error', { message: error })))
    }

    /** Glyph for the guide capsules; the registry wants a component, not an element. */
    function GuideIcon() {
      return icoNoWorkspace(20)
    }

    /** The guide card: a capsule that spends its click on `start()` instead of opening the pane. */
    function GuideCard({ title, description, start, t }) {
      const { busy, error, run } = useStart(start)
      return h('button', {
        type: 'button', className: 'nws-card', disabled: busy,
        // The guide only prints a description while it lists few entries, so the
        // hover hint keeps the copy available in a crowded one.
        title: description === undefined ? title : `${title} — ${description}`,
        'data-sidebar-right-guide-entry': SIDEBAR_KIND,
        onClick: () => { void run() },
      },
        h('span', { className: 'nws-cardIcon', 'aria-hidden': 'true' }, icoNoWorkspace(20)),
        h('span', { className: 'nws-cardText' },
          h('span', { className: 'nws-cardTitle' }, busy ? t('chip.busy') : title),
          // No fallback copy: the guide passes a description only while it lists
          // few enough entries, and a card that always carried one would stand
          // out beside its neighbours the moment the guide drops theirs.
          error !== null
            ? h('span', { className: 'nws-cardError', role: 'alert' }, t('chip.error', { message: error }))
            : description !== undefined && h('span', { className: 'nws-cardDesc' }, description)))
    }

    /** The pane the guide type opens: the same action as the chip, with its own copy. */
    function GuidePane({ start, t }) {
      const { busy, error, run } = useStart(start)
      return h('div', { className: 'nws-pane' },
        h('div', { className: 'nws-paneTitle' }, t('card.title')),
        h('div', { className: 'nws-paneDesc' }, t('card.description')),
        error !== null && h('div', { className: 'nws-paneError', role: 'alert' }, t('chip.error', { message: error })),
        h('button', {
          type: 'button', className: 'nws-btn nws-paneAction', disabled: busy,
          onClick: () => { void run() },
        }, busy ? t('chip.busy') : t('chip.label')))
    }

    /**
     * One settings row: current folder plus Change/Reset over the config form
     * mirror. The buttons only stay disabled while a write is in flight, or when
     * the Host reports the namespace as not exposed at all — gating on
     * `status === 'ready'` would leave the row permanently inert whenever the
     * mirror still reports `loading`.
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

    // ---- ASSEMBLY -----------------------------------------------------

    /** @param ctx Client root context. */
    function apply(ctx) {
      const style = document.createElement('style')
      style.setAttribute('data-plugin', 'dsh-plugin-noworkspace-session')
      style.textContent = CSS
      document.head.appendChild(style)
      ctx.effect(() => () => { style.remove() }, 'noworkspace-session: styles')

      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'noworkspace-session: dictionaries')
      const t = ctx.locale.bind(NS)

      /**
       * The settings namespace the Host serves this plugin under. The served set
       * from `whileServed` is the fast path; otherwise the describe mirror is
       * probed, because a guessed spelling answers `unavailable` forever. One memo
       * serves both the settings row and the folder root sessions are created under.
       */
      let configForms
      let servedNamespace
      const formsOf = () => configForms ?? ctx.get('configForms')
      const probeNamespace = () => {
        try {
          const served = (formsOf()?.describe?.().getSnapshot()?.view?.namespaces ?? [])
            .map((view) => view.ns)
            .filter((name) => typeof name === 'string')
          return served.find((name) => name.includes(NAMESPACE_HINT))
            ?? ENTRY_IDS.find((id) => served.includes(id))
            ?? ENTRY_ID
        } catch {
          return ENTRY_ID
        }
      }
      const namespaceId = () => servedNamespace ?? probeNamespace()
      const formFor = () => {
        const forms = formsOf()
        return forms === undefined ? undefined : forms.get(namespaceId())
      }
      const readDefaultDir = () => {
        try {
          const value = formFor()?.getSnapshot()?.value?.defaultDir
          if (typeof value === 'string' && value.trim() !== '') return value.trim()
        } catch { /* form unavailable → schema default */ }
        return DEFAULT_DIR
      }

      const session = createSessionFlow({ ctx, t, readDefaultDir })
      const { sweep } = createMountRetire({ ctx, tracked: session.tracked, adoptCurrent: session.adoptCurrent })
      ctx.effect(() => {
        const stopSessions = ctx.sessions.list.subscribe(sweep)
        const stopWorkspaces = ctx.workspaces.list.subscribe(sweep)
        // Subscriptions retire a mount the moment the operator moves away; the
        // timer only makes a missed change and an age-guarded row converge.
        const timer = setInterval(sweep, MOUNT_SWEEP_INTERVAL_MS)
        return () => { stopSessions(); stopWorkspaces(); clearInterval(timer) }
      }, 'noworkspace-session: abandoned-mount sweep')

      // 1) the hero row's additive options seat, after the workspace and preset
      //    controls.
      ctx.effect(() => ctx.slots.inject('conversation.hero.options', () => ctx.slots.register({
        name: 'conversation.hero.options',
        id: 'noworkspace-ungrouped',
        order: 10,
        locale: NS,
        inject: () => ({ start: session.start }),
      }, UngroupedChip)), 'noworkspace-session: hero options chip')

      // 2) settings row — only while the Host actually serves our namespace.
      ctx.inject(['configForms'], (child) => {
        configForms = child.configForms
        child.effect(() => {
          const dispose = child.configForms.whileServed(ENTRY_IDS, (served) => {
            const namespace = pickServed(served) ?? probeNamespace()
            servedNamespace = namespace
            const form = child.configForms.get(namespace)
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
              inject: () => ({ hooks: { dirForm: form }, change, reset, homeOf: session.hostHome }),
            }, DefaultDirRow))
          })
          return () => {
            servedNamespace = undefined
            if (typeof dispose === 'function') dispose()
          }
        }, 'noworkspace-session: settings row')
      })

      // 3) the right sidebar guide: the tab type carries the capsule, the keyed
      //    card seat spends the click on `start()`, and the pane body makes the
      //    type openable (the guide's "more" list can reach it).
      ctx.inject(['sidebarRightTabs'], (child) => {
        child.effect(() => child.sidebarRightTabs.register({
          id: SIDEBAR_TYPE_ID,
          kind: SIDEBAR_KIND,
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
          name: 'sidebar.right.tab.guide.entry',
          key: SIDEBAR_TYPE_ID,
          locale: NS,
          inject: () => ({ start: session.start }),
        }, GuideCard)), 'noworkspace-session: sidebar guide card')
        child.effect(() => child.slots.inject('sidebar.right.pane.tab', () => child.slots.register({
          name: 'sidebar.right.pane.tab',
          key: SIDEBAR_TYPE_ID,
          locale: NS,
          inject: () => ({ start: session.start }),
        }, GuidePane)), 'noworkspace-session: sidebar guide pane')
      })
    }

    return {
      inject: ['slots', 'locale', 'remote', 'sessions', 'uiWorkspace', 'workspaces'],
      apply,
    }
  },
})
