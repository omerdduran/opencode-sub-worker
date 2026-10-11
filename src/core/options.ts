/**
 * Plugin options: defaults and normalization. Invalid values fall back to
 * defaults so a misconfiguration can never break the host.
 */

import { DEFAULT_COMMAND_NAME, DEFAULT_STATE_PATH, DEFAULT_WORKER_AGENT } from "./constants.ts"

export interface PluginOptions {
  commandName: string
  registerCommand: boolean
  registerTools: boolean

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
  /** Mirror run/task status into the orchestrator session title. */
  mirrorSessionTitles: boolean

  /** Run an independent read-only verifier session after the gate passes. */
  verifierEnabled: boolean
  /** Agent id used for the verifier session. */
  verifierAgent: string

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
  mirrorSessionTitles: false,

  verifierEnabled: false,
  verifierAgent: "explore",

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
  if (!Array.isArray(raw)) return []
  return raw.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => x.trim())
}

export function normalizeOptions(raw: unknown): PluginOptions {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>
  return {
    commandName: str(o["commandName"], DEFAULT_OPTIONS.commandName).replace(/^\/+/, ""),
    registerCommand: bool(o["registerCommand"], DEFAULT_OPTIONS.registerCommand),
    registerTools: bool(o["registerTools"], DEFAULT_OPTIONS.registerTools),

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
    mirrorSessionTitles: bool(o["mirrorSessionTitles"], DEFAULT_OPTIONS.mirrorSessionTitles),

    verifierEnabled: bool(o["verifierEnabled"], DEFAULT_OPTIONS.verifierEnabled),
    verifierAgent: str(o["verifierAgent"], DEFAULT_OPTIONS.verifierAgent),

    askUserOnBlocked: bool(o["askUserOnBlocked"], DEFAULT_OPTIONS.askUserOnBlocked),

    maxCostUsd: num(o["maxCostUsd"], DEFAULT_OPTIONS.maxCostUsd, { min: 0 }),
    maxTokens: num(o["maxTokens"], DEFAULT_OPTIONS.maxTokens, { min: 0 }),

    persistState: bool(o["persistState"], DEFAULT_OPTIONS.persistState),
    stateFilePath: str(o["stateFilePath"], DEFAULT_OPTIONS.stateFilePath),
  }
}

/** Resolve the model reference for a task: task override, then role map, then default. */
export function resolveModelRef(options: PluginOptions, taskModel?: string, agent?: string): string {
  if (taskModel && taskModel.trim().length > 0) return taskModel.trim()
  if (agent && options.roleModels[agent]) return options.roleModels[agent]!
  return options.workerModel
}
