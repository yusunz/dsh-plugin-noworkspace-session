/**
 * Host half of dsh-plugin-noworkspace-session.
 *
 * The browser half creates a session at `<task root>\<date>\<time>` with a bare
 * cwd, which leaves it ungrouped. The shipped conversation hero renders its
 * composer inert for exactly that state (`inert = hero && chipTitle ===
 * undefined`), and only a workspace relation unlocks input — but the Client has
 * no way to attach a session to a workspace. So this half is the one place that
 * can bridge the blank window: when a blank session of ours is announced, it
 * mounts the session in a temporary workspace at its own cwd, and retires that
 * workspace on the first user message so the session falls back to Ungrouped.
 *
 * Ownership is split in one direction only:
 * - the Host owns the mount object (create on announcement, delete on first
 *   message), the leftover cleanup, and every filesystem operation;
 * - the browser half owns creation, opening, the operator's explicit
 *   abandonment (`workspaces.delete`), and the UI;
 * - cross-half communication is limited to upstream session events, upstream
 *   store subscriptions, and client-to-host commands. The Host never infers a
 *   browser decision, and empty folders are reclaimed only at startup.
 */
import { isTaskFolder, taskFolderRoot } from './src/task-folder.js'
import { createMountLedger } from './src/mounts.js'
import { createDirReader } from './src/settings.js'
import { createStartupMaintenance } from './src/startup-sweep.js'

export { DEFAULT_DIR, Config } from './src/settings.js'

/** Operator-facing diagnostic; the logger is optional in reduced compositions. */
function warn(ctx, message) {
  try {
    ctx.logger?.warn?.('noworkspace-session: %s', message)
  } catch {
    /* logging is best-effort */
  }
}

/**
 * Wire the Host half.
 * @param ctx Plugin context; `settings`, `workspaceRegistry`, and `sessions` are optional.
 * @param config Loader-provided config, whose `defaultDir` may be a volatile reference.
 */
export function apply(ctx, config) {
  const report = (message) => warn(ctx, message)
  const readDir = createDirReader(ctx, config)
  const startedAt = Date.now()

  /** The live workspace registry, which may not be composed yet. */
  const registryOf = () => {
    try {
      return ctx.get('workspaceRegistry')
    } catch (error) {
      report(`could not resolve the workspace registry: ${String(error)}`)
      return undefined
    }
  }

  const ledger = createMountLedger({ registryOf, report, startedAt })
  const maintenance = createStartupMaintenance({ ctx, readDir, ledger, report })
  ctx.effect(() => () => maintenance.dispose(), 'noworkspace-session: startup maintenance')

  // A blank session of ours was announced: mount it while it is still blank,
  // which is both the freshly created case and a scratch session restored at
  // startup. A failed mount is retried by the next announcement of the same
  // session (the Agent announcement follows the creation one).
  ctx.on('api-session/added', (summary) => {
    maintenance.arm()
    if (summary === undefined || typeof summary.sessionId !== 'string') return
    // Subagent and fork children inherit the parent's cwd; they are not ours.
    if (summary.origin !== undefined || summary.parentSessionId !== undefined) return
    if (summary.blank !== true || ledger.handles(summary.sessionId)) return
    const root = taskFolderRoot(readDir())
    if (root === undefined || !isTaskFolder(root, summary.cwd)) return
    void ledger.mount(summary.sessionId, summary.cwd)
  })

  // The first user-authored durable message: the mount has done its job and
  // Ungrouped is the session's real home. `api-session/activity` fires only for
  // user-sourced messages, so nothing else can retire a mount early.
  ctx.on('api-session/activity', (sessionId) => {
    if (typeof sessionId !== 'string' || !ledger.handles(sessionId)) return
    void ledger.unmount(sessionId)
  })

  // A disposed session can never be unmounted by its own first message.
  ctx.on('api-session/removed', (sessionId) => {
    if (typeof sessionId === 'string') ledger.forget(sessionId)
  })
}
