/**
 * The orchestrator engine.
 *
 * Deterministic, host-independent scheduling: it parses a checklist, builds a
 * dependency/conflict graph, launches isolated worker sessions for ready tasks,
 * waits for them, enforces the declared write scope, gates each result (with an
 * in-place repair loop and an optional independent verifier), optionally holds
 * risky tasks for approval, merges the worker's branch, and advances. All host
 * interaction goes through `HostPort`.
 */

import { parseChecklist } from "./parser.ts"
import { parseHeadings } from "./parse-headings.ts"
import { findCycle, previewWaves, type ConflictPredicate } from "./graph.ts"
import { activeCount, hasPending, isSettled, nextBatch, propagateSkips } from "./scheduler.ts"
import {
  buildRepairPrompt,
  buildVerifierPrompt,
  buildWorkerPrompt,
  control,
  parseWorkerReport,
  summarize,
} from "./prompt.ts"
import { makeRun, RunStore } from "./state.ts"
import { matchesAny } from "./glob.ts"
import { CoChangeStore } from "./cochange.ts"
import { resolveModelRef, type PluginOptions } from "./options.ts"
import type { MailboxMessage, ParseResult, RunState, Task } from "./types.ts"
import { CONTROL_MARKER } from "./constants.ts"
import type { HostPort, PermissionRule, WorkerSpec } from "../ports.ts"

export interface ReportInput {
  status?: "progress" | "blocked" | "done"
  note?: string
  evidence?: string
}

export interface EngineEvent {
  type: string
  runID?: string
  taskID?: string
  detail?: string
}

interface WaitOutcome {
  taskID: string
  timedOut: boolean
}

export class Engine {
  readonly store = new RunStore()
  readonly cochange: CoChangeStore
  private readonly options: PluginOptions
  private readonly port: HostPort
  private readonly onEvent?: (event: EngineEvent) => void
  private readonly activeLoops = new Set<string>()
  /** In-flight completion waiters, keyed by `${runId}:${taskId}`. */
  private readonly waits = new Map<string, Promise<WaitOutcome>>()

  constructor(options: PluginOptions, port: HostPort, onEvent?: (event: EngineEvent) => void) {
    this.options = options
    this.port = port
    this.onEvent = onEvent
    this.cochange = new CoChangeStore(options.coChangeMinCount)
  }

  private now(): number {
    return this.port.now()
  }

  get baseDirectory(): string {
    return this.port.baseDirectory
  }

  get projectID(): string {
    return this.port.projectID
  }

  private byId(run: RunState): Map<string, Task> {
    return new Map(run.tasks.map((t) => [t.id, t] as const))
  }

  private wkey(run: RunState, task: Task): string {
    return `${run.id}:${task.id}`
  }

  /**
   * Parse a task list with the configured adapter, then apply the cross-cutting
   * rules: `sequentialDeps` turns file order into the dependency chain and
   * `holdPattern` holds a task that carries an open decision marker.
   */
  private prepare(source: string): ParseResult & { meta?: Record<string, string> } {
    let result: ParseResult & { meta?: Record<string, string> }
    if (this.options.customParser) {
      result = this.options.customParser(source)
    } else if (this.options.taskFormat === "headings") {
      result = parseHeadings(source, this.options.fields)
    } else {
      result = parseChecklist(source)
    }

    if (this.options.sequentialDeps) {
      let previous: string | undefined
      for (const t of result.tasks) {
        if (t.deps.length === 0 && previous !== undefined) t.deps = [previous]
        previous = t.id
      }
    }

    if (this.options.holdPattern.length > 0) {
      const patterns: RegExp[] = []
      for (const p of this.options.holdPattern) {
        try {
          patterns.push(new RegExp(p, "i"))
        } catch {
          // ignore an invalid pattern
        }
      }
      for (const t of result.tasks) {
        const body = t.raw ?? `${t.title} ${t.whatToBuild ?? ""}`
        const hit = patterns.find((re) => re.test(body))
        if (hit) {
          t.held = true
          t.holdReason = `matched /${hit.source}/`
        }
      }
    }

    return result
  }

  private emit(event: EngineEvent): void {
    try {
      this.onEvent?.(event)
    } catch {
      // observers must never break the loop
    }
  }

  private conflictExtra(): ConflictPredicate | undefined {
    if (!this.options.coChangeLearning) return undefined
    return (a, b) => this.cochange.conflicts(a.files, b.files)
  }

  private approvalRequired(task: Task): boolean {
    if (this.options.approvalRisks.length === 0) return false
    if (!task.risk) return false
    const risk = task.risk.toLowerCase()
    return this.options.approvalRisks.some((r) => r.toLowerCase() === risk)
  }

  // ---- planning ---------------------------------------------------------

