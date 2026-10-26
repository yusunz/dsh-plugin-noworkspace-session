/**
 * Startup-only disk and registry maintenance.
 *
 * The process cannot tell why a workspace disappeared, so it never reclaims a
 * session cwd while running. What it can do, once per start, is collect what an
 * earlier process left behind: retired mounts and empty task folders.
 *
 * The trigger is the first session announcement, which is the restore creating an
 * Agent — there is no renderer-connected event to wait for. A settle delay lets
 * the side views that resume right behind it reach the live list first, and a
 * fallback arm covers a Host nobody restores into (headless).
 */
import { canonicalPath, canonicalTaskRoot, sweepEmptyTaskFolders } from './task-folder.js'

/**
 * Create the one-shot startup maintenance.
 * @param ctx - Plugin context; the `sessions` and `sessionPersistence` services are optional.
 * @param readDir - Resolves the configured task-folder path at run time.
 * @param ledger - Mount ledger, which owns leftover-mount retirement.
 * @param report - Operator-facing diagnostic sink.
 * @param settleMs - Delay after the first announcement, so restored sessions are live.
 * @param fallbackMs - Delay before running without any announcement.
 * @returns `arm()` for the first announcement and `dispose()` for plugin teardown.
 */
export function createStartupMaintenance({
  ctx,
  readDir,
  ledger,
  report,
  settleMs = 2000,
  fallbackMs = 30000,
}) {
  let armed = false
  let ran = false
  let disposed = false
  let settleTimer
  let fallbackTimer

  const addCwd = async (keep, cwd) => {
    if (typeof cwd === 'string' && cwd !== '') keep.add(await canonicalPath(cwd))
  }

  /**
   * Canonical cwds whose folders must survive: live sessions plus every stored
   * session. Stored sessions matter because resume does not recreate a cwd, so a
   * persisted session whose folder was swept would later fail its tool calls.
   */
  const keepCwds = async () => {
    const keep = new Set()
    try {
      for (const session of ctx.get('sessions')?.list?.() ?? []) await addCwd(keep, session?.header?.cwd)
    } catch (error) {
      report(`could not read the live session list: ${String(error)}`)
    }
    try {
      const persistence = ctx.get('sessionPersistence')
      for (const record of await persistence?.list?.() ?? []) await addCwd(keep, record?.header?.cwd)
    } catch (error) {
      report(`could not read the persisted session list: ${String(error)}`)
    }
    return keep
  }

  const run = async () => {
    if (disposed || ran) return
    ran = true
    if (fallbackTimer !== undefined) clearTimeout(fallbackTimer)
    // Maintenance must never be able to take the Host down: an unhandled
    // rejection here exits the desktop process, so every failure stays local.
    try {
      const root = await canonicalTaskRoot(readDir())
      if (disposed || root === undefined) return
      await ledger.retireLeftovers(root)
      if (disposed) return
      await sweepEmptyTaskFolders(root, await keepCwds())
    } catch (error) {
      report(`startup maintenance skipped: ${String(error)}`)
    }
  }

  const arm = () => {
    if (armed || disposed) return
    armed = true
    if (fallbackTimer !== undefined) clearTimeout(fallbackTimer)
    settleTimer = setTimeout(() => void run(), settleMs)
  }

  fallbackTimer = setTimeout(() => void run(), fallbackMs)

  return {
    arm,
    dispose: () => {
      disposed = true
      if (settleTimer !== undefined) clearTimeout(settleTimer)
      if (fallbackTimer !== undefined) clearTimeout(fallbackTimer)
    },
  }
}
