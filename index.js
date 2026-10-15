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
 * The registry is resolved from the root context at call time. It is deliberately
 * NOT taken from `ctx.inject(['workspaceRegistry'], …)`: on the desktop build the
 * injected instance accepted the call but never settled `resolveByPath`, so every
 * mount stayed pending and the composer stayed inert.
 */
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
/** Temporary-workspace title prefix; the browser half identifies its mounts by it when sweeping. */
const MOUNT_TITLE_PREFIX = '无项目任务 · '

/** Local wall clock as `HH-MM-SS`, matching the task folder next to it. */
function stamp() {
  const now = new Date()
  const pad = (value) => String(value).padStart(2, '0')
  return `${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`
}

/** Operator-facing diagnostic; the logger is optional in reduced compositions. */
function warn(ctx, message) {
  try { ctx.logger?.warn?.('noworkspace-session: %s', message) } catch { /* logging is best-effort */ }
}

/**
 * The bundle ships its own General-settings row, so suppress the
 * auto-generated settings page for this entry.
 * @param ctx Plugin context; `settings` is optional and skipped when absent.
 */
export function apply(ctx) {
  ctx.inject(['settings'], (child) => {
    child.effect(
      () => child.settings.configure({ auto: false }, ctx.fiber),
      'noworkspace-session: settings presentation',
    )
  })

  /** The live workspace registry, resolved lazily from the root context. */
  const registryOf = () => {
    try {
      return ctx.root?.get?.('workspaceRegistry') ?? ctx.get('workspaceRegistry')
    } catch (error) {
      warn(ctx, `could not resolve the workspace registry: ${String(error)}`)
      return undefined
    }
  }
  const report = (message) => { warn(ctx, message) }

  /** Sessions already handled, so a retirement is never undone by a later announcement. */
  const handled = new Set()
  const consider = (sessionId, cwd) => {
    if (handled.has(sessionId)) return
    handled.add(sessionId)
    void mount(registryOf(), sessionId, cwd, report)
  }

  // A session of ours was announced: mount it while it is still blank, which is
  // both the freshly created case and a blank scratch session restored at
  // startup. A session that already carries history needs no mount.
  ctx.on('api-session/added', (summary) => {
    if (summary === undefined || typeof summary.sessionId !== 'string') return
    if (!summary.sessionId.startsWith(SESSION_PREFIX)) return
    if (summary.blank !== true) return
    consider(summary.sessionId, summary.cwd)
  })

  // The first user-authored durable message: the mount has done its job and
  // Ungrouped is the session's real home.
  ctx.on('api-session/activity', (sessionId) => {
    if (typeof sessionId !== 'string') return
    void unmount(registryOf(), sessionId, report)
  })

  // A previous process can leave mounts behind (crash, upgrade, or an earlier
  // build): retire every workspace whose members are all sessions of ours. Keyed
  // on membership rather than on the title, so mounts from older prefixes are
  // collected too. The operator's own workspaces never hold this plugin's ids.
  // The registry may not be composed yet while this plugin applies, so retry.
  void (async () => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const registry = registryOf()
      if (registry !== undefined) {
        await retireLeftovers(registry, report)
        return
      }
      await new Promise((resolve) => { setTimeout(resolve, 500) })
    }
  })()
}

/**
 * Register the session's own cwd as a workspace and attach it; a session the
 * operator already placed in some workspace is left alone.
 * @param registry Host workspace registry, when the profile composes one.
 * @param sessionId Session to mount.
 * @param cwd The session's project directory (the task folder).
 * @param report Operator-facing diagnostic sink.
 */
async function mount(registry, sessionId, cwd, report) {
  if (registry === undefined) {
    report(`session ${sessionId} could not be mounted: the profile composes no workspace registry`)
    return
  }
  try {
    if (registry.list().some(workspace => workspace.sessionIds.includes(sessionId))) return
    if (typeof cwd !== 'string' || cwd === '') {
      report(`session ${sessionId} carries no cwd to mount`)
      return
    }
    const existing = await registry.resolveByPath(cwd)
    const workspace = existing ?? await registry.create(cwd, `${MOUNT_TITLE_PREFIX}${stamp()}`)
    await workspace.attachSession(sessionId)
  } catch (error) {
    // Everything still works without the mount: the hero keeps its native
    // "choose a workspace" state, so this is a warning rather than a failure.
    report(`could not mount session ${sessionId} at ${String(cwd)}: ${String(error)}`)
  }
}

/**
 * Drop the temporary workspace that mount() created for this session.
 * @param registry Host workspace registry, when the profile composes one.
 * @param sessionId Session whose mount to retire.
 * @param report Operator-facing diagnostic sink.
 */
async function unmount(registry, sessionId, report) {
  if (registry === undefined) return
  try {
    const owned = registry.list().find(workspace =>
      typeof workspace.title === 'string' && workspace.title.startsWith(MOUNT_TITLE_PREFIX)
      && workspace.sessionIds.includes(sessionId))
    if (owned === undefined) return
    await registry.delete(owned.id)
  } catch (error) {
    report(`could not retire the mount for session ${sessionId}: ${String(error)}`)
  }
}

/**
 * Retire every workspace left behind by an earlier process.
 * @param registry Host workspace registry, when the profile composes one.
 * @param report Operator-facing diagnostic sink.
 */
async function retireLeftovers(registry, report) {
  for (const workspace of registry.list()) {
    const members = [...workspace.sessionIds]
    if (members.length === 0) continue
    if (!members.every((id) => id.startsWith(SESSION_PREFIX))) continue
    try {
      await registry.delete(workspace.id)
    } catch (error) {
      report(`could not retire leftover workspace "${String(workspace.title)}": ${String(error)}`)
    }
  }
}
