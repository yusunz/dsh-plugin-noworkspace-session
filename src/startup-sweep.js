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
 * @param ctx - Plugin context; the live `sessions` service is optional.
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

  /** Canonical cwds of the live sessions whose folders must survive. */
  const liveCwds = async () => {
    const live = new Set()
    try {
      for (const session of ctx.get('sessions')?.list?.() ?? []) {
        const cwd = session?.header?.cwd
        if (typeof cwd === 'string' && cwd !== '') live.add(await canonicalPath(cwd))
      }
    } catch (error) {
      report(`could not read the live session list: ${String(error)}`)
    }
    return live
  }

  const run = async () => {
    if (disposed || ran) return
    ran = true
    if (fallbackTimer !== undefined) clearTimeout(fallbackTimer)
    // Maintenance must never be able to take the Host down: an unhandled
    // rejection here exits the desktop process, so every failure stays local.
    try {
      const root = await canonicalTaskRoot(readDir())
      if (root === undefined) return
      await ledger.retireLeftovers(root)
      await sweepEmptyTaskFolders(root, await liveCwds())
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
