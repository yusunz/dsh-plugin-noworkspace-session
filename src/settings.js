/**
 * Plugin configuration and the one place the effective task-folder value is read.
 *
 * The value is taken from the config reference the Loader resolved first (the
 * profile patch has already been applied there), then from the settings mirror,
 * then from the schema default. `volatile()` is not decorative: the settings
 * service filters out any entry without a volatile field and refuses writes to
 * it, so this declaration is what makes the General-settings row writable.
 */
import z from '@deepseek-ai/schemastery'

/** Default task folder before an operator overrides it in Settings. `~` is expanded by the reader. */
export const DEFAULT_DIR = '~/Documents/dsh'

/** Fragment identifying this plugin's settings namespace in the Host descriptors. */
export const ENTRY_NS_HINT = 'noworkspace'

/** Plugin configuration; see the module comment for why `.volatile()` is required. */
export const Config = z.object({
  defaultDir: z.string().default(DEFAULT_DIR).volatile(),
})

/** The plain string behind a config value, which the Loader may hand over as a volatile reference. */
function plainDir(ref) {
  const value = typeof ref?.get === 'function' ? ref.get() : ref
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/**
 * Build the effective task-folder reader.
 *
 * The settings mirror is read first so the Host resolves the same value the
 * Client writes and reads; the Loader-provided volatile reference is the fallback
 * for reduced compositions without a settings service, and the schema default is
 * the last resort.
 *
 * The settings presentation is also suppressed here (`auto: false`): the Client
 * half renders its own row, so an auto-generated page would be a second copy of
 * the same setting.
 * @param ctx - Plugin context; the `settings` service is optional.
 * @param config - Loader-provided config, whose `defaultDir` may be a volatile reference.
 * @returns A function resolving the configured path, with `~` left unexpanded.
 */
export function createDirReader(ctx, config) {
  let fromSettings
  ctx.inject(['settings'], (child) => {
    child.effect(
      () => child.settings.configure({ auto: false }, ctx.fiber),
      'noworkspace-session: settings presentation',
    )
    fromSettings = () => {
      try {
        const row = child.settings.describe?.().find((entry) =>
          typeof entry?.ns === 'string' && entry.ns.includes(ENTRY_NS_HINT))
        const value = row?.value?.defaultDir
        if (typeof value === 'string' && value.trim() !== '') return value.trim()
      } catch {
        /* fall through to the loader-provided value */
      }
      return undefined
    }
  })
  return () => fromSettings?.() ?? plainDir(config?.defaultDir) ?? DEFAULT_DIR
}