  planText(source: string, label: string): string {
    const { tasks, errors } = this.prepare(source)
    const preview = previewWaves(tasks, this.conflictExtra())
    const lines: string[] = [`Tasks (${tasks.length}) from ${label}:`]
    for (const t of tasks) {
      const bits: string[] = []
      if (t.files.length > 0) bits.push(`files: ${t.files.join(", ")}`)
      if (t.locks && t.locks.length > 0) bits.push(`locks: ${t.locks.join(", ")}`)
      if (t.verify) bits.push(`verify: ${t.verify}`)
      if (t.deps.length > 0) bits.push(`deps: ${t.deps.join(", ")}`)
      if (t.agent) bits.push(`agent: ${t.agent}`)
      if (t.model) bits.push(`model: ${t.model}`)
      if (t.priority) bits.push(`priority: ${t.priority}`)
      if (t.risk) bits.push(`risk: ${t.risk}`)
      if (t.held) bits.push(`HELD ${t.holdReason ?? ""}`.trim())
      if (t.design) bits.push("design")
      lines.push(
        `  ${t.index}. [${t.checkedInSource ? "x" : " "}] ${t.title}${bits.length > 0 ? ` — ${bits.join(" | ")}` : ""}`,
      )
    }
    lines.push("")
    lines.push(
      `Planned waves (${preview.waves.length}), bounded at runtime by maxConcurrency=${this.options.maxConcurrency}:`,
    )
    for (const w of preview.waves) lines.push(`  wave ${w.index}: ${w.taskIDs.join(", ")}`)

    const declared = new Map(tasks.map((t) => [t.id, t] as const))
    const pairs = preview.conflicts.filter(([a, b]) => {
      const ta = declared.get(a)
      const tb = declared.get(b)
      return ta !== undefined && tb !== undefined && ta.files.length > 0 && tb.files.length > 0
    })
    if (pairs.length > 0) {
      lines.push("")
      lines.push(`Serialized pairs: ${pairs.map(([a, b]) => `${a}~${b}`).join(", ")}`)
    }
    const noFiles = tasks.filter((t) => t.files.length === 0 && !t.checkedInSource)
    if (noFiles.length > 0) {
      lines.push("")
      lines.push(`Tasks with no declared file set are serialized: ${noFiles.map((t) => t.id).join(", ")}`)
    }
    if (preview.cycle.length > 0) {
      lines.push("")
      lines.push(`Dependency cycle detected (run refused): ${preview.cycle.join(" -> ")}`)
    }
    if (errors.length > 0) {
      lines.push("")
      lines.push("Warnings:")
      for (const e of errors) lines.push(`  - ${e}`)
    }
    return lines.join("\n")
  }

  // ---- lifecycle --------------------------------------------------------

  async start(sessionID: string, source: string, label: string): Promise<RunState> {
    const parsed = this.prepare(source)
    const { tasks } = parsed
    const cycle = findCycle(tasks)
    if (cycle.length > 0) {
      throw new Error(`dependency cycle detected, refusing to run: ${cycle.join(" -> ")}`)
    }
    for (const t of tasks) {
      if (t.checkedInSource) {
        t.status = "skipped"
        t.evidence = "already checked in source"
      }
    }
    const run = makeRun(
      sessionID,
      source,
      label,
      this.port.baseDirectory,
      tasks,
      this.options.maxConcurrency,
      this.options.autoMerge,
      this.now(),
      { maxCostUsd: this.options.maxCostUsd, maxTokens: this.options.maxTokens },
    )
    if (parsed.meta && Object.keys(parsed.meta).length > 0) run.meta = parsed.meta
    this.store.add(run)
    this.store.history(run, "started", `${tasks.length} task(s) from ${label}`, this.now())
    await this.persist()
    this.emit({ type: "run.started", runID: run.id, detail: label })
    await this.mirrorTitle(run)
    this.launchLoop(run)
    return run
  }

  /** Add tasks to the active run (from another checklist). */
  async add(sessionID: string, source: string, label: string): Promise<RunState | undefined> {
    const run = this.store.active(sessionID)
    if (!run) return undefined
    const { tasks } = this.prepare(source)
    const existing = this.byId(run)
    for (const t of tasks) {
      if (existing.has(t.id)) {
        const suffix = `+${run.tasks.length + 1}`
        t.id = `${t.id}${suffix}`
      }
      if (t.checkedInSource) {
        t.status = "skipped"
        t.evidence = "already checked in source"
      }
      run.tasks.push(t)
    }
    this.store.history(run, "added", `${tasks.length} task(s) from ${label}`, this.now())
    if (run.status !== "running") this.store.setStatus(run, "running", "", this.now())
    await this.persist()
    this.emit({ type: "run.added", runID: run.id, detail: label })
    this.launchLoop(run)
    return run
  }

  async resume(sessionID: string): Promise<RunState | undefined> {
    const run = this.store.active(sessionID)
    if (!run) return undefined
    if (run.status === "completed" || run.status === "aborted") return run
    this.clearWaits(run)
    for (const t of run.tasks) {
      // Dispose any session kept alive (blocked-for-answer) or left over from a crash.
      if (t.sessionID) {
        await this.safeDispose(t.sessionID)
        t.sessionID = undefined
      }
      if (t.integrated || t.status === "done") {
        t.status = "done"
        continue
      }
      if (t.status === "running" || t.status === "verifying" || t.status === "review") {
        t.status = "pending"
      }
      if (t.status === "failed" || t.status === "blocked") {
        t.status = "pending"
        t.lastError = undefined
        t.attempts = 0
      }
      if (t.status === "skipped" && t.lastError === "dependency failed or was skipped") {
        t.status = "pending"
        t.lastError = undefined
      }
    }
    this.store.setStatus(run, "running", "", this.now())
    await this.persist()
    await this.mirrorTitle(run)
    this.launchLoop(run)
    return run
  }

  async abort(sessionID: string): Promise<RunState | undefined> {
    const run = this.store.active(sessionID)
    if (!run) return undefined
    this.clearWaits(run)
    for (const t of run.tasks) {
      if (t.sessionID) {
        await this.safeDispose(t.sessionID)
        t.sessionID = undefined
      }
      if (t.status === "running" || t.status === "verifying" || t.status === "review") {
        t.status = "pending"
      }
    }
    this.store.setStatus(run, "aborted", "user aborted", this.now())
    await this.persist()
    await this.mirrorTitle(run)
    return run
  }

