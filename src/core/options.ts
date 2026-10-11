/**
 * Plugin options: defaults, normalization and limit resolution. Invalid values
 * fall back to defaults so a misconfiguration can never break the host.
 */

import { DEFAULT_COMMAND_NAME, DEFAULT_STATE_PATH, DEFAULT_WORKER_AGENT } from "./constants.ts"
import type { ParseResult } from "./types.ts"

/** Which task-list format to parse. */
export type TaskFormat = "checklist" | "headings"

/** How a run integrates finished work. `assist` leaves the tree dirty (do-work style). */
export type RunMode = "integrate" | "assist"

/** Label names (lowercased) that carry each task field in the `headings` format. */
export interface FieldMap {
  files: string[]
  verify: string[]
  deps: string[]
  agent: string[]
  model: string[]
  locks: string[]
  priority: string[]
  risk: string[]
  whatToBuild: string[]
  acceptance: string[]
  outOfScope: string[]
  spec: string[]
  stories: string[]
  tdd: string[]
}

export const DEFAULT_FIELDS: FieldMap = {
  files: ["files"],
  verify: ["verify"],
  deps: ["deps", "depends on"],
  agent: ["agent"],
  model: ["model"],
  locks: ["locks"],
  priority: ["priority"],
  risk: ["risk"],
  whatToBuild: ["what to build"],
  acceptance: ["acceptance criteria"],
  outOfScope: ["out of scope"],
  spec: ["spec & identifiers in scope", "spec"],
  stories: ["stories"],
  tdd: ["tdd"],
}

export type CustomParser = (source: string) => ParseResult

export interface PluginOptions {
  commandName: string
  registerCommand: boolean
  registerTools: boolean

  /** Task-list format. */
  taskFormat: TaskFormat
  /** Field-label mapping for the `headings` format. */
  fields: FieldMap
  /** Treat file order as the dependency chain (no explicit deps). */
  sequentialDeps: boolean
  /** Path to a JS module exporting a custom parser. */
  parserModule: string
  /** Resolved custom parser (set from `parserModule`, not from JSON). */
  customParser?: CustomParser

  /** Upper bound on concurrently running workers. */
  maxConcurrency: number
  /** Per-task wall-clock timeout in ms. */
  taskTimeoutMs: number
  /** Verification command timeout in ms. */
  verifyTimeoutMs: number
  /** Retries per task after a failed gate before the run is paused. */
  maxAttempts: number
  /** Start each retry from a clean worktree instead of continuing in place. */
  freshWorktreeOnRetry: boolean
  /** A failed/blocked task no longer pauses the whole run; independent work continues. */
  continueOnError: boolean
  /** On a failed gate, steer the failure back to the same worker to repair it. */
  repairOnFailure: boolean

  /** Worker agent id (installed by the plugin when installWorkerAgent is on). */
  workerAgent: string
  /** Write the worker agent markdown into the project on setup. */
  installWorkerAgent: boolean
  /** Model for workers, e.g. "anthropic/claude-sonnet-4-5". Empty = inherit. */
  workerModel: string
  /** Per-agent model overrides, keyed by the task's `agent:` value. */
  roleModels: Record<string, string>
  /** Ordered fallback model references tried on retry after a failure. */
  fallbackModels: string[]
  /** Extra worker instructions appended to every worker prompt. */
  workerInstructions: string
  /** A file whose contents are appended to every worker prompt. */
  workerInstructionsFile: string
  /** Skills the worker should follow (appended to the prompt). */
  workerSkills: string[]
  /** The built-in worker report contract. `none` omits it. */
  workerContract: "generic" | "none"

  /** Create a git worktree per worker. When false, workers share the project. */
  useWorktrees: boolean
  /** Refuse to run in place if a worktree cannot be created. */
  requireWorktrees: boolean
  /** Merge each finished, disjoint worker branch back into the base branch. */
  autoMerge: boolean
  /** Commit a worker's worktree changes before merging. */
  commitBeforeMerge: boolean
  /** Remove worktrees after merging them. */
  cleanupWorktrees: boolean

  /** Deny edits outside the declared `files` scope at the session-permission level. */
  enforceWriteScope: boolean
  /** After a worker finishes, fail the task if it touched undeclared files. */
  enforceDiffScope: boolean

  /** Risk labels (case-insensitive) that require approval before integration. */
  approvalRisks: string[]
  /** Learn git co-change pairs and treat them as conflicts. */
  coChangeLearning: boolean
  /** Minimum co-change count before a learned pair conflicts. */
  coChangeMinCount: number
  /** Hold tasks whose body matches any of these regexes (checked before running). */
  holdPattern: string[]
  /** Mirror run/task status into the orchestrator session title. */
  mirrorSessionTitles: boolean

  /** How finished tasks are detected. */
  detectCompletion: "report" | "checkboxes"
  /** Append a per-task block to this file (relative to the project root). */
  progressFile: string
  /** Write `[x]` back to the source list when a task is done. */
  flipCheckboxes: boolean

