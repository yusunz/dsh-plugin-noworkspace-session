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
import { readdir, rmdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import z from '@deepseek-ai/schemastery'

/** Default task folder before an operator overrides it in Settings. `~` is expanded in the browser. */
export const DEFAULT_DIR = '~/Documents/dsh'

/**
 * Plugin configuration. `defaultDir` accepts an absolute host path or a
 * `~`-rooted home path; the Client expands `~` against `ctx.remote.$host.home`
 * and Host `session.create` recursively creates whatever path it receives.
 *
 * `volatile()` is what makes the field exist as far as settings are concerned:
 * the settings service projects a form through `volatileForm()`, which keeps
 * only volatile nodes and returns undefined for an object that has none. An
 * entry without a volatile field is filtered out of `describe()` entirely, so
 * its namespace never reaches the client and writes to it are refused.
 */
export const Config = z.object({
  defaultDir: z.string().default(DEFAULT_DIR).volatile(),
})

/** Session-id prefix the browser half mints; the Host half recognizes its own sessions by it. */
const SESSION_PREFIX = 'session-nws-'
/** Fragment identifying this plugin's settings namespace in the Host descriptors. */
const ENTRY_HINT = 'noworkspace'
/** How often a mount the browser half retired is noticed. */
const RECLAIM_POLL_MS = 1000
/** Temporary-workspace title prefix; the browser half identifies its mounts by it when sweeping. */
const MOUNT_TITLE_PREFIX = '无项目任务 · '
/** Task-folder naming this plugin mints: `<base>\<YYYY-MM-DD>\<HH-MM-SS>`. */
const DATE_FOLDER = /^\d{4}-\d{2}-\d{2}$/
const TIME_FOLDER = /^\d{2}-\d{2}-\d{2}$/
/**
 * Settle after the renderer's first session announcement, so the side views that
 * resume right behind it are in the live list too before anything is removed.
 */
const RESTORE_SETTLE_MS = 2000
/**
 * Fallback arm for a Host nobody restores into (headless): without it the sweep
 * would never run, and its leftovers are exactly what it exists to collect.
 */
const RESTORE_TIMEOUT_MS = 30000

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
 *
 * This declaration is also where the effective `defaultDir` is read from: the
 * descriptor carries the value the operator's profile patch resolved to, whereas
 * the `config` argument is the entry's own composition and can still hold the
 * schema default when the row was written from the client.
 * @param ctx Plugin context; `settings` is optional and skipped when absent.
 * @param config Loader-provided config, used only as a fallback.
 */
export function apply(ctx, config) {
  /** Effective task-folder setting, falling back to the loader-provided value. */
  const fromConfig = () => (typeof config?.defaultDir === 'string' ? config.defaultDir : undefined)
  let readConfiguredDir = fromConfig
  ctx.inject(['settings'], (child) => {
    child.effect(
      () => child.settings.configure({ auto: false }, ctx.fiber),
      'noworkspace-session: settings presentation',
    )
    readConfiguredDir = () => {
      try {
        const row = child.settings.describe?.()
          .find((entry) => typeof entry?.ns === 'string' && entry.ns.includes(ENTRY_HINT))
        const value = row?.value?.defaultDir
        if (typeof value === 'string' && value.trim() !== '') return value
      } catch { /* fall through to the loader-provided config */ }
      return fromConfig()
    }
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
  /**
   * Mounts this process created, and the sessions that have carried a message.
   *
   * The browser half owns the "the operator left" decision — its sweep deletes
   * the mount — so the Host's part is only to notice that a mount of its own is
   * gone and, when that session never carried a message, reclaim the empty task
   * folder right away instead of leaving it for the next start.
   */
  const mounts = new Map()
  const usedSessions = new Set()
  const track = {
    remember: (sessionId, cwd) => { mounts.set(sessionId, cwd) },
    release: (sessionId) => { usedSessions.add(sessionId); mounts.delete(sessionId) },
  }
  const consider = (sessionId, cwd) => {
    if (handled.has(sessionId)) return
    handled.add(sessionId)
    void mount(registryOf(), sessionId, cwd, report, track)
  }

  /**
   * Run the empty-folder sweep once, on the first session announcement.
   *
   * There is no "renderer connected" event (checked: no `client/*`, `connection/*`
   * or `gateway/*` one), but the precise condition is the one the sweep itself
   * needs: the live session store holds the sessions whose folders must survive.
   * A restore creates its agent, which lands in the store and announces itself,
   * so the first announcement IS the restore — the settle then covers the side
   * views that resume right behind it. The timeout arm covers a Host that nobody
   * restores into.
   */
  let folderSweepArmed = true
  const armFolderSweep = () => {
    if (!folderSweepArmed) return
    folderSweepArmed = false
    void (async () => {
      await delay(RESTORE_SETTLE_MS)
      // Maintenance must never be able to take the Host down: an unhandled
      // rejection here exits the desktop process, so every failure stays local.
      try {
        await retireEmptyTaskFolders(ctx, readConfiguredDir, report)
      } catch (error) {
        report(`empty task folder sweep skipped: ${String(error)}`)
      }
    })()
  }
  void (async () => {
    await delay(RESTORE_TIMEOUT_MS)
    try {
      armFolderSweep()
    } catch (error) {
      report(`empty task folder sweep could not be armed: ${String(error)}`)
    }
  })()

  // A session of ours was announced: mount it while it is still blank, which is
  // both the freshly created case and a blank scratch session restored at
  // startup. A session that already carries history needs no mount.
  ctx.on('api-session/added', (summary) => {
    armFolderSweep()
    if (summary === undefined || typeof summary.sessionId !== 'string') return
    if (!summary.sessionId.startsWith(SESSION_PREFIX)) return
    if (summary.blank !== true) return
    consider(summary.sessionId, summary.cwd)
  })

  // The first user-authored durable message: the mount has done its job and
  // Ungrouped is the session's real home.
  ctx.on('api-session/activity', (sessionId) => {
    if (typeof sessionId !== 'string') return
    // A message makes the session real work: from here its folder stays for good.
    track.release(sessionId)
    void unmount(registryOf(), sessionId, report)
  })

  /**
   * Reclaim a task folder whose mount the browser half retired.
   *
   * Deleting the mount is the browser half's abandonment decision (the session
   * was blank, never current, or left behind); this only reacts to it, at the
   * tick's latency, and only removes a folder that is empty and belongs to no
   * live session.
   */
  const reclaimAbandonedMounts = async () => {
    if (mounts.size === 0) return
    const registry = registryOf()
    if (registry === undefined) return
    let liveWorkspaces
    try {
      liveWorkspaces = registry.list()
    } catch {
      return
    }
    const liveFolders = new Set()
    try {
      for (const session of ctx.get('sessions')?.list?.() ?? []) {
        const cwd = session?.header?.cwd
        if (typeof cwd === 'string' && cwd !== '') liveFolders.add(resolve(cwd).toLowerCase())
      }
    } catch { /* the live list guards the sweep, it does not gate it */ }
    for (const [sessionId, cwd] of [...mounts]) {
      if (liveWorkspaces.some((workspace) => workspace.sessionIds.includes(sessionId))) continue
      mounts.delete(sessionId)
      if (usedSessions.has(sessionId)) continue
      if (typeof cwd !== 'string' || cwd === '' || liveFolders.has(resolve(cwd).toLowerCase())) continue
      try {
        await removeEmptyTaskFolder(cwd)
      } catch (error) {
        report(`could not reclaim the task folder for session ${sessionId}: ${String(error)}`)
      }
    }
  }
  ctx.effect(() => {
    const timer = setInterval(() => { void reclaimAbandonedMounts() }, RECLAIM_POLL_MS)
    return () => { clearInterval(timer) }
  }, 'noworkspace-session: abandoned mount reclaim')

  // Two startup duties, each with its own precondition.
  //
  // 1. A previous process can leave mounts behind (crash, upgrade, or an earlier
  //    build): retire every workspace whose members are all sessions of ours.
  //    Keyed on membership rather than the title, so mounts from older prefixes
  //    are collected too; the operator's own workspaces never hold these ids.
  void (async () => {
    try {
      const registry = await waitForRegistry(registryOf)
      if (registry !== undefined) await retireLeftovers(registry, report)
    } catch (error) {
      report(`leftover mount sweep skipped: ${String(error)}`)
    }
  })()

  // 2. An abandoned scratch session leaves an empty task folder: `session.create`
  //    mkdirs its cwd and nothing removes it afterwards. `armFolderSweep` above
  //    collects those, gated on the restore rather than on a fixed delay.
}

/**
 * The configured task-folder root with `~` expanded, or undefined when the
 * plugin has no usable path.
 * @param raw Configured path, from the effective settings value.
 * @returns An absolute path, or undefined.
 */
function taskFolderRoot(raw) {
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim()
  if (trimmed === '') return undefined
  const expanded = trimmed === '~' || trimmed.startsWith('~/') || trimmed.startsWith('~\\')
    ? join(homedir(), trimmed.slice(1))
    : trimmed
  return resolve(expanded)
}

/**
 * Remove one abandoned task folder while it is empty, then its date folder once
 * that empties too. `rmdir` refuses a non-empty directory, so a folder the agent
 * wrote into is never touched.
 * @param cwd The task folder the reclaimed mount was created for.
 */
async function removeEmptyTaskFolder(cwd) {
  const folder = resolve(cwd)
  try {
    await rmdir(folder)
  } catch {
    return
  }
  const parent = dirname(folder)
  if (DATE_FOLDER.test(basename(parent))) {
    try { await rmdir(parent) } catch { /* still holds other task folders */ }
  }
}

/**
 * Remove the empty task folders this plugin created for sessions that no longer
 * exist: `<root>\<date>\<time>` in the naming this plugin mints, empty, and not
 * the cwd of any live session. `rmdir` refuses a non-empty directory, so a task
 * folder the agent wrote into is never touched; a date folder is only removed
 * once its last task folder is gone. Sessions themselves are never deleted —
 * the Host exposes no such call.
 * @param ctx Plugin context; `sessions` is the Host store and is optional.
 * @param readDir Resolves the configured task-folder root at sweep time.
 * @param report Operator-facing diagnostic sink.
 */
async function retireEmptyTaskFolders(ctx, readDir, report) {
  const root = taskFolderRoot(readDir())
  if (root === undefined) return
  let dates
  try {
    dates = await readdir(root, { withFileTypes: true })
  } catch {
    return
  }
  const live = new Set()
  try {
    for (const session of ctx.get('sessions')?.list?.() ?? []) {
      const cwd = session?.header?.cwd
      if (typeof cwd === 'string' && cwd !== '') live.add(resolve(cwd).toLowerCase())
    }
  } catch (error) {
    report(`could not read the live session list: ${String(error)}`)
  }
  for (const date of dates) {
    if (!date.isDirectory() || !DATE_FOLDER.test(date.name)) continue
    const datePath = join(root, date.name)
    if (live.has(datePath.toLowerCase())) continue
    let times
    try {
      times = await readdir(datePath, { withFileTypes: true })
    } catch {
      continue
    }
    for (const time of times) {
      if (!time.isDirectory() || !TIME_FOLDER.test(time.name)) continue
      const folder = join(datePath, time.name)
      if (live.has(folder.toLowerCase())) continue
      try {
        await rmdir(folder)
      } catch { /* a folder with content, or one already gone, is left as it is */ }
    }
    try {
      await rmdir(datePath)
    } catch { /* still holds task folders or other files */ }
  }
}

/**
 * Resolve the workspace registry once it is composed; this plugin can apply
 * before the registry exists.
 * @param lookup Registry accessor.
 * @returns The registry, or undefined after the retries are exhausted.
 */
async function waitForRegistry(lookup) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const registry = lookup()
    if (registry !== undefined) return registry
    await delay(500)
  }
  return undefined
}

/**
 * Wait before a startup sweep whose precondition is a restored session list.
 * @param ms Delay in milliseconds.
 */
function delay(ms) {
  return new Promise((done) => { setTimeout(done, ms) })
}

/**
 * Register the session's own cwd as a workspace and attach it; a session the
 * operator already placed in some workspace is left alone.
 * @param registry Host workspace registry, when the profile composes one.
 * @param sessionId Session to mount.
 * @param cwd The session's project directory (the task folder).
 * @param report Operator-facing diagnostic sink.
 */
async function mount(registry, sessionId, cwd, report, track) {
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
    track?.remember(sessionId, cwd)
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