  /** Answer a blocked worker and let it continue (human-in-the-loop). */
  async answer(sessionID: string, taskID: string, text: string): Promise<boolean> {
    const run = this.store.active(sessionID)
    if (!run) return false
    const task = this.byId(run).get(taskID)
    if (!task || !task.sessionID) return false
    const msg: MailboxMessage = { from: "orchestrator", taskID, text, time: this.now() }
    task.outbox = [...(task.outbox ?? []), msg]
    try {
      await this.port.sendWorkerMessage(task.sessionID, `${CONTROL_MARKER} orchestrator: ${text}`)
    } catch (err) {
      await this.port.log("warn", "answer steer failed", { task: taskID, error: String(err) })
    }
    task.status = "running"
    task.startedAt = this.now()
    task.lastError = undefined
    this.setWaiter(run, task)
    this.store.setStatus(run, "running", "", this.now())
    this.store.history(run, "answered", `${taskID}: ${summarize(text, 120)}`, this.now())
    await this.persist()
    this.launchLoop(run)
    return true
  }

  /** Approve a task held at the approval gate and integrate it. */
  async approve(sessionID: string, taskID: string): Promise<boolean> {
    const run = this.store.active(sessionID)
    if (!run) return false
    const task = this.byId(run).get(taskID)
    if (!task || task.status !== "review") return false
    task.status = "done"
    task.endedAt = this.now()
    this.store.history(run, "approved", taskID, this.now())
    await this.integrate(run, task)
    this.store.setStatus(run, "running", "", this.now())
    await this.persist()
    this.emit({ type: "task.approved", runID: run.id, taskID })
    this.launchLoop(run)
    return true
  }

  async reject(sessionID: string, taskID: string, reason: string): Promise<boolean> {
    const run = this.store.active(sessionID)
    if (!run) return false
    const task = this.byId(run).get(taskID)
    if (!task || task.status !== "review") return false
    task.status = "blocked"
    task.lastError = `rejected: ${reason}`
    task.endedAt = this.now()
    this.store.history(run, "rejected", `${taskID}: ${summarize(reason, 160)}`, this.now())
    this.store.setStatus(run, "running", "", this.now())
    await this.persist()
    this.emit({ type: "task.rejected", runID: run.id, taskID, detail: reason })
    this.launchLoop(run)
    return true
  }

  /** Send a message to every running worker. Returns how many were reached. */
  async broadcast(sessionID: string, text: string): Promise<number> {
    const run = this.store.active(sessionID)
    if (!run) return 0
    let count = 0
    for (const t of run.tasks) {
      if (t.status === "running" && t.sessionID) {
        try {
          await this.port.sendWorkerMessage(t.sessionID, `${CONTROL_MARKER} orchestrator: ${text}`)
          count += 1
        } catch (err) {
          await this.port.log("warn", "broadcast failed", { task: t.id, error: String(err) })
        }
      }
    }
    if (count > 0) this.store.history(run, "broadcast", summarize(text, 120), this.now())
    await this.persist()
    return count
  }

  // ---- the loop ---------------------------------------------------------

  private clearWaits(run: RunState): void {
    const prefix = `${run.id}:`
    for (const key of [...this.waits.keys()]) {
      if (key.startsWith(prefix)) this.waits.delete(key)
    }
  }

  private setWaiter(run: RunState, task: Task): void {
    if (!task.sessionID) return
    const limit = task.timeoutMs ?? this.options.taskTimeoutMs
    const sessionID = task.sessionID
    const promise = new Promise<WaitOutcome>((resolve) => {
      let done = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const finish = (timedOut: boolean): void => {
        if (done) return
        done = true
        if (timer !== undefined) clearTimeout(timer)
        resolve({ taskID: task.id, timedOut })
      }
      timer = setTimeout(() => finish(true), limit)
      const unrefable = timer as unknown as { unref?: () => void }
      if (typeof unrefable.unref === "function") unrefable.unref()
      this.port
        .waitWorker(sessionID)
        .then(() => finish(false))
        .catch(() => finish(false))
    })
    this.waits.set(this.wkey(run, task), promise)
  }

  private launchLoop(run: RunState): void {
    if (this.activeLoops.has(run.id)) return
    this.activeLoops.add(run.id)
    void this.runLoop(run)
      .catch(async (err) => {
        await this.port.log("error", "run loop failed", { error: String(err) })
        this.store.setStatus(run, "paused", `internal error: ${String(err)}`, this.now())
        await this.persist()
      })
      .finally(() => this.activeLoops.delete(run.id))
  }

  private budgetExceeded(run: RunState): string {
    if (run.maxCostUsd > 0 && run.cost >= run.maxCostUsd) {
      return `cost budget exceeded ($${run.cost.toFixed(4)} >= $${run.maxCostUsd})`
    }
    if (run.maxTokens > 0 && run.tokens >= run.maxTokens) {
      return `token budget exceeded (${run.tokens} >= ${run.maxTokens})`
    }
    return ""
  }