  /** Run in `integrate` (merge) or `assist` (leave the tree dirty) mode. */
  mode: RunMode

  /** Run an independent read-only verifier session after the gate passes. */
  verifierEnabled: boolean
  /** Agent id used for the verifier session. */
  verifierAgent: string
  /** Extra verifier instructions appended to the verifier prompt. */
  verifierPrompt: string

  /** When a worker reports blocked, pause and wait for an answer instead of disposing it. */
  askUserOnBlocked: boolean

  /** Run budget. 0 disables the check. */
  maxCostUsd: number
  maxTokens: number

  /** Durable state snapshot. */
  persistState: boolean
  stateFilePath: string
}

export const DEFAULT_OPTIONS: PluginOptions = {
  commandName: DEFAULT_COMMAND_NAME,
  registerCommand: true,
  registerTools: true,

  taskFormat: "checklist",
  fields: DEFAULT_FIELDS,
  sequentialDeps: false,
  parserModule: "",

  maxConcurrency: 3,
  taskTimeoutMs: 20 * 60_000,
  verifyTimeoutMs: 10 * 60_000,
  maxAttempts: 2,
  freshWorktreeOnRetry: false,
  continueOnError: false,
  repairOnFailure: true,

  workerAgent: DEFAULT_WORKER_AGENT,
  installWorkerAgent: true,
  workerModel: "",
  roleModels: {},
  fallbackModels: [],
  workerInstructions: "",
  workerInstructionsFile: "",
  workerSkills: [],
  workerContract: "generic",

  useWorktrees: true,
  requireWorktrees: true,
  autoMerge: true,
  commitBeforeMerge: true,
  cleanupWorktrees: true,

  enforceWriteScope: true,
  enforceDiffScope: true,

  approvalRisks: [],
  coChangeLearning: false,
  coChangeMinCount: 2,
  holdPattern: ["\\[NEEDS DECISION"],
  mirrorSessionTitles: false,

  detectCompletion: "report",
  progressFile: "",
  flipCheckboxes: false,

  mode: "integrate",

  verifierEnabled: false,
  verifierAgent: "explore",
  verifierPrompt: "",

  askUserOnBlocked: false,

  maxCostUsd: 0,
  maxTokens: 0,

  persistState: true,
  stateFilePath: DEFAULT_STATE_PATH,
}

function num(raw: unknown, fallback: number, { min = 0, integer = false } = {}): number {
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN
  if (!Number.isFinite(n) || n < min) return fallback
  return integer ? Math.floor(n) : n
}

function bool(raw: unknown, fallback: boolean): boolean {
  return typeof raw === "boolean" ? raw : fallback
}

function str(raw: unknown, fallback: string): string {
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : fallback
}

function roleModels(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (raw && typeof raw === "object") {
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof value === "string" && value.trim().length > 0) out[key] = value.trim()
    }
  }
  return out
}

function strArray(raw: unknown): string[] {
  if (typeof raw === "string" && raw.trim().length > 0) return [raw.trim()]
  if (!Array.isArray(raw)) return []
  return raw.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => x.trim())
}

function labelList(raw: unknown, fallback: string[]): string[] {
  const list = strArray(raw).map((s) => s.toLowerCase())
  return list.length > 0 ? list : fallback
}

function fieldMap(raw: unknown): FieldMap {
  const source = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>
  const out = { ...DEFAULT_FIELDS }
  for (const key of Object.keys(DEFAULT_FIELDS) as Array<keyof FieldMap>) {
    if (key in source) out[key] = labelList(source[key], DEFAULT_FIELDS[key])
  }
  return out
}

