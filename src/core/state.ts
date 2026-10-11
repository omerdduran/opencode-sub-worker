/**
 * In-memory run store. Persistence is handled by adapters via serialize/load.
 */

import { randomUUID } from "node:crypto"
import type { RunState, RunStatus, Task } from "./types.ts"

export interface StoreSnapshot {
  version: 1
  runs: RunState[]
}

export function makeRun(
  sessionID: string,
  source: string,
  sourceLabel: string,
  projectDir: string,
  tasks: Task[],
  maxConcurrency: number,
  autoMerge: boolean,
  now: number,
  budget: { maxCostUsd: number; maxTokens: number } = { maxCostUsd: 0, maxTokens: 0 },
): RunState {
  return {
    id: randomUUID(),
    sessionID,
    source,
    sourceLabel,
    projectDir,
    tasks,
    status: "running",
    maxConcurrency,
    autoMerge,
    cost: 0,
    tokens: 0,
    maxCostUsd: budget.maxCostUsd,
    maxTokens: budget.maxTokens,
    startedAt: now,
    updatedAt: now,
    stopReason: "",
    history: [],
  }
}

export class RunStore {
  private readonly runs = new Map<string, RunState>()

  /** One live run per orchestrator session (the most recently started). */
  private readonly activeBySession = new Map<string, string>()

  add(run: RunState): void {
    this.runs.set(run.id, run)
    this.activeBySession.set(run.sessionID, run.id)
  }

  byId(id: string): RunState | undefined {
    return this.runs.get(id)
  }

  active(sessionID: string): RunState | undefined {
    const id = this.activeBySession.get(sessionID)
    return id ? this.runs.get(id) : undefined
  }

  /** Find the run that owns a worker session id. */
  byWorkerSession(workerSessionID: string): { run: RunState; task: Task } | undefined {
    for (const run of this.runs.values()) {
      const task = run.tasks.find((t) => t.sessionID === workerSessionID)
      if (task) return { run, task }
    }
    return undefined
  }

  all(): RunState[] {
    return [...this.runs.values()]
  }

  history(run: RunState, type: string, detail: string, now: number): void {
    run.history.push({ type, detail, time: now })
    if (run.history.length > 200) run.history.splice(0, run.history.length - 200)
    run.updatedAt = now
  }

  setStatus(run: RunState, status: RunStatus, reason: string, now: number): void {
    run.status = status
    run.stopReason = reason
    run.updatedAt = now
    this.history(run, `run:${status}`, reason, now)
  }

  serialize(): StoreSnapshot {
    return { version: 1, runs: this.all() }
  }

  load(snapshot: StoreSnapshot | undefined): void {
    if (!snapshot || snapshot.version !== 1 || !Array.isArray(snapshot.runs)) return
    for (const run of snapshot.runs) {
      // Recovered active runs start paused so unattended work does not resume blindly.
      if (run.status === "running" || run.status === "planning") {
        run.status = "paused"
        run.stopReason = "recovered after restart"
      }
      // A recovered session's worker links are stale.
      for (const t of run.tasks) {
        if (t.status === "running" || t.status === "verifying") {
          t.status = "pending"
          t.sessionID = undefined
        }
      }
      this.runs.set(run.id, run)
      this.activeBySession.set(run.sessionID, run.id)
    }
  }
}
