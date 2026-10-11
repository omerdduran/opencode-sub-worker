/**
 * Shared constant markers and defaults.
 *
 * These strings form the small protocol between the plugin, the worker
 * sessions and the markdown task source. Keep them centralized.
 */

/** Plugin id used by the host to identify this plugin. */
export const PLUGIN_ID = "opencode-sub-worker"

/** Default slash command name. */
export const DEFAULT_COMMAND_NAME = "tasks"

/** Default worker agent id installed by the plugin (mode: all). */
export const DEFAULT_WORKER_AGENT = "subworker"

/** Worker system-prompt markers, mirrored in the installed agent file. */
export const DONE_MARKER = "[task:done]"
export const BLOCKED_MARKER = "[task:blocked]"

/** Prefix on the deterministic work turn the orchestrator sends a worker. */
export const WORK_MARKER = "[sub-worker:work]"

/** Prefix on every plugin-generated control/status turn. */
export const CONTROL_MARKER = "[sub-worker:control]"

/** Metadata keys recognised on an indented line under a checklist item. */
export const META_KEYS = [
  "id",
  "files",
  "verify",
  "deps",
  "agent",
  "model",
  "risk",
  "timeout",
] as const

export type MetaKey = (typeof META_KEYS)[number]

/** Storage key for the durable run snapshot. */
export const STORAGE_KEY = "state"

/** Default state file for non-storage persistence (kept for parity/CLI use). */
export const DEFAULT_STATE_PATH = ".work/state.json"

/** Values that turn a `verify:` gate off. */
export const VERIFY_OFF = new Set(["false", "no", "none", "off", "-"])

/** True when a line of user text was produced by the plugin itself. */
export function isPluginOwnedText(text: string): boolean {
  const t = text.trimStart()
  return t.startsWith(WORK_MARKER) || t.startsWith(CONTROL_MARKER)
}
