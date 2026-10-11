/**
 * The orchestrator engine.
 *
 * Deterministic, host-independent scheduling: it parses a checklist, builds a
 * dependency/conflict graph, launches isolated worker sessions for ready tasks,
 * waits for them, enforces the declared write scope, gates each result with a
 * verification command (optionally an independent verifier session), merges the
 * worker's branch, and advances. All host interaction goes through `HostPort`.
 */

import { parseChecklist } from "./parser.ts"
import { findCycle, previewWaves } from "./graph.ts"
import { activeCount, hasPending, nextBatch, propagateSkips } from "./scheduler.ts"
import { buildVerifierPrompt, buildWorkerPrompt, control, parseWorkerOutcome, summarize } from "./prompt.ts"
import { makeRun, RunStore } from "./state.ts"
import { matchesAny } from "./glob.ts"
import { resolveModelRef, type PluginOptions } from "./options.ts"
import type { MailboxMessage, RunState, Task } from "./types.ts"
import { CONTROL_MARKER } from "./constants.ts"
import type { HostPort, PermissionRule, WorkerSpec } from "../ports.ts"

export interface ReportInput {
  status?: "progress" | "blocked" | "done"
  note?: string
  evidence?: string
}

interface WaitOutcome {
  taskID: string
  timedOut: boolean
}

export class Engine {
  readonly store = new RunStore()
  private readonly options: PluginOptions
  private readonly port: HostPort
  private readonly activeLoops = new Set<string>()
  /** In-flight completion waiters, keyed by `${runId}:${taskId}`. */
  private readonly waits = new Map<string, Promise<WaitOutcome>>()

