/**
 * The Host half's mount ledger.
 *
 * The browser half can create a Session but cannot attach it to a Workspace, so
 * the Host mounts each blank task-folder Session in a workspace whose path is the
 * session's own cwd and retires that workspace when the first user message lands.
 * This module owns that lifecycle and is the only place that accounts for it: the
 * browser half never asks the Host to mount, and the Host never infers a decision
 * from a mount disappearing.
 *
 * A mount is recorded by session id and workspace id. The workspace title carries
 * the display prefix as well; it is used only to recognize leftovers of an earlier
 * process, never to decide whether a live mount is ours.
 */
import { MOUNT_TITLE_PREFIX, isTaskFolder, stamp } from './task-folder.js'

/**
 * Create the ledger over a lazily resolved workspace registry.
 * @param registryOf - Resolves the Host workspace registry, which may not be composed yet.
 * @param report - Operator-facing diagnostic sink.
 * @param startedAt - Process start, so cleanup never touches a workspace this process created.
 * @returns The ledger.
 */
export function createMountLedger({ registryOf, report, startedAt }) {
  /** sessionId -> { workspaceId, cwd } */
  const mounts = new Map()
  /** Sessions with a mount attempt in flight; the Host announces a session twice. */
  const pending = new Set()

  /**
   * Mount one blank task-folder session.
   *
   * A workspace this plugin created is mounted and recorded. An existing
   * workspace is adopted only when it carries the mount title prefix, which can
   * only be a leftover of an earlier process; anything else belongs to the
   * operator and is never attached to (so it is never deleted either).
   * @param sessionId - Session to mount.
   * @param cwd - The session's own task folder.
   * @returns whether the session is now mounted.
   */
  async function mount(sessionId, cwd) {
    if (mounts.has(sessionId)) return true
    if (pending.has(sessionId)) return false
    pending.add(sessionId)
    try {
      const registry = registryOf()
      if (registry === undefined) {
        report(`session ${sessionId} could not be mounted: the profile composes no workspace registry`)
        return false
      }
      const existing = await registry.resolveByPath(cwd)
      let workspace = existing
      let owned = existing !== undefined && typeof existing.title === 'string'
        && existing.title.startsWith(MOUNT_TITLE_PREFIX)
      if (workspace === undefined) {
        workspace = await registry.create(cwd, `${MOUNT_TITLE_PREFIX}${stamp()}`)
        owned = true
      }
      if (!owned) {
        report(`session ${sessionId} stays ungrouped: ${String(cwd)} already belongs to a workspace`)
        return false
      }
      // A second session in the same second shares the folder; attaching both to
      // one mount would make the first message retire the other's workspace too.
      if (existing !== undefined && existing.sessionIds.some((id) => id !== sessionId)) {
        report(`session ${sessionId} stays ungrouped: ${String(cwd)} is already mounted for another session`)
        return false
      }
      await workspace.attachSession(sessionId)
      mounts.set(sessionId, { workspaceId: workspace.id, cwd })
      return true
    } catch (error) {
      // Everything still works without the mount: the hero keeps its native
      // "choose a workspace" state, so this is a warning rather than a failure.
      report(`could not mount session ${sessionId} at ${String(cwd)}: ${String(error)}`)
      return false
    } finally {
      pending.delete(sessionId)
    }
  }

  /**
   * Retire the temporary workspace of one session (first user message).
   * @param sessionId - Session whose mount to retire.
   */
  async function unmount(sessionId) {
    const entry = mounts.get(sessionId)
    if (entry === undefined) return
    mounts.delete(sessionId)
    const registry = registryOf()
    if (registry === undefined) return
    try {
      await registry.delete(entry.workspaceId)
    } catch (error) {
      report(`could not retire the mount for session ${sessionId}: ${String(error)}`)
    }
  }

  /** Forget a session without touching the registry (it is already gone). */
  function forget(sessionId) {
    mounts.delete(sessionId)
  }

  /**
   * Timestamp of a workspace record, or 0 when it cannot be read.
   * @param workspace - Registry entity.
   * @returns Milliseconds since epoch, or 0.
   */
  function createdAtOf(workspace) {
    const raw = workspace?.createdAt
    const time = raw instanceof Date ? raw.getTime() : typeof raw === 'number' ? raw : Date.parse(String(raw))
    return Number.isFinite(time) ? time : 0
  }

  /**
   * Retire the mounts an earlier process left behind.
   *
   * The predicate is deliberately narrow: a task-folder path, the mount title
   * prefix, older than this process, and not one of the live mounts. A workspace
   * the operator registered by hand (different title) is never a candidate.
   * @param root - Canonical task-folder root.
   */
  async function retireLeftovers(root) {
    if (root === undefined) return
    const registry = registryOf()
    if (registry === undefined) return
    let workspaces
    try {
      workspaces = registry.list()
    } catch (error) {
      report(`could not read the workspace registry: ${String(error)}`)
      return
    }
    const active = new Set([...mounts.values()].map((entry) => entry.workspaceId))
    for (const workspace of workspaces) {
      if (active.has(workspace.id)) continue
      if (typeof workspace.title !== 'string' || !workspace.title.startsWith(MOUNT_TITLE_PREFIX)) continue
      if (!isTaskFolder(root, workspace.path)) continue
      if (createdAtOf(workspace) >= startedAt) continue
      try {
        await registry.delete(workspace.id)
      } catch (error) {
        report(`could not retire leftover workspace "${String(workspace.title)}": ${String(error)}`)
      }
    }
  }

  return {
    handles: (sessionId) => mounts.has(sessionId),
    mount,
    unmount,
    forget,
    retireLeftovers,
  }
}
