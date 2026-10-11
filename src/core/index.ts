/**
 * Public core surface (platform independent).
 */

export type {
  Task,
  TaskStatus,
  RunStatus,
  RunState,
  MailboxMessage,
  RunHistoryEntry,
  ParseResult,
  WorkerReport,
  Wave,
  Graph,
  SchedulePreview,
} from "./types.ts"

export {
  PLUGIN_ID,
  DEFAULT_COMMAND_NAME,
  DEFAULT_WORKER_AGENT,
  DONE_MARKER,
  BLOCKED_MARKER,
  WORK_MARKER,
  CONTROL_MARKER,
  META_KEYS,
  STORAGE_KEY,
  DEFAULT_STATE_PATH,
  VERIFY_OFF,
  isPluginOwnedText,
} from "./constants.ts"

export { normalizeOptions, DEFAULT_OPTIONS, DEFAULT_FIELDS, resolveModelRef } from "./options.ts"
export type { PluginOptions, FieldMap, TaskFormat, RunMode, CustomParser } from "./options.ts"

export { parseChecklist } from "./parser.ts"
export { parseHeadings } from "./parse-headings.ts"
export type { HeadingParseResult } from "./parse-headings.ts"
export { buildGraph, conflicts, findCycle, previewWaves } from "./graph.ts"
export { specConflicts, pathMatchesGlob, matchesAny, globToRegExp, hasGlob } from "./glob.ts"
export {
  nextBatch,
  propagateSkips,
  activeCount,
  hasPending,
  isSettled,
  isTerminalBad,
} from "./scheduler.ts"
export { RunStore, makeRun } from "./state.ts"
export type { StoreSnapshot } from "./state.ts"
export { CoChangeStore } from "./cochange.ts"
export {
  buildWorkerPrompt,
  buildVerifierPrompt,
  buildRepairPrompt,
  parseWorkerOutcome,
  parseWorkerReport,
  control,
  summarize,
} from "./prompt.ts"
export type { WorkerPromptContext } from "./prompt.ts"
export { Engine, parseModel, parseModelRef } from "./engine.ts"
export type { ReportInput, EngineEvent } from "./engine.ts"