  private async runLoop(run: RunState): Promise<void> {
    while (run.status === "running") {
      const budget = this.budgetExceeded(run)
      if (budget.length > 0) {
        this.store.setStatus(run, "paused", budget, this.now())
        await this.port.notify(`Sub-worker paused: ${budget}`)
        await this.persist()
        break
      }

      const skipped = propagateSkips(run.tasks)
      if (skipped.length > 0) this.store.history(run, "skipped", skipped.join(", "), this.now())

      const batch = nextBatch(run.tasks, run.maxConcurrency, this.conflictExtra())
      for (const id of batch) await this.launch(run, id)
      await this.persist()

      // A launch may have terminally failed the run (e.g. worktree unavailable).
      if (run.status !== "running") break

      if (activeCount(run.tasks) === 0) {
        if (hasPending(run.tasks)) {
          const settled = new Set(run.tasks.filter((t) => isSettled(t.status)).map((t) => t.id))
          const held = run.tasks.filter(
            (t) => t.status === "pending" && t.held && t.deps.every((d) => settled.has(d)),
          )
          const reason =
            held.length > 0
              ? `held: ${held.map((t) => `${t.id} (${t.holdReason ?? "decision needed"})`).join(", ")}`
              : "no runnable tasks (dependency deadlock)"
          this.store.setStatus(run, "paused", reason, this.now())
          await this.port.notify(`Sub-worker run paused: ${reason}`)
        } else {
          const bad = run.tasks.filter((t) => t.status === "failed" || t.status === "blocked")
          if (bad.length > 0) this.store.setStatus(run, "failed", `${bad.length} task(s) not completed`, this.now())
          else this.store.setStatus(run, "completed", "all tasks done", this.now())
          await this.port.notify(`Sub-worker run ${run.status}.`)
          this.emit({ type: `run.${run.status}`, runID: run.id })
        }
        await this.mirrorTitle(run)
        await this.persist()
        break
      }

      const entries = this.waitersFor(run)
      if (entries.length === 0) {
        this.store.setStatus(run, "paused", "no active waiters", this.now())
        await this.persist()
        break
      }
      const outcome = await Promise.race(entries.map(([, p]) => p))
      this.waits.delete(this.wkey(run, { id: outcome.taskID } as Task))
      await this.processFinished(run, outcome.taskID, outcome.timedOut)
      await this.mirrorTitle(run)
      await this.persist()
    }

    const skipped = propagateSkips(run.tasks)
    if (skipped.length > 0) this.store.history(run, "skipped", skipped.join(", "), this.now())
    await this.persist()
  }

  private waitersFor(run: RunState): Array<[string, Promise<WaitOutcome>]> {
    const prefix = `${run.id}:`
    return [...this.waits.entries()].filter(([key]) => key.startsWith(prefix))
  }

  private buildPermissions(task: Task): PermissionRule[] | undefined {
    if (!this.options.enforceWriteScope || task.files.length === 0) return undefined
    const rules: PermissionRule[] = [{ action: "edit", resource: "*", effect: "deny" }]
    for (const f of task.files) rules.push({ action: "edit", resource: f, effect: "allow" })
    return rules
  }

  private async launch(run: RunState, id: string): Promise<void> {
    const task = this.byId(run).get(id)
    if (!task) return
    if (task.integrated) {
      task.status = "done"
      return
    }

    let directory = this.port.baseDirectory
    let isolated = false
    let worktree = task.worktree
    if (this.options.useWorktrees && !worktree) {
      try {
        const wt = await this.port.createWorktree(`t-${task.id}`)
        worktree = wt.directory
        if (wt.branch) task.branch = wt.branch
      } catch (err) {
        worktree = undefined
        if (this.options.requireWorktrees) {
          await this.handleFailure(run, task, `worktree required but unavailable: ${String(err)}`)
          return
        }
        await this.port.log("warn", "worktree creation failed; running in place", {
          task: task.id,
          error: String(err),
        })
      }
    }
    if (worktree) {
      directory = worktree
      isolated = true
    }
    task.worktree = worktree

    const spec: WorkerSpec = {
      taskID: task.id,
      title: task.title,
      prompt: buildWorkerPrompt(task, {
        projectDir: this.port.baseDirectory,
        ...(task.lastError !== undefined ? { previousError: task.lastError } : {}),
        ...(this.options.workerInstructions.trim().length > 0
          ? { instructions: this.options.workerInstructions }
          : {}),
        ...(this.options.workerSkills.length > 0 ? { skills: this.options.workerSkills } : {}),
        contract: this.options.workerContract,
      }),
      directory,
      isolated,
      parentSessionID: run.sessionID,
    }
    const agent = task.agent ?? this.options.workerAgent
    if (agent.length > 0) spec.agent = agent
    const modelRef = task.modelOverride ?? resolveModelRef(this.options, task.model, task.agent)
    const model = parseModelRef(modelRef)
    if (model) spec.model = model
    const permissions = this.buildPermissions(task)
    if (permissions) spec.permissions = permissions

    task.worktree = worktree
    try {
      const handle = await this.port.spawnWorker(spec)
      task.sessionID = handle.sessionID
      task.status = "running"
      task.isolated = isolated
      task.startedAt = this.now()
      task.lastError = undefined
      this.store.history(
        run,
        "launch",
        `${task.id}${isolated ? ` (worktree ${directory})` : ""}`,
        this.now(),
      )
      this.emit({ type: "task.launched", runID: run.id, taskID: task.id })
      this.setWaiter(run, task)
    } catch (err) {
      await this.handleFailure(run, task, `failed to spawn worker: ${String(err)}`)
    }
  }