  constructor(options: PluginOptions, port: HostPort) {
    this.options = options
    this.port = port
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

  // ---- planning ---------------------------------------------------------

  planText(source: string, label: string): string {
    const { tasks, errors } = parseChecklist(source)
    const preview = previewWaves(tasks)
    const lines: string[] = [`Tasks (${tasks.length}) from ${label}:`]
    for (const t of tasks) {
      const bits: string[] = []
      if (t.files.length > 0) bits.push(`files: ${t.files.join(", ")}`)
      if (t.verify) bits.push(`verify: ${t.verify}`)
      if (t.deps.length > 0) bits.push(`deps: ${t.deps.join(", ")}`)
      if (t.agent) bits.push(`agent: ${t.agent}`)
      if (t.model) bits.push(`model: ${t.model}`)
      if (t.risk) bits.push(`risk: ${t.risk}`)
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
      lines.push(`File-conflict pairs (serialized): ${pairs.map(([a, b]) => `${a}~${b}`).join(", ")}`)
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
    const { tasks } = parseChecklist(source)
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
    this.store.add(run)
    this.store.history(run, "started", `${tasks.length} task(s) from ${label}`, this.now())
    await this.persist()
    this.launchLoop(run)
    return run
  }

  async resume(sessionID: string): Promise<RunState | undefined> {
    const run = this.store.active(sessionID)
    if (!run) return undefined
    if (run.status === "completed" || run.status === "aborted") return run
    this.clearWaits(run)
    for (const t of run.tasks) {
      if (t.status === "running" || t.status === "verifying") {
        t.status = "pending"
        t.sessionID = undefined
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
    this.launchLoop(run)
    return run
  }

  async abort(sessionID: string): Promise<RunState | undefined> {
    const run = this.store.active(sessionID)
    if (!run) return undefined
    this.clearWaits(run)
    for (const t of run.tasks) {
      if ((t.status === "running" || t.status === "verifying") && t.sessionID) {
        try {
          await this.port.disposeWorker(t.sessionID)
        } catch {
          // ignore
        }
      }
      if (t.status === "running" || t.status === "verifying") {
        t.status = "pending"
        t.sessionID = undefined
      }
    }
    this.store.setStatus(run, "aborted", "user aborted", this.now())
    await this.persist()
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

      const batch = nextBatch(run.tasks, run.maxConcurrency)
      for (const id of batch) await this.launch(run, id)
      await this.persist()

      // A launch may have terminally failed the run (e.g. worktree unavailable).
      if (run.status !== "running") break

      if (activeCount(run.tasks) === 0) {
        if (hasPending(run.tasks)) {
          this.store.setStatus(run, "paused", "no runnable tasks (dependency deadlock)", this.now())
          await this.port.notify("Sub-worker run paused: no runnable tasks.")
        } else {
          const bad = run.tasks.filter((t) => t.status === "failed" || t.status === "blocked")
          if (bad.length > 0) this.store.setStatus(run, "failed", `${bad.length} task(s) not completed`, this.now())
          else this.store.setStatus(run, "completed", "all tasks done", this.now())
          await this.port.notify(`Sub-worker run ${run.status}.`)
        }
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

    let directory = this.port.baseDirectory
    let isolated = false
    let worktree = task.worktree
    if (this.options.useWorktrees) {
      if (!worktree) {
        try {
          const wt = await this.port.createWorktree(`t-${task.id}`)
          worktree = wt.directory
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
    }
    task.worktree = worktree

    const spec: WorkerSpec = {
      taskID: task.id,
      title: task.title,
      prompt: buildWorkerPrompt(task, this.port.baseDirectory, task.lastError),
      directory,
      isolated,
      parentSessionID: run.sessionID,
    }
    const agent = task.agent ?? this.options.workerAgent
    if (agent.length > 0) spec.agent = agent
    const modelRef = resolveModelRef(this.options, task.model, task.agent)
    const model = parseModelRef(modelRef)
    if (model) spec.model = model
    const permissions = this.buildPermissions(task)
    if (permissions) spec.permissions = permissions

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
    const outcome = parseWorkerOutcome(text)
    const report =
      task.reports !== undefined && task.reports.length > 0 ? task.reports[task.reports.length - 1] : undefined

    if (outcome.kind === "blocked" || report?.status === "blocked") {
      const reason = outcome.blocker || report?.text || "worker reported blocked"
      if (this.options.askUserOnBlocked) {
        // Keep the session alive so an answer can resume it.
        await this.terminalTask(run, task, "blocked", reason, true)
      } else {
        await this.safeDispose(sessionID)
        task.sessionID = undefined
        await this.terminalTask(run, task, "blocked", reason, false)
      }
      return
    }

    if (this.options.enforceDiffScope && task.files.length > 0 && task.worktree) {
      const changed = await this.changedFiles(task.worktree)
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
      if (!gate.ok) {
        await this.safeDispose(sessionID)
        task.sessionID = undefined
        const why = gate.timedOut
          ? `gate timed out: ${summarize(gate.output, 300)}`
          : `gate failed (exit ${gate.exitCode ?? "?"}): ${summarize(gate.output, 300)}`
        await this.handleFailure(run, task, why)
        return
      }
    }

    if (this.options.verifierEnabled) {
      const verdict = await this.runVerifier(run, task)
      if (!verdict.ok) {
        await this.safeDispose(sessionID)
        task.sessionID = undefined
        await this.handleFailure(run, task, `verifier rejected: ${summarize(verdict.reason, 300)}`)
        return
      }
    }

    task.status = "done"
    task.endedAt = this.now()
    task.evidence = outcome.evidence || report?.text || (task.verify ? "gate passed" : "completed")
    await this.safeDispose(sessionID)
    task.sessionID = undefined
    this.store.history(run, "done", `${task.id}: ${summarize(task.evidence, 160)}`, this.now())
    await this.integrate(run, task)
  }

  private async runVerifier(run: RunState, task: Task): Promise<{ ok: boolean; reason: string }> {
    const spec: WorkerSpec = {
      taskID: `verify-${task.id}`,
      title: `verify ${task.id}`,
      prompt: buildVerifierPrompt(task),
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
      const verdict = parseWorkerOutcome(text)
      if (verdict.kind === "blocked") return { ok: false, reason: verdict.blocker || "verifier rejected" }
      if (verdict.kind === "done") return { ok: true, reason: verdict.evidence }
      return { ok: true, reason: "verifier produced no verdict" }
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

  private async integrate(run: RunState, task: Task): Promise<void> {
    if (task.worktree) {
      if (this.options.commitBeforeMerge) {
        const commit = await this.port.commitWorktree(task.worktree, `sub-worker: ${task.id} ${task.title}`)
        if (!commit.ok) {
          // A clean tree is fine (nothing to commit); a real failure is not.
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
      }
    }
    if (this.options.cleanupWorktrees && task.worktree) {
      try {
        await this.port.removeWorktree(task.worktree, true)
      } catch (err) {
        await this.port.log("warn", "worktree cleanup failed", { task: task.id, error: String(err) })
      }
      task.worktree = undefined
    }
  }

  private async handleFailure(run: RunState, task: Task, reason: string): Promise<void> {
    task.attempts += 1
    task.lastError = reason
    if (task.attempts < this.options.maxAttempts) {
      task.status = "pending"
      task.sessionID = undefined
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
        `${task.id} attempt ${task.attempts}: ${summarize(reason, 200)}`,
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
      `Tasks: ${run.tasks.length}  done=${counts.done} running=${counts.running} pending=${counts.pending} failed=${counts.failed} blocked=${counts.blocked} skipped=${counts.skipped}`,
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
      if (t.worktree) extras.push("worktree")
      if (t.attempts > 0) extras.push(`attempts=${t.attempts}`)
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
    } catch (err) {
      await this.port.log("error", "failed to persist run state", { error: String(err) })
    }
  }

  async load(): Promise<void> {
    if (!this.options.persistState) return
    try {
      const snapshot = await this.port.storage.get("state")
      this.store.load(snapshot as Parameters<RunStore["load"]>[0])
    } catch (err) {
      await this.port.log("warn", "failed to load run state", { error: String(err) })
    }
  }

  recovered(sessionID: string): RunState | undefined {
    const run = this.store.active(sessionID)
    return run && run.status === "paused" && run.stopReason === "recovered after restart" ? run : undefined
  }
}

function tally(tasks: Task[]): Record<Task["status"], number> {
  const base: Record<Task["status"], number> = {
    pending: 0,
    running: 0,
    verifying: 0,
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
