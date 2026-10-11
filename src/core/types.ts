/**
 * Core domain types. These are platform independent: they describe a task run
 * without referencing any OpenCode API surface.
 */

export type TaskStatus =
  | "pending"
  | "running"
  | "verifying"
  | "review"
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
  /** Named exclusive resources (beyond files), e.g. "db-migration". */
  locks?: string[]
  /** Higher runs first among ready tasks. Default 0. */
  priority?: number
  /** PRD user-story numbers this task covers (headings format). */
  stories?: number[]
  /** "yes" or "no (<reason>)" (headings format). */
  tdd?: string
  /** A visual subtask marker (headings format `[design]`). */
  design?: boolean
  /** Prose context carried into the worker prompt. */
  whatToBuild?: string
  /** Prose context carried into the worker prompt. */
  outOfScope?: string[]
  /** Spec sections this task must respect. */
  spec?: string
  /** Acceptance criteria checkboxes (headings format). */
  acceptance?: string[]
  /** Held back from running (e.g. an open decision marker). */
  held?: boolean
  holdReason?: string
  /** The raw source block for this task (used for hold detection and context). */
  raw?: string
  /** Verification command. `null` means the task has no gate. */
  verify: string | null
  /** Resolved dependency ids. */
  deps: string[]
  agent?: string
  model?: string
  /** Set on retry to try a fallback model instead of the declared one. */
  modelOverride?: string
  risk?: string
  timeoutMs?: number

  status: TaskStatus
  attempts: number
  /** In-place repair attempts after a failed gate. */
  repairs?: number
  sessionID?: string
  worktree?: string
  /** Branch checked out in the worktree, when known. */
  branch?: string
  /** True once the worktree's branch has been merged (or deliberately kept). */
  integrated?: boolean
  /** Captured gate output for `taskforce_logs`. */
  gateOutput?: string
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
  /** Frontmatter / metadata carried from the source. */
  meta?: Record<string, string>
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

/** A structured worker report parsed from the end of a worker's final message. */
export interface WorkerReport {
  status: "progress" | "blocked" | "done"
  evidence?: string
  blocker?: string
  files?: string[]
  note?: string
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