  private async processFinished(run: RunState, taskID: string, timedOut: boolean): Promise<void> {
    const task = this.byId(run).get(taskID)
    if (!task || !task.sessionID) return
    const sessionID = task.sessionID

    if (timedOut) {
      await this.safeDispose(sessionID)
      task.sessionID = undefined
      await this.handleFailure(run, task, "worker timed out")
      return
    }

    let text = ""
    try {
      text = await this.port.readWorkerOutcome(sessionID)
    } catch (err) {
      await this.port.log("warn", "could not read worker outcome", { task: task.id, error: String(err) })
    }
    try {
      const stats = await this.port.readWorkerStats(sessionID)
      run.cost += stats.cost
      run.tokens += stats.tokens
      task.cost = (task.cost ?? 0) + stats.cost
      task.tokens = (task.tokens ?? 0) + stats.tokens
    } catch {
      // usage is best-effort
    }

    const report = parseWorkerReport(text)
    const toolReport =
      task.reports !== undefined && task.reports.length > 0 ? task.reports[task.reports.length - 1] : undefined

    if (report.status === "blocked" || toolReport?.status === "blocked") {
      const reason = report.blocker || toolReport?.text || "worker reported blocked"
      if (this.options.askUserOnBlocked) {
        await this.terminalTask(run, task, "blocked", reason, true)
      } else {
        await this.safeDispose(sessionID)
        task.sessionID = undefined
        await this.terminalTask(run, task, "blocked", reason, false)
      }
      return
    }

    // Completion detection: in `checkboxes` mode the worker is expected to have
    // flipped the task's checkbox in the source list (a do-work style flow).
    if (this.options.detectCompletion === "checkboxes") {
      const checked = await this.isCheckedOff(run, task)
      if (checked === false) {
        await this.safeDispose(sessionID)
        task.sessionID = undefined
        await this.handleFailure(run, task, `task ${task.id} was not checked off in ${run.sourceLabel}`)
        return
      }
      if (checked === undefined) {
        await this.port.log("warn", "could not read the source list for checkbox detection", {
          source: run.sourceLabel,
        })
      }
    }

    // Collect the changed files once: used for the diff-scope check and learning.
    let changed: string[] = []
    if (task.worktree) changed = await this.changedFiles(task.worktree)

    if (this.options.enforceDiffScope && task.files.length > 0 && task.worktree) {
      const violations = changed.filter((f) => !matchesAny(task.files, f))
      if (violations.length > 0) {
        task.scopeViolations = violations
        await this.safeDispose(sessionID)
        task.sessionID = undefined
        await this.handleFailure(run, task, `write scope violation: ${violations.join(", ")}`)
        return
      }
    }

    if (task.verify) {
      task.status = "verifying"
      await this.port.log("info", "running gate", { task: task.id, command: task.verify })
      const gate = await this.port.runGate({
        command: task.verify,
        directory: task.worktree ?? this.port.baseDirectory,
        timeoutMs: this.options.verifyTimeoutMs,
      })
      task.gateOutput = gate.output
      if (!gate.ok) {
        const why = gate.timedOut
          ? `gate timed out: ${summarize(gate.output, 300)}`
          : `gate failed (exit ${gate.exitCode ?? "?"}): ${summarize(gate.output, 300)}`
        if (this.options.repairOnFailure && task.sessionID && (task.repairs ?? 0) < this.options.maxAttempts) {
          await this.repair(run, task, gate.output || why)
          return
        }
        await this.safeDispose(sessionID)
        task.sessionID = undefined
        await this.handleFailure(run, task, why)
        return
      }
    }

    if (this.options.verifierEnabled) {
      const verdict = await this.runVerifier(run, task)
      if (!verdict.ok) {
        if (this.options.repairOnFailure && task.sessionID && (task.repairs ?? 0) < this.options.maxAttempts) {
          await this.repair(run, task, verdict.reason)
          return
        }
        await this.safeDispose(sessionID)
        task.sessionID = undefined
        await this.handleFailure(run, task, `verifier rejected: ${summarize(verdict.reason, 300)}`)
        return
      }
    }

    await this.safeDispose(sessionID)
    task.sessionID = undefined
    task.evidence = report.evidence || report.note || toolReport?.text || (task.verify ? "gate passed" : "completed")
    if (this.options.coChangeLearning && changed.length > 0) this.cochange.record(changed)

    if (this.approvalRequired(task)) {
      task.status = "review"
      this.store.history(run, "review", `${task.id} awaiting approval (risk ${task.risk})`, this.now())
      this.store.setStatus(run, "paused", `awaiting approval for ${task.id}`, this.now())
      this.emit({ type: "task.review", runID: run.id, taskID: task.id })
      await this.port.notify(
        `Sub-worker awaiting approval for ${task.id} (risk: ${task.risk ?? "?"}) — /tasks approve ${task.id} or /tasks reject ${task.id} <reason>`,
      )
      return
    }

    task.status = "done"
    task.endedAt = this.now()
    this.store.history(run, "done", `${task.id}: ${summarize(task.evidence, 160)}`, this.now())
    this.emit({ type: "task.done", runID: run.id, taskID: task.id })
    if (this.options.flipCheckboxes) await this.flipSourceCheckbox(run, task)
    if (this.options.progressFile.length > 0) await this.appendProgress(run, task)
    await this.integrate(run, task)
  }

  private async repair(run: RunState, task: Task, failure: string): Promise<void> {
    if (!task.sessionID) return
    task.repairs = (task.repairs ?? 0) + 1
    task.gateOutput = failure
    try {
      await this.port.sendWorkerMessage(task.sessionID, buildRepairPrompt(task, failure))
    } catch (err) {
      await this.port.log("warn", "repair steer failed", { task: task.id, error: String(err) })
    }
    task.status = "running"
    task.startedAt = this.now()
    this.store.history(run, "repair", `${task.id} #${task.repairs}`, this.now())
    this.emit({ type: "task.repair", runID: run.id, taskID: task.id, detail: `#${task.repairs}` })
    this.setWaiter(run, task)
  }

  private async runVerifier(run: RunState, task: Task): Promise<{ ok: boolean; reason: string }> {
    const spec: WorkerSpec = {
      taskID: `verify-${task.id}`,
      title: `verify ${task.id}`,
      prompt: buildVerifierPrompt(task, this.options.verifierPrompt || undefined),
      directory: task.worktree ?? this.port.baseDirectory,
      isolated: task.worktree !== undefined,
      parentSessionID: run.sessionID,
      agent: this.options.verifierAgent,
    }
    try {
      const handle = await this.port.spawnWorker(spec)
      await this.port.waitWorker(handle.sessionID)
      const text = await this.port.readWorkerOutcome(handle.sessionID)
      await this.safeDispose(handle.sessionID)
      const report = parseWorkerReport(text)
      if (report.status === "blocked") return { ok: false, reason: report.blocker || "verifier rejected" }
      return { ok: true, reason: report.evidence ?? "verified" }
    } catch (err) {
      await this.port.log("warn", "verifier session failed; treating as pass", { error: String(err) })
      return { ok: true, reason: "verifier unavailable" }
    }
  }

