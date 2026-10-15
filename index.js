/**
 * Host half of dsh-plugin-noworkspace-session.
 *
 * The browser half creates sessions with a bare cwd (no workspace), which makes
 * them belong to Ungrouped. The shipped conversation hero renders its composer
 * inert for exactly that state (`inert = hero && chipTitle === undefined` in
 * ui-conversation's ConversationContent), because the workspace relation is what
 * unlocks input. A session that is not blank is a first-class page, so the only
 * window that needs help is the blank one — and the Host is the only half that
 * can close it: `Workspace.attachSession` has no Client caller, and the desktop
 * directory picker (native backend) cannot create the task folder.
 *
 * So this half mounts each blank session of ours in a temporary workspace whose
 * path is the session's own cwd — the exact path `session.create` just created —
 * and retires that workspace as soon as the first user message lands. The
 * session then falls back to Ungrouped, which is where it was meant to live.
 *
 * Two triggers drive the mount: the documented `api-session/added` event, and —
 * because the event path's delivery to a plugin listener has been unreliable in
 * practice on the desktop build — a scan of the live Session store. Both resolve
 * the workspace registry through `inject` first, with a dynamic lookup only as a
 * fallback, and both write to a diagnostic log while this behaviour is being
 * verified.
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import z from '@deepseek-ai/schemastery'

/** Default task folder before an operator overrides it in Settings. `~` is expanded in the browser. */
export const DEFAULT_DIR = '~/Documents/dsh'

/**
 * Plugin configuration. `defaultDir` accepts an absolute host path or a
 * `~`-rooted home path; the Client expands `~` against `ctx.remote.$host.home`
 * and Host `session.create` recursively creates whatever path it receives.
 */
export const Config = z.object({
  defaultDir: z.string().default(DEFAULT_DIR),
})

/** Session-id prefix the browser half mints; the Host half recognizes its own sessions by it. */
const SESSION_PREFIX = 'session-nws-'
/** Temporary-workspace title prefix, used to recognize this plugin's own mounts. */
const MOUNT_TITLE_PREFIX = '无项目任务 · '
/** Only freshly created sessions are mounted, so restoring history never picks up a stale session. */
const FRESH_MS = 300000
/** Diagnostic sink; remove with the diagnostic calls once the trigger path is settled. */
const DEBUG_LOG = `${process.env.TEMP ?? 'C:\\Windows\\Temp'}\\nws-probe\\host.log`

/** Append one diagnostic line; diagnostics never affect behaviour. */
function dbg(entry) {
  try {
    mkdirSync(DEBUG_LOG.replace(/[\\/][^\\/]+$/, ''), { recursive: true })
    appendFileSync(DEBUG_LOG, `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...entry })}\n`, 'utf8')
  } catch { /* diagnostics are best-effort */ }
}

/** Local wall clock as `HH-MM-SS`, matching the task folder next to it. */
function stamp() {
  const now = new Date()
  const pad = (value) => String(value).padStart(2, '0')
  return `${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`
}

/**
 * The bundle ships its own General-settings row, so suppress the
 * auto-generated settings page for this entry.
 * @param ctx Plugin context; `settings` is optional and skipped when absent.
 */
