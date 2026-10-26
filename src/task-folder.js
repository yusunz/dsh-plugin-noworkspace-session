/**
 * Task-folder naming and disk maintenance.
 *
 * The browser half mints `<root>/<YYYY-MM-DD>/<HH-MM-SS>` as a session cwd. This
 * module is the only place on the Host side that knows that shape, and the only
 * place that removes folders from disk: empty ones are reclaimed at startup,
 * never while the process is running.
 */
import { readdir, realpath, rmdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** `<date>` segment of a task folder. */
export const DATE_FOLDER = /^\d{4}-\d{2}-\d{2}$/
/** `<time>` segment of a task folder. */
export const TIME_FOLDER = /^\d{2}-\d{2}-\d{2}$/
/** Title prefix of a temporary mount. Display only, but also the cleanup marker. */
export const MOUNT_TITLE_PREFIX = '无项目任务 · '

/**
 * Normalize a path for lexical comparison: resolved, forward slashes, and
 * case-folded only where the filesystem is case-insensitive.
 * @param value - Candidate path.
 * @returns The comparable form, or an empty string for a non-string input.
 */
export function normalizePath(value) {
  if (typeof value !== 'string' || value === '') return ''
  const slashed = resolve(value).replace(/\\/g, '/').replace(/\/+$/, '')
  return process.platform === 'win32' ? slashed.toLowerCase() : slashed
}

/**
 * Local wall clock as `HH-MM-SS`, the shape the task folder and mount title use.
 * @param date - Moment to format.
 * @returns The time segment.
 */
export function stamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`
}

/**
 * Expand the leading `~` of a configured path against the host home.
 * @param raw - Configured path.
 * @returns An absolute path, or undefined when the value is unusable.
 */
export function expandHome(raw) {
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim()
  if (trimmed === '') return undefined
  if (trimmed === '~') return homedir()
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) return join(homedir(), trimmed.slice(2))
  return resolve(trimmed)
}

/**
 * The configured task-folder root as an absolute path.
 * @param raw - Configured path, possibly `~`-rooted.
 * @returns The absolute root, or undefined when the value is unusable.
 */
export function taskFolderRoot(raw) {
  const expanded = expandHome(raw)
  return expanded === undefined ? undefined : resolve(expanded)
}

/**
 * Normalize one path with symlinks resolved.
 *
 * Registry paths and directory listings are canonical, while a session header
 * keeps the cwd the Client passed (which may be an 8.3 short name or sit behind
 * a junction); live-session guards must compare canonical forms.
 * @param value - Candidate path.
 * @returns The comparable form, falling back to the lexical one.
 */
export async function canonicalPath(value) {
  try {
    return normalizePath(await realpath(value))
  } catch {
    return normalizePath(value)
  }
}

/**
 * The task-folder root with symlinks resolved; registry paths are canonical, so
 * startup comparisons use this form while live events keep the lexical one.
 * @param raw - Configured path.
 * @returns The canonical root, falling back to the lexical one.
 */
export async function canonicalTaskRoot(raw) {
  const root = taskFolderRoot(raw)
  if (root === undefined) return undefined
  return canonicalPath(root)
}

/**
 * Whether a session cwd (or a mount path) has the task-folder shape
 * `<root>/<YYYY-MM-DD>/<HH-MM-SS>`.
 * @param root - Effective task-folder root.
 * @param path - Candidate session cwd or workspace path.
 * @returns whether the path lies under the root in the date/time shape.
 */
export function isTaskFolder(root, path) {
  const normalizedRoot = normalizePath(root)
  const normalizedPath = normalizePath(path)
  if (normalizedRoot === '' || normalizedPath === '') return false
  if (!normalizedPath.startsWith(`${normalizedRoot}/`)) return false
  const rest = normalizedPath.slice(normalizedRoot.length + 1).split('/')
  return rest.length === 2 && DATE_FOLDER.test(rest[0]) && TIME_FOLDER.test(rest[1])
}

/**
 * Reclaim the empty task folders that no live or stored-with-events session uses.
 *
 * `rmdir` refuses a non-empty directory, so a directory holding files is always
 * left as it is; a date folder is removed only once its last task folder is gone.
 * @param root - Canonical task-folder root.
 * @param live - Normalized cwds of live sessions, whose folders must survive.
 * @param shouldKeep - Optional async predicate for stored sessions; a folder it
 *   accepts survives even though it is empty.
 */
export async function sweepEmptyTaskFolders(root, live, shouldKeep) {
  if (typeof root !== 'string' || root === '') return
  let dates
  try {
    dates = await readdir(root, { withFileTypes: true })
  } catch {
    return
  }
  const keep = live ?? new Set()
  for (const date of dates) {
    if (!date.isDirectory() || !DATE_FOLDER.test(date.name)) continue
    const datePath = join(root, date.name)
    if (keep.has(normalizePath(datePath))) continue
    let times
    try {
      times = await readdir(datePath, { withFileTypes: true })
    } catch {
      continue
    }
    for (const time of times) {
      if (!time.isDirectory() || !TIME_FOLDER.test(time.name)) continue
      const folder = join(datePath, time.name)
      if (keep.has(normalizePath(folder))) continue
      if (shouldKeep !== undefined && await shouldKeep(folder)) continue
      try {
        await rmdir(folder)
      } catch {
        /* a folder with content, or one already gone, is left as it is */
      }
    }
    try {
      await rmdir(datePath)
    } catch {
      /* still holds task folders or other files */
    }
  }
}
