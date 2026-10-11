import type {
  GateResult,
  GateSpec,
  HostPort,
  MergeResult,
  WorkerHandle,
  WorkerSpec,
  WorktreeRef,
} from "../src/ports.ts"

export interface FakeWorker {
  spec: WorkerSpec
  finished: boolean
  outcome: string
  resolve?: () => void
}

export class FakeHost implements HostPort {
  readonly kind = "v2" as const
  projectID = "proj"
  baseDirectory = "/repo"
  currentTime = 1_000_000

  readonly workers = new Map<string, FakeWorker>()
  worktrees: string[] = []
  readonly merged: Array<{ directory: string; into: string }> = []
  gateQueue: GateResult[] = []
  readonly gateCalls: GateSpec[] = []
  readonly steers: Array<{ sessionID: string; text: string }> = []
  readonly logs: Array<{ level: string; message: string }> = []
  readonly notes: string[] = []
  readonly agentInstalls: string[] = []
  readonly commits: Array<{ directory: string; message: string }> = []
  /** Usage returned by readWorkerStats. */
  stats: { cost: number; tokens: number } = { cost: 0, tokens: 0 }
  /** Files returned by changedFiles (for the diff-scope check). */
  changed: string[] = []
  /** Diff returned by worktreeDiff. */
  diff = "diff --git a/x b/x"
  readonly titles: Array<{ sessionID: string; title: string }> = []
  failWorktree = false
  commitOk = true

  private seq = 0
  private readonly values = new Map<string, unknown>()

  readonly storage = {
    get: async (key: string): Promise<unknown> => clone(this.values.get(key)),
    set: async (key: string, value: unknown): Promise<void> => {
      this.values.set(key, clone(value))
    },
    remove: async (key: string): Promise<void> => {
      this.values.delete(key)
    },
  }

  async ensureWorkerAgent(agent: string): Promise<void> {
    this.agentInstalls.push(agent)
  }

  async createWorktree(name: string): Promise<WorktreeRef> {
    if (this.failWorktree) throw new Error("not a git repository")
    const directory = `${this.baseDirectory}/../wt-${name}`
    this.worktrees.push(directory)
    return { directory, branch: `branch-${name}` }
  }

  async removeWorktree(directory: string): Promise<void> {
    this.worktrees = this.worktrees.filter((d) => d !== directory)
  }

  async mergeWorktree(directory: string, into: string): Promise<MergeResult> {
    this.merged.push({ directory, into })
    return { ok: true, output: "" }
  }

  async spawnWorker(spec: WorkerSpec): Promise<WorkerHandle> {
    const sessionID = `ses_${++this.seq}`
    this.workers.set(sessionID, { spec, finished: false, outcome: "" })
    return { sessionID }
  }

  async waitWorker(sessionID: string): Promise<void> {
    const worker = this.workers.get(sessionID)
    if (!worker || worker.finished) return
    await new Promise<void>((resolve) => {
      worker.resolve = resolve
    })
  }

  async readWorkerOutcome(sessionID: string): Promise<string> {
    return this.workers.get(sessionID)?.outcome ?? ""
  }

  async readWorkerStats(): Promise<{ cost: number; tokens: number }> {
    return { cost: this.stats.cost, tokens: this.stats.tokens }
  }

  async changedFiles(): Promise<string[]> {
    return [...this.changed]
  }

  async worktreeDiff(): Promise<string> {
    return this.diff
  }

  async setSessionTitle(sessionID: string, title: string): Promise<void> {
    this.titles.push({ sessionID, title })
  }

  /** In-memory text files backing readText/writeText/appendText. */
  readonly files = new Map<string, string>()
  readonly appends: Array<{ path: string; content: string }> = []

  async readText(path: string): Promise<string | undefined> {
    return this.files.get(path)
  }

  async writeText(path: string, content: string): Promise<void> {
    this.files.set(path, content)
  }

  async appendText(path: string, content: string): Promise<void> {
    this.files.set(path, (this.files.get(path) ?? "") + content)
    this.appends.push({ path, content })
  }

  async commitWorktree(directory: string, message: string): Promise<MergeResult> {
    this.commits.push({ directory, message })
    return this.commitOk ? { ok: true, output: "" } : { ok: false, output: "commit failed" }
  }

  async sendWorkerMessage(sessionID: string, text: string): Promise<void> {
    this.steers.push({ sessionID, text })
    // Steering a finished worker resumes it; an in-flight waiter is left alone.
    const worker = this.workers.get(sessionID)
    if (worker && worker.finished) {
      worker.finished = false
    }
  }

  async disposeWorker(sessionID: string): Promise<void> {
    const worker = this.workers.get(sessionID)
    if (worker) {
      worker.finished = true
      const resolve = worker.resolve
      worker.resolve = undefined
      resolve?.()
    }
    this.workers.delete(sessionID)
  }

  async runGate(spec: GateSpec): Promise<GateResult> {
    this.gateCalls.push(spec)
    const next = this.gateQueue.shift()
    return next ?? { ok: true, output: "ok", exitCode: 0, timedOut: false }
  }

  async log(level: string, message: string): Promise<void> {
    this.logs.push({ level, message })
  }

  async notify(message: string): Promise<void> {
    this.notes.push(message)
  }

  now(): number {
    return this.currentTime
  }

  /** Complete a worker session with its final assistant text. */
  finish(sessionID: string, outcome: string): void {
    const worker = this.workers.get(sessionID)
    if (!worker) return
    worker.finished = true
    worker.outcome = outcome
    const resolve = worker.resolve
    worker.resolve = undefined
    resolve?.()
  }

  /** Complete the worker that owns a task id. */
  finishTask(taskID: string, outcome: string): void {
    for (const [sessionID, worker] of this.workers) {
      if (worker.spec.taskID === taskID && !worker.finished) {
        this.finish(sessionID, outcome)
        return
      }
    }
  }

  sessionForTask(taskID: string): string | undefined {
    for (const [sessionID, worker] of this.workers) {
      if (worker.spec.taskID === taskID) return sessionID
    }
    return undefined
  }

  specForTask(taskID: string): WorkerSpec | undefined {
    for (const worker of this.workers.values()) {
      if (worker.spec.taskID === taskID) return worker.spec
    }
    return undefined
  }

  runningTaskIDs(): string[] {
    return [...this.workers.values()].filter((w) => !w.finished).map((w) => w.spec.taskID)
  }
}

export async function until(predicate: () => boolean, timeoutMs = 3000, label = "condition"): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

/** Deep clone like real JSON-backed storage (Schema.Json round-trips values). */
function clone<T>(value: T): T {
  if (value === undefined) return value
  return JSON.parse(JSON.stringify(value)) as T
}