export function apply(ctx) {
  dbg({
    stage: 'apply',
    hasRoot: typeof ctx.root, hasGet: typeof ctx.get, hasOn: typeof ctx.on,
    hasLogger: typeof ctx.logger, hasInject: typeof ctx.inject, hasEffect: typeof ctx.effect,
  })

  ctx.inject(['settings'], (child) => {
    child.effect(
      () => child.settings.configure({ auto: false }, ctx.fiber),
      'noworkspace-session: settings presentation',
    )
  })

  /**
   * The registry resolved from the root context, lazily at call time.
   *
   * Deliberately NOT taken from `ctx.inject(['workspaceRegistry'], …)`: on the
   * desktop build the injected instance accepts the call but never settles
   * `resolveByPath`, which left every mount pending and the composer inert. The
   * root lookup returns the live service and has been reliable (verified against
   * a hot-reloaded instance of this same module).
   */
  const registryOf = () => {
    try {
      const registry = ctx.root?.get?.('workspaceRegistry') ?? ctx.get('workspaceRegistry')
      if (registry === undefined) dbg({ stage: 'registry-missing' })
      return registry
    } catch (error) {
      dbg({ stage: 'registry-throw', message: String(error?.message ?? error) })
      return undefined
    }
  }
  dbg({ stage: 'registry-now', type: typeof registryOf() })

  /** Sessions already handled, so neither trigger mounts one twice. */
  const handled = new Set()
  const consider = (sessionId, cwd, via) => {
    if (handled.has(sessionId)) return
    handled.add(sessionId)
    dbg({ stage: 'consider', sessionId, cwd, via })
    void mount(registryOf(), sessionId, cwd, via)
  }

  // A session of ours was created: `summary.cwd` is the directory it just made.
  ctx.on('api-session/added', (summary) => {
    dbg({
      stage: 'event-added',
      id: summary?.sessionId, blank: summary?.blank, cwd: summary?.cwd,
      updatedAt: summary?.updatedAt, keys: summary === undefined ? null : Object.keys(summary),
    })
    if (summary === undefined || typeof summary.sessionId !== 'string') return
    if (!summary.sessionId.startsWith(SESSION_PREFIX)) return
    if (summary.blank !== true) return
    const age = typeof summary.updatedAt === 'number' ? Date.now() - summary.updatedAt : 0
    if (age > FRESH_MS) return
    consider(summary.sessionId, summary.cwd, 'event')
  })

  // The first user-authored durable message: the mount has done its job.
  ctx.on('api-session/activity', (sessionId) => {
    dbg({ stage: 'event-activity', sessionId })
    if (typeof sessionId !== 'string') return
    void unmount(registryOf(), sessionId)
  })

  // Fallback trigger: the live Session store, independent of event delivery.
  const scan = () => {
    try {
      const store = ctx.root?.get?.('sessions') ?? ctx.get('sessions')
      const list = store !== undefined && typeof store.list === 'function' ? store.list() : undefined
      if (!Array.isArray(list)) return
      for (const session of list) {
        const header = session?.header ?? {}
        const id = session?.id ?? header.id
        if (typeof id !== 'string' || !id.startsWith(SESSION_PREFIX)) continue
        if (handled.has(id)) continue
        const age = typeof header.createdAt === 'number' ? Date.now() - header.createdAt : 0
        if (age > FRESH_MS) { handled.add(id); continue }
        consider(id, header.cwd, 'scan')
      }
    } catch (error) {
      dbg({ stage: 'scan-throw', message: String(error?.message ?? error) })
    }
  }
  const handle = setInterval(scan, 2000)
  try {
    ctx.effect(() => () => { clearInterval(handle) }, 'noworkspace-session: mount fallback scan')
  } catch (error) {
    dbg({ stage: 'effect-throw', message: String(error?.message ?? error) })
  }
  scan()
  dbg({ stage: 'ready' })
}

/**
 * Register the session's own cwd as a workspace and attach it; a session the
 * operator already placed in some workspace is left alone.
 * @param registry Host workspace registry, when the profile composes one.
 * @param sessionId Session to mount.
 * @param cwd The session's project directory (the task folder).
 * @param via Which trigger asked for the mount.
 */
async function mount(registry, sessionId, cwd, via) {
  if (registry === undefined) { dbg({ stage: 'mount-no-registry', sessionId }); return }
  try {
    if (registry.list().some(workspace => workspace.sessionIds.includes(sessionId))) {
      dbg({ stage: 'mount-skip', reason: 'already accounted', sessionId })
      return
    }
    if (typeof cwd !== 'string' || cwd === '') {
      dbg({ stage: 'mount-skip', reason: 'no cwd', sessionId })
      return
    }
    const existing = await registry.resolveByPath(cwd)
    const workspace = existing ?? await registry.create(cwd, `${MOUNT_TITLE_PREFIX}${stamp()}`)
    await workspace.attachSession(sessionId)
    dbg({
      stage: 'mount', ok: true, via, sessionId, cwd,
      reused: existing !== undefined, workspaceId: workspace.id, title: workspace.title,
      sessionIds: [...workspace.sessionIds],
    })
  } catch (error) {
    dbg({ stage: 'mount', ok: false, via, sessionId, cwd, message: String(error?.message ?? error), stack: String(error?.stack ?? '').slice(0, 900) })
  }
}

/**
 * Drop the temporary workspace that mount() created for this session.
 * @param registry Host workspace registry, when the profile composes one.
 * @param sessionId Session whose mount to retire.
 */
async function unmount(registry, sessionId) {
  if (registry === undefined) return
  try {
    const owned = registry.list().find(workspace =>
      typeof workspace.title === 'string' && workspace.title.startsWith(MOUNT_TITLE_PREFIX)
      && workspace.sessionIds.includes(sessionId))
    if (owned === undefined) { dbg({ stage: 'unmount-skip', sessionId }); return }
    await registry.delete(owned.id)
    dbg({ stage: 'unmount', ok: true, sessionId, workspaceId: owned.id, title: owned.title })
  } catch (error) {
    dbg({ stage: 'unmount', ok: false, sessionId, message: String(error?.message ?? error) })
  }
}
