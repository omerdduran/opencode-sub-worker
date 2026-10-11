/**
 * Runtime scheduler: given the current task states, choose which pending tasks
 * may start now. Pure and deterministic so it can be unit tested without a host.
 *
 * Among ready tasks, higher `priority` wins, then source order.
 */

import { conflicts, type ConflictPredicate } from "./graph.ts"
import type { Task } from "./types.ts"

export function isSettled(status: Task["status"]): boolean {
  return status === "done" || status === "skipped"
}

export function isTerminalBad(status: Task["status"]): boolean {
  return status === "failed" || status === "blocked"
}

/** Ids of tasks that may start, bounded by free concurrency slots and conflicts. */
export function nextBatch(tasks: Task[], maxConcurrency: number, extra?: ConflictPredicate): string[] {
  const running = tasks.filter(
    (t) => t.status === "running" || t.status === "verifying" || t.status === "review",
  )
  const free = maxConcurrency - running.length
  if (free <= 0) return []

  const done = new Set(tasks.filter((t) => isSettled(t.status)).map((t) => t.id))
  const candidates = tasks.filter((t) => t.status === "pending" && t.deps.every((d) => done.has(d)))
  candidates.sort((x, y) => (y.priority ?? 0) - (x.priority ?? 0) || x.index - y.index)

  const busy: Task[] = [...running]
  const chosen: Task[] = []
  for (const t of candidates) {
    if (chosen.length >= free) break
    if (busy.some((b) => conflicts(b, t, extra))) continue
    chosen.push(t)
    busy.push(t)
  }
  return chosen.map((t) => t.id)
}

/**
 * Mark pending tasks whose dependencies can never succeed as `skipped`.
 * Returns the ids that were skipped.
 */
export function propagateSkips(tasks: Task[]): string[] {
  const byId = new Map(tasks.map((t) => [t.id, t] as const))
  const skipped: string[] = []
  let changed = true
  while (changed) {
    changed = false
    for (const t of tasks) {
      if (t.status !== "pending") continue
      const dead = t.deps.some((d) => {
        const dep = byId.get(d)
        return dep ? isTerminalBad(dep.status) || dep.status === "skipped" : true
      })
      if (dead) {
        t.status = "skipped"
        t.lastError = "dependency failed or was skipped"
        skipped.push(t.id)
        changed = true
      }
    }
  }
  return skipped
}

export function activeCount(tasks: Task[]): number {
  return tasks.filter((t) => t.status === "running" || t.status === "verifying" || t.status === "review").length
}

export function hasPending(tasks: Task[]): boolean {
  return tasks.some((t) => t.status === "pending")
}