  private async changedFiles(directory: string): Promise<string[]> {
    try {
      return await this.port.changedFiles(directory)
    } catch (err) {
      await this.port.log("warn", "could not read changed files", { error: String(err) })
      return []
    }
  }

  private sourcePath(run: RunState): string | undefined {
    const label = run.sourceLabel
    if (label.length === 0 || label === "inline") return undefined
    if (label.startsWith("/")) return label
    const base = run.projectDir.replace(/\/+$/, "")
    return `${base}/${label.replace(/^\.\//, "")}`
  }

  private projectPath(run: RunState, relative: string): string {
    if (relative.startsWith("/")) return relative
    const base = run.projectDir.replace(/\/+$/, "")
    return `${base}/${relative.replace(/^\.\//, "")}`
  }

  /** True when the task's checkbox is checked in the source list; undefined when unreadable. */
  private async isCheckedOff(run: RunState, task: Task): Promise<boolean | undefined> {
    const path = this.sourcePath(run)
    if (!path) return undefined
    const content = await this.port.readText(path)
    if (content === undefined) return undefined
    const parsed = this.prepare(content)
    const found = parsed.tasks.find((t) => t.id === task.id)
    return found ? found.checkedInSource : undefined
  }

  private async flipSourceCheckbox(run: RunState, task: Task): Promise<void> {
    const path = this.sourcePath(run)
    if (!path) return
    const content = await this.port.readText(path)
    if (content === undefined) return
    let updated = content
    if (this.options.taskFormat === "headings") {
      const re = new RegExp(`^(#{3,}\\s+${escapeRe(task.id)}[.)]?\\s*\\[)([ ])(\\])`, "m")
      updated = content.replace(re, "$1x$3")
    } else {
      const firstLine = (task.raw ?? "").split("\n")[0] ?? ""
      if (firstLine.includes("[ ]")) {
        updated = content.replace(firstLine, firstLine.replace("[ ]", "[x]"))
      }
    }
    if (updated !== content) {
      await this.port.writeText(path, updated)
      this.store.history(run, "checked-off", task.id, this.now())
    }
  }

  private async appendProgress(run: RunState, task: Task): Promise<void> {
    const path = this.projectPath(run, this.options.progressFile)
    const date = new Date(this.now()).toISOString().slice(0, 10)
    const lines = ["", `## ${task.id}: ${task.title} (${date})`, "", "- **Status:** done"]
    if (task.evidence) lines.push(`- **Evidence:** ${summarize(task.evidence, 500)}`)
    lines.push("")
    await this.port.appendText(path, lines.join("\n"))
  }

  private async integrate(run: RunState, task: Task): Promise<void> {
    if (task.integrated) return
    if (task.worktree) {
      if (this.options.commitBeforeMerge) {
        const commit = await this.port.commitWorktree(task.worktree, `sub-worker: ${task.id} ${task.title}`)
        if (!commit.ok) {
          await this.port.log("info", "commit skipped", { task: task.id, output: summarize(commit.output, 200) })
        }
      }
      if (run.autoMerge) {
        const res = await this.port.mergeWorktree(task.worktree, this.port.baseDirectory)
        if (!res.ok) {
          await this.terminalTask(run, task, "blocked", `merge failed: ${summarize(res.output, 300)}`, false)
          return
        }
        this.store.history(run, "merged", task.id, this.now())
        task.integrated = true
        if (this.options.cleanupWorktrees) {
          try {
            await this.port.removeWorktree(task.worktree, true)
          } catch (err) {
            await this.port.log("warn", "worktree cleanup failed", { task: task.id, error: String(err) })
          }
          task.worktree = undefined
        }
      } else {
        // autoMerge is off: keep the worktree so the change can be reviewed.
        task.integrated = true
        this.store.history(run, "worktree-kept", `${task.id}: ${task.worktree}`, this.now())
      }
    } else {
      task.integrated = true
    }
  }

  private async handleFailure(run: RunState, task: Task, reason: string): Promise<void> {
    task.attempts += 1
    task.lastError = reason
    if (task.attempts < this.options.maxAttempts) {
      task.status = "pending"
      task.sessionID = undefined
      // Rotate to the next fallback model, if configured.
      const fb = this.options.fallbackModels
      if (fb.length > 0) {
        const current = task.modelOverride ?? task.model
        const idx = current !== undefined ? fb.indexOf(current) : -1
        const next = idx + 1 < fb.length ? fb[idx + 1] : fb[0]
        if (next) task.modelOverride = next
      }
      if (this.options.freshWorktreeOnRetry && task.worktree) {
        try {
          await this.port.removeWorktree(task.worktree, true)
        } catch {
          // ignore
        }
        task.worktree = undefined
      }
      this.store.history(
        run,
        "retry",
        `${task.id} attempt ${task.attempts}: ${summarize(reason, 200)}${task.modelOverride ? ` (model ${task.modelOverride})` : ""}`,
        this.now(),
      )
      return
    }
    await this.terminalTask(run, task, "failed", reason, false)
  }

