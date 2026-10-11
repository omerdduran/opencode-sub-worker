/**
 * Core domain types. These are platform independent: they describe a task run
 * without referencing any OpenCode API surface.
 */

export type TaskStatus =
  | "pending"
  | "running"
  | "verifying"
  | "done"
  | "failed"
  | "blocked"
  | "skipped"

export type RunStatus =
  | "planning"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "aborted"

export interface Task {
  id: string
  /** 1-based position in the source checklist. */
  index: number
  title: string
  /** True when the source item was already checked (`- [x]`). */
  checkedInSource: boolean
  /** Declared write set. Empty means "unknown" and therefore never parallel. */
  files: string[]
  /** Verification command. `null` means the task has no gate. */
  verify: string | null
  /** Resolved dependency ids. */
  deps: string[]
  agent?: string
  model?: string
  risk?: string
  timeoutMs?: number

  status: TaskStatus
  attempts: number
  sessionID?: string
  worktree?: string
  /** Accumulated worker usage. */
  cost?: number
  tokens?: number
  /** Files the worker touched that were outside its declared scope. */
  scopeViolations?: string[]
  /**
   * True when the worker session ran in a distinct location (its own worktree)
   * and therefore may not see tools registered for the orchestrator location.
   * Such workers are told to fall back to end-of-message markers.
   */
  isolated?: boolean
  lastError?: string
  evidence?: string
  /** Messages the orchestrator queued for this worker (mailbox, down). */
  outbox?: MailboxMessage[]
  /** Reports the worker sent up (mailbox, up). */
  reports?: MailboxMessage[]
  startedAt?: number
  endedAt?: number
}

export interface MailboxMessage {
  from: "orchestrator" | "worker"
  taskID: string
  /** Free-form message body. */
  text: string
  /** Optional structured status from a worker report. */
  status?: "progress" | "blocked" | "done"
  time: number
}

export interface RunHistoryEntry {
  type: string
  detail: string
  time: number
}

export interface RunState {
  id: string
  /** The orchestrator (parent) session id. */
  sessionID: string
  /** Raw markdown the run was created from. */
  source: string
  /** Human label for the source (file path or "inline"). */
  sourceLabel: string
  projectDir: string
  tasks: Task[]
  status: RunStatus
  maxConcurrency: number
  autoMerge: boolean
  /** Accumulated usage across the run, for the budget guard and status. */
  cost: number
  tokens: number
  maxCostUsd: number
  maxTokens: number
  startedAt: number
  updatedAt: number
  stopReason: string
  history: RunHistoryEntry[]
}

/** Result of parsing a markdown checklist. */
export interface ParseResult {
  tasks: Task[]
  errors: string[]
}

/** A single preview wave produced by the dry-run planner. */
export interface Wave {
  index: number
  taskIDs: string[]
}

/** Graph description of a parsed task set. */
export interface Graph {
  byId: Map<string, Task>
  /** Pairwise conflicts (share a file, or either side declares no files). */
  conflicts: Array<[string, string]>
}

export interface SchedulePreview {
  waves: Wave[]
  conflicts: Array<[string, string]>
  /** Dependency cycles, if any. */
  cycle: string[]
}