export function normalizeOptions(raw: unknown): PluginOptions {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>
  const options: PluginOptions = {
    commandName: str(o["commandName"], DEFAULT_OPTIONS.commandName).replace(/^\/+/, ""),
    registerCommand: bool(o["registerCommand"], DEFAULT_OPTIONS.registerCommand),
    registerTools: bool(o["registerTools"], DEFAULT_OPTIONS.registerTools),

    taskFormat: o["taskFormat"] === "headings" ? "headings" : "checklist",
    fields: fieldMap(o["fields"]),
    sequentialDeps: bool(o["sequentialDeps"], DEFAULT_OPTIONS.sequentialDeps),
    parserModule: typeof o["parserModule"] === "string" ? o["parserModule"].trim() : DEFAULT_OPTIONS.parserModule,

    maxConcurrency: num(o["maxConcurrency"], DEFAULT_OPTIONS.maxConcurrency, { min: 1, integer: true }),
    taskTimeoutMs: num(o["taskTimeoutMs"], DEFAULT_OPTIONS.taskTimeoutMs, { min: 1 }),
    verifyTimeoutMs: num(o["verifyTimeoutMs"], DEFAULT_OPTIONS.verifyTimeoutMs, { min: 1 }),
    maxAttempts: num(o["maxAttempts"], DEFAULT_OPTIONS.maxAttempts, { min: 1, integer: true }),
    freshWorktreeOnRetry: bool(o["freshWorktreeOnRetry"], DEFAULT_OPTIONS.freshWorktreeOnRetry),
    continueOnError: bool(o["continueOnError"], DEFAULT_OPTIONS.continueOnError),
    repairOnFailure: bool(o["repairOnFailure"], DEFAULT_OPTIONS.repairOnFailure),

    workerAgent: str(o["workerAgent"], DEFAULT_OPTIONS.workerAgent),
    installWorkerAgent: bool(o["installWorkerAgent"], DEFAULT_OPTIONS.installWorkerAgent),
    workerModel: typeof o["workerModel"] === "string" ? o["workerModel"].trim() : DEFAULT_OPTIONS.workerModel,
    roleModels: roleModels(o["roleModels"]),
    fallbackModels: strArray(o["fallbackModels"]),
    workerInstructions: typeof o["workerInstructions"] === "string" ? o["workerInstructions"] : DEFAULT_OPTIONS.workerInstructions,
    workerInstructionsFile:
      typeof o["workerInstructionsFile"] === "string" ? o["workerInstructionsFile"].trim() : DEFAULT_OPTIONS.workerInstructionsFile,
    workerSkills: strArray(o["workerSkills"]),
    workerContract: o["workerContract"] === "none" ? "none" : "generic",

    useWorktrees: bool(o["useWorktrees"], DEFAULT_OPTIONS.useWorktrees),
    requireWorktrees: bool(o["requireWorktrees"], DEFAULT_OPTIONS.requireWorktrees),
    autoMerge: bool(o["autoMerge"], DEFAULT_OPTIONS.autoMerge),
    commitBeforeMerge: bool(o["commitBeforeMerge"], DEFAULT_OPTIONS.commitBeforeMerge),
    cleanupWorktrees: bool(o["cleanupWorktrees"], DEFAULT_OPTIONS.cleanupWorktrees),

    enforceWriteScope: bool(o["enforceWriteScope"], DEFAULT_OPTIONS.enforceWriteScope),
    enforceDiffScope: bool(o["enforceDiffScope"], DEFAULT_OPTIONS.enforceDiffScope),

    approvalRisks: strArray(o["approvalRisks"]),
    coChangeLearning: bool(o["coChangeLearning"], DEFAULT_OPTIONS.coChangeLearning),
    coChangeMinCount: num(o["coChangeMinCount"], DEFAULT_OPTIONS.coChangeMinCount, { min: 1, integer: true }),
    holdPattern: Array.isArray(o["holdPattern"]) ? strArray(o["holdPattern"]) : DEFAULT_OPTIONS.holdPattern,
    mirrorSessionTitles: bool(o["mirrorSessionTitles"], DEFAULT_OPTIONS.mirrorSessionTitles),

    detectCompletion: o["detectCompletion"] === "checkboxes" ? "checkboxes" : "report",
    progressFile: typeof o["progressFile"] === "string" ? o["progressFile"].trim() : DEFAULT_OPTIONS.progressFile,
    flipCheckboxes: bool(o["flipCheckboxes"], DEFAULT_OPTIONS.flipCheckboxes),

    mode: o["mode"] === "assist" ? "assist" : "integrate",

    verifierEnabled: bool(o["verifierEnabled"], DEFAULT_OPTIONS.verifierEnabled),
    verifierAgent: str(o["verifierAgent"], DEFAULT_OPTIONS.verifierAgent),
    verifierPrompt: typeof o["verifierPrompt"] === "string" ? o["verifierPrompt"] : DEFAULT_OPTIONS.verifierPrompt,

    askUserOnBlocked: bool(o["askUserOnBlocked"], DEFAULT_OPTIONS.askUserOnBlocked),

    maxCostUsd: num(o["maxCostUsd"], DEFAULT_OPTIONS.maxCostUsd, { min: 0 }),
    maxTokens: num(o["maxTokens"], DEFAULT_OPTIONS.maxTokens, { min: 0 }),

    persistState: bool(o["persistState"], DEFAULT_OPTIONS.persistState),
    stateFilePath: str(o["stateFilePath"], DEFAULT_OPTIONS.stateFilePath),
  }

  // `assist` mode leaves the tree dirty for a human (or an external committer),
  // so it forces the merging behaviours off.
  if (options.mode === "assist") {
    options.autoMerge = false
    options.commitBeforeMerge = false
    options.cleanupWorktrees = false
  }

  return options
}

/** Resolve the model reference for a task: task override, then role map, then default. */
export function resolveModelRef(options: PluginOptions, taskModel?: string, agent?: string): string {
  if (taskModel && taskModel.trim().length > 0) return taskModel.trim()
  if (agent && options.roleModels[agent]) return options.roleModels[agent]!
  return options.workerModel
}