  private async terminalTask(
    run: RunState,
    task: Task,
    status: "failed" | "blocked",
    reason: string,
    keepSession: boolean,
  ): Promise<void> {
    task.status = status
    task.lastError = reason
    task.endedAt = this.now()
    this.store.history(run, status, `${task.id}: ${summarize(reason, 200)}`, this.now())
    this.emit({ type: `task.${status}`, runID: run.id, taskID: task.id, detail: summarize(reason, 200) })

    if (this.options.continueOnError) return

    if (status === "blocked" && keepSession && task.sessionID) {
      this.store.setStatus(run, "paused", `awaiting answer for ${task.id}`, this.now())
      await this.port.notify(
        `Sub-worker awaiting answer for ${task.id}: ${summarize(reason, 140)} — reply with /tasks answer ${task.id} <text>`,
      )
      return
    }
    this.store.setStatus(run, "paused", `task ${task.id} ${status}`, this.now())
    await this.port.notify(`Sub-worker paused: task ${task.id} ${status} — ${summarize(reason, 140)}`)
  }

  private async safeDispose(sessionID: string): Promise<void> {
    try {
      await this.port.disposeWorker(sessionID)
    } catch {
      // ignore
    }
  }

  // ---- mailbox ----------------------------------------------------------

  async report(workerSessionID: string, input: ReportInput): Promise<boolean> {
    const found = this.store.byWorkerSession(workerSessionID)
    if (!found) return false
    const { run, task } = found
    const msg: MailboxMessage = {
      from: "worker",
      taskID: task.id,
      text: input.note ?? input.evidence ?? "",
      time: this.now(),
    }
    if (input.status) msg.status = input.status
    task.reports = [...(task.reports ?? []), msg]
    this.store.history(
      run,
      "report",
      `${task.id}: ${input.status ?? "?"} ${summarize(msg.text, 160)}`,
      this.now(),
    )
    await this.persist()
    return true
  }

  async inbox(workerSessionID: string): Promise<MailboxMessage[]> {
    const found = this.store.byWorkerSession(workerSessionID)
    if (!found) return []
    const msgs = found.task.outbox ?? []
    found.task.outbox = []
    await this.persist()
    return msgs
  }

  async send(sessionID: string, taskID: string, text: string): Promise<boolean> {
    const run = this.store.active(sessionID)
    if (!run) return false
    const task = this.byId(run).get(taskID)
    if (!task) return false
    const msg: MailboxMessage = { from: "orchestrator", taskID, text, time: this.now() }
    task.outbox = [...(task.outbox ?? []), msg]
    if (task.sessionID) {
      try {
        await this.port.sendWorkerMessage(task.sessionID, `${CONTROL_MARKER} orchestrator: ${text}`)
      } catch (err) {
        await this.port.log("warn", "steer failed", { task: task.id, error: String(err) })
      }
    }
    await this.persist()
    return true
  }

  // ---- per-task views ---------------------------------------------------

  async diffText(sessionID: string, taskID: string): Promise<string> {
    const run = this.store.active(sessionID)
    if (!run) return "No active task run."
    const task = this.byId(run).get(taskID)
    if (!task) return `No task "${taskID}".`
    if (!task.worktree) {
      const changed = await this.changedFiles(this.port.baseDirectory)
      if (changed.length === 0) return `Task ${taskID} has no isolated worktree and no changed files were detected.`
      return `Task ${taskID} ran in place. Changed files:\n${changed.map((f) => `  ${f}`).join("\n")}`
    }
    try {
      const diff = await this.port.worktreeDiff(task.worktree)
      const header = `Diff for ${taskID}${task.branch ? ` (branch ${task.branch})` : ""}:`
      return `${header}\n${diff}`
    } catch (err) {
      return `Could not read the diff for ${taskID}: ${String(err)}`
    }
  }

  logsText(sessionID: string, taskID: string): string {
    const run = this.store.active(sessionID)
    if (!run) return "No active task run."
    const task = this.byId(run).get(taskID)
    if (!task) return `No task "${taskID}".`
    const lines: string[] = []
    lines.push(`Task ${task.id}: ${task.title}`)
    lines.push(`Status: ${task.status}`)
    if (task.branch) lines.push(`Branch: ${task.branch}`)
    if (task.worktree) lines.push(`Worktree: ${task.worktree}`)
    lines.push(`Attempts: ${task.attempts}   repairs: ${task.repairs ?? 0}`)
    if (task.cost !== undefined) lines.push(`Cost: $${task.cost.toFixed(4)}   tokens: ${task.tokens ?? 0}`)
    if (task.evidence) lines.push(`Evidence: ${task.evidence}`)
    if (task.lastError) lines.push(`Last error: ${task.lastError}`)
    if (task.gateOutput) {
      lines.push("")
      lines.push("Gate output:")
      lines.push(task.gateOutput.slice(-4000))
    }
    const related = run.history.filter((h) => h.detail.includes(task.id) || h.detail.includes(task.title))
    if (related.length > 0) {
      lines.push("")
      lines.push("History:")
      for (const h of related.slice(-20)) lines.push(`  - ${h.type}: ${h.detail}`)
    }
    return lines.join("\n")
  }

  // ---- reporting --------------------------------------------------------

