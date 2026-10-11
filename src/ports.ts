/**
 * The platform abstraction the orchestrator engine talks to. Adapters implement
 * it; the core never imports a host SDK.
 */

export interface WorktreeRef {
  directory: string
  /** Branch checked out in the worktree, when the adapter can determine it. */
  branch?: string
}
export interface PermissionRule {
  action: string
  resource: string
  effect: "allow" | "deny" | "ask"
}

export interface WorkerSpec {
  taskID: string
  title: string
  prompt: string
  /** Orchestrator session id; the worker becomes its child. */
  parentSessionID?: string
  /** Directory the worker session runs in (its worktree, or the project dir). */
  directory: string
  /** True when `directory` differs from the project directory. */
  isolated: boolean
  agent?: string
  model?: { providerID: string; modelID: string; variant?: string }
  /** Session permission ruleset used to hard-enforce the write scope. */
  permissions?: PermissionRule[]
}

export interface WorkerHandle {
  sessionID: string
}

export interface GateSpec {
  command: string
  directory: string
  timeoutMs: number
}

export interface GateResult {
  ok: boolean
  output: string
  exitCode: number | null
  timedOut: boolean
}

export interface MergeResult {
  ok: boolean
  output: string
}

export interface HostStorage {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
  remove(key: string): Promise<void>
}

export type LogLevel = "debug" | "info" | "warn" | "error"

export interface HostPort {
  readonly kind: "v2"
  readonly projectID: string
  /** Canonical project directory (the base checkout). */
  readonly baseDirectory: string

  /** Write the worker agent markdown if it is missing. Best-effort. */
  ensureWorkerAgent(agent: string): Promise<void>

  /** Create an isolated git worktree. Rejects when the project is not a repo. */
  createWorktree(name: string): Promise<WorktreeRef>
  /** Remove a worktree. */
  removeWorktree(directory: string, force: boolean): Promise<void>
  /** Merge a worker worktree's branch into the base checkout. */
  mergeWorktree(directory: string, into: string): Promise<MergeResult>
  /** Commit pending changes in a worktree so its branch can be merged. */
  commitWorktree(directory: string, message: string): Promise<MergeResult>
  /** Files changed (staged, unstaged, untracked) in a directory. */
  changedFiles(directory: string): Promise<string[]>
  /** Unified diff of a worktree's changes (tracked + a list of untracked files). */
  worktreeDiff(directory: string): Promise<string>
  /** Set a session title (cosmetic status mirroring). */
  setSessionTitle(sessionID: string, title: string): Promise<void>

  /** Create and prompt a worker session. */
  spawnWorker(spec: WorkerSpec): Promise<WorkerHandle>
  /** Wait until the worker session is idle (or errors). */
  waitWorker(sessionID: string): Promise<void>
  /** Read the worker's final assistant text. */
  readWorkerOutcome(sessionID: string): Promise<string>
  /** Read the worker's accumulated usage. */
  readWorkerStats(sessionID: string): Promise<{ cost: number; tokens: number }>
  /** Steer a running worker (mailbox, orchestrator -> worker). */
  sendWorkerMessage(sessionID: string, text: string): Promise<void>
  /** Stop a worker and delete its session. */
  disposeWorker(sessionID: string): Promise<void>

  /** Run a verification command in a directory. */
  runGate(spec: GateSpec): Promise<GateResult>

  storage: HostStorage
  log(level: LogLevel, message: string, extra?: Record<string, unknown>): Promise<void>
  notify(message: string): Promise<void>
  now(): number
}
