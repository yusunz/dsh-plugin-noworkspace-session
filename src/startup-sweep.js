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
import { canonicalPath, canonicalTaskRoot, normalizePath, sweepEmptyTaskFolders } from './task-folder.js'

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

  /** Canonical cwds of the live sessions, whose folders must survive. */
  const liveCwds = async () => {
    const keep = new Set()
    try {
      for (const session of ctx.get('sessions')?.list?.() ?? []) {
        const cwd = session?.header?.cwd
        if (typeof cwd === 'string' && cwd !== '') keep.add(await canonicalPath(cwd))
      }
    } catch (error) {
      report(`could not read the live session list: ${String(error)}`)
    }
    return keep
  }

  /**
   * Stored sessions grouped by canonical cwd.
   *
   * A stored session keeps its folder only when it actually carries events: a
   * blank session (header line only) is what an abandoned scratch session leaves
   * behind, and its empty folder must still be reclaimed. Resume does not recreate
   * a cwd, so a stored session with events must keep its folder.
   * @returns Map from normalized cwd to stored session ids.
   */
  const persistedByCwd = async () => {
    const byCwd = new Map()
    try {
      const persistence = ctx.get('sessionPersistence')
      for (const record of await persistence?.list?.() ?? []) {
        const id = record?.header?.id
        const cwd = record?.header?.cwd
        if (typeof id !== 'string' || typeof cwd !== 'string' || cwd === '') continue
        const key = await canonicalPath(cwd)
        const ids = byCwd.get(key)
        if (ids === undefined) byCwd.set(key, [id])
        else ids.push(id)
      }
    } catch (error) {
      report(`could not read the persisted session list: ${String(error)}`)
    }
    return byCwd
  }

  /**
   * Whether a stored session ever started a turn.
   *
   * DSH writes setup events (permission preset, sandbox mode, approval policy, …)
   * when the Agent is created, but the session stays blank until `turn/start` —
   * so event count alone would keep every abandoned scratch session. A failed or
   * unavailable read keeps the folder: deleting the cwd of a session that may
   * carry history is worse than leaving an empty directory behind.
   * @param sessionId - Stored session id.
   * @returns whether the log carries a `turn/start` event.
   */
  const sessionHasTurns = async (sessionId) => {
    const persistence = ctx.get('sessionPersistence')
    if (persistence?.open === undefined) return true
    try {
      const handle = await persistence.open(sessionId, 'read')
      try {
        const chunk = 200
        for (let offset = 0, pages = 0; pages < 100; offset += chunk, pages += 1) {
          const slice = await handle.read(offset, chunk)
          const events = slice?.events ?? []
          if (events.some((event) => event?.type === 'turn/start')) return true
          if (events.length < chunk) return false
        }
        return true
      } finally {
        try { await handle.close() } catch { /* read handle close is uncancellable best-effort */ }
      }
    } catch {
      return true
    }
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
      const keep = await liveCwds()
      const persisted = await persistedByCwd()
      const shouldKeep = async (folder) => {
        const ids = persisted.get(normalizePath(folder))
        if (ids === undefined) return false
        for (const id of ids) if (await sessionHasTurns(id)) return true
        return false
      }
      if (disposed) return
      await sweepEmptyTaskFolders(root, keep, shouldKeep)
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