  statusText(sessionID: string): string {
    const run = this.store.active(sessionID)
    if (!run) return "No active task run. Use /tasks plan <file> or /tasks run <file>."
    const counts = tally(run.tasks)
    const lines: string[] = []
    lines.push(`Run ${run.id}`)
    lines.push(`Source: ${run.sourceLabel}`)
    lines.push(`Status: ${run.status}${run.stopReason ? ` (${run.stopReason})` : ""}`)
    lines.push(
      `Tasks: ${run.tasks.length}  done=${counts.done} running=${counts.running} review=${counts.review} pending=${counts.pending} failed=${counts.failed} blocked=${counts.blocked} skipped=${counts.skipped}`,
    )
    lines.push(`Max concurrency: ${run.maxConcurrency}   autoMerge: ${run.autoMerge}`)
    const budgetBits: string[] = [`$${run.cost.toFixed(4)}`]
    if (run.maxCostUsd > 0) budgetBits.push(`budget $${run.maxCostUsd}`)
    budgetBits.push(`${run.tokens} tokens`)
    if (run.maxTokens > 0) budgetBits.push(`budget ${run.maxTokens}`)
    lines.push(`Usage: ${budgetBits.join("  ·  ")}`)
    lines.push("")
    for (const t of run.tasks) {
      const mark = statusMark(t.status)
      const extras: string[] = []
      if (t.branch) extras.push(`branch ${t.branch}`)
      else if (t.worktree) extras.push("worktree")
      if (t.priority) extras.push(`prio ${t.priority}`)
      if (t.held) extras.push("held")
      if (t.attempts > 0) extras.push(`attempts=${t.attempts}`)
      if (t.repairs) extras.push(`repairs=${t.repairs}`)
      if (t.cost !== undefined && t.cost > 0) extras.push(`$${t.cost.toFixed(4)}`)
      lines.push(`  ${mark} ${t.index}. ${t.title} [${t.status}]${extras.length > 0 ? ` (${extras.join(", ")})` : ""}`)
      if (t.lastError) lines.push(`      ! ${summarize(t.lastError, 200)}`)
      if (t.scopeViolations && t.scopeViolations.length > 0) {
        lines.push(`      ⚠ out of scope: ${t.scopeViolations.join(", ")}`)
      }
      if (t.evidence && t.status === "done") lines.push(`      ✓ ${summarize(t.evidence, 200)}`)
    }
    const recent = run.history.slice(-8)
    if (recent.length > 0) {
      lines.push("")
      lines.push("Recent activity:")
      for (const h of recent) lines.push(`  - ${h.type}: ${h.detail}`)
    }
    return lines.join("\n")
  }

  listText(sessionID: string): string {
    const run = this.store.active(sessionID)
    if (!run) return "No active task run."
    const counts = tally(run.tasks)
    return `${run.sourceLabel}: ${run.status} — ${counts.done}/${run.tasks.length} done`
  }

  // ---- persistence ------------------------------------------------------

  async persist(): Promise<void> {
    if (!this.options.persistState) return
    try {
      await this.port.storage.set("state", this.store.serialize())
      if (this.options.coChangeLearning) await this.port.storage.set("cochange", this.cochange.serialize())
    } catch (err) {
      await this.port.log("error", "failed to persist run state", { error: String(err) })
    }
  }

  async load(): Promise<void> {
    if (!this.options.persistState) return
    try {
      const snapshot = await this.port.storage.get("state")
      this.store.load(snapshot as Parameters<RunStore["load"]>[0])
      if (this.options.coChangeLearning) {
        this.cochange.load(await this.port.storage.get("cochange"))
      }
    } catch (err) {
      await this.port.log("warn", "failed to load run state", { error: String(err) })
    }
  }

  recovered(sessionID: string): RunState | undefined {
    const run = this.store.active(sessionID)
    return run && run.status === "paused" && run.stopReason === "recovered after restart" ? run : undefined
  }

  /** Snapshot of the active run for RPC/observability clients. */
  snapshot(sessionID: string): Record<string, unknown> | undefined {
    const run = this.store.active(sessionID)
    if (!run) return undefined
    const counts = tally(run.tasks)
    return {
      runID: run.id,
      source: run.sourceLabel,
      status: run.status,
      stopReason: run.stopReason,
      cost: run.cost,
      tokens: run.tokens,
      counts,
      tasks: run.tasks.map((t) => ({
        id: t.id,
        title: t.title,
        status: t.status,
        priority: t.priority ?? 0,
        branch: t.branch,
        attempts: t.attempts,
        repairs: t.repairs ?? 0,
        risk: t.risk,
      })),
    }
  }

  private async mirrorTitle(run: RunState): Promise<void> {
    if (!this.options.mirrorSessionTitles) return
    const counts = tally(run.tasks)
    const icon =
      run.status === "completed" ? "✅" : run.status === "failed" || run.status === "paused" ? "⏸" : "▶"
    const title = `${icon} tasks ${counts.done + counts.skipped}/${run.tasks.length} · ${run.status}`
    try {
      await this.port.setSessionTitle(run.sessionID, title)
    } catch {
      // cosmetic only
    }
  }
}

function tally(tasks: Task[]): Record<Task["status"], number> {
  const base: Record<Task["status"], number> = {
    pending: 0,
    running: 0,
    verifying: 0,
    review: 0,
    done: 0,
    failed: 0,
    blocked: 0,
    skipped: 0,
  }
  for (const t of tasks) base[t.status] += 1
  return base
}

function statusMark(status: Task["status"]): string {
  switch (status) {
    case "done":
      return "x"
    case "running":
      return ">"
    case "verifying":
      return "?"
    case "review":
      return "@"
    case "failed":
      return "!"
    case "blocked":
      return "#"
    case "skipped":
      return "-"
    default:
      return " "
  }
}

export function parseModel(ref: string): { providerID: string; modelID: string; variant?: string } | undefined {
  return parseModelRef(ref)
}

function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

export function parseModelRef(
  ref: string,
): { providerID: string; modelID: string; variant?: string } | undefined {
  const trimmed = ref.trim()
  if (trimmed.length === 0) return undefined
  const hash = trimmed.indexOf("#")
  const head = hash >= 0 ? trimmed.slice(0, hash) : trimmed
  const variant = hash >= 0 ? trimmed.slice(hash + 1) : ""
  const slash = head.indexOf("/")
  if (slash <= 0 || slash >= head.length - 1) return undefined
  const providerID = head.slice(0, slash)
  const modelID = head.slice(slash + 1)
  const model: { providerID: string; modelID: string; variant?: string } = { providerID, modelID }
  if (variant.length > 0) model.variant = variant
  return model
}
