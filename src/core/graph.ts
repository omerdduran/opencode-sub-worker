/**
 * Dependency graph and conflict model.
 *
 * Conflicts are pairwise and symmetric: two tasks conflict when they share a
 * declared file (glob-aware), share a named lock, or when either side declares
 * no files at all (an unknown write set is never allowed to run concurrently).
 * An optional `extra` predicate lets the caller add learned conflicts (for
 * example, git co-change history).
 */

import type { Graph, SchedulePreview, Task, Wave } from "./types.ts"
import { specConflicts } from "./glob.ts"

export type ConflictPredicate = (a: Task, b: Task) => boolean

export function conflicts(a: Task, b: Task, extra?: ConflictPredicate): boolean {
  if (a.id === b.id) return false
  if (a.files.length === 0 || b.files.length === 0) return true
  for (const fa of a.files) {
    for (const fb of b.files) {
      if (specConflicts(fa, fb)) return true
    }
  }
  if (a.locks !== undefined && b.locks !== undefined) {
    const set = new Set(b.locks)
    if (a.locks.some((l) => set.has(l))) return true
  }
  if (extra && extra(a, b)) return true
  return false
}

export function buildGraph(tasks: Task[], extra?: ConflictPredicate): Graph {
  const byId = new Map<string, Task>()
  for (const t of tasks) byId.set(t.id, t)
  const conflictsList: Array<[string, string]> = []
  for (let i = 0; i < tasks.length; i++) {
    for (let j = i + 1; j < tasks.length; j++) {
      const a = tasks[i]!
      const b = tasks[j]!
      if (conflicts(a, b, extra)) conflictsList.push([a.id, b.id])
    }
  }
  return { byId, conflicts: conflictsList }
}

/** Depth-first cycle detection over the `deps` edges. Returns the cycle path. */
export function findCycle(tasks: Task[]): string[] {
  const byId = new Map(tasks.map((t) => [t.id, t] as const))
  const state = new Map<string, 0 | 1 | 2>() // 0 unseen, 1 on-stack, 2 done
  const stack: string[] = []
  let cycle: string[] = []

  const visit = (id: string): boolean => {
    const t = byId.get(id)
    if (!t) return false
    const s = state.get(id) ?? 0
    if (s === 2) return false
    if (s === 1) {
      const at = stack.indexOf(id)
      cycle = stack.slice(at >= 0 ? at : 0).concat(id)
      return true
    }
    state.set(id, 1)
    stack.push(id)
    for (const dep of t.deps) if (visit(dep)) return true
    stack.pop()
    state.set(id, 2)
    return false
  }

  for (const t of tasks) if (visit(t.id)) break
  return cycle
}

/**
 * Greedy dry-run: repeatedly take a maximal set of dependency-satisfied,
 * pairwise non-conflicting tasks as one wave. This is a preview, not the
 * runtime schedule (the runtime scheduler is opportunistic and bounded by
 * maxConcurrency).
 */
export function previewWaves(tasks: Task[], extra?: ConflictPredicate): SchedulePreview {
  const cycle = findCycle(tasks)
  const done = new Set<string>()
  for (const t of tasks) if (t.checkedInSource) done.add(t.id)

  const pending = new Set(tasks.filter((t) => !t.checkedInSource).map((t) => t.id))
  const byId = new Map(tasks.map((t) => [t.id, t] as const))
  const waves: Wave[] = []
  let guard = tasks.length + 1

  while (pending.size > 0) {
    if (guard-- <= 0) break
    const wave: Task[] = []
    for (const id of [...pending]) {
      const t = byId.get(id)
      if (!t) continue
      if (!t.deps.every((d) => done.has(d))) continue
      if (wave.some((w) => conflicts(w, t, extra))) continue
      wave.push(t)
    }
    if (wave.length === 0) break // deadlock or unsatisfiable preview
    for (const t of wave) {
      done.add(t.id)
      pending.delete(t.id)
    }
    waves.push({ index: waves.length + 1, taskIDs: wave.map((t) => t.id) })
  }

  return { waves, conflicts: buildGraph(tasks, extra).conflicts, cycle }
}
