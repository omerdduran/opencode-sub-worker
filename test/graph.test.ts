import { test } from "node:test"
import assert from "node:assert/strict"
import { buildGraph, conflicts, findCycle, previewWaves } from "../src/core/graph.ts"
import type { Task } from "../src/core/types.ts"

function task(partial: Partial<Task> & { id: string }): Task {
  return {
    id: partial.id,
    index: partial.index ?? 1,
    title: partial.title ?? partial.id,
    checkedInSource: partial.checkedInSource ?? false,
    files: partial.files ?? [],
    verify: partial.verify ?? null,
    deps: partial.deps ?? [],
    status: partial.status ?? "pending",
    attempts: 0,
  }
}

test("conflicts: shared file conflicts, disjoint does not", () => {
  assert.equal(conflicts(task({ id: "a", files: ["x.ts"] }), task({ id: "b", files: ["x.ts"] })), true)
  assert.equal(conflicts(task({ id: "a", files: ["x.ts"] }), task({ id: "b", files: ["y.ts"] })), false)
})

test("conflicts: an undeclared write set conflicts with everything", () => {
  assert.equal(conflicts(task({ id: "a", files: [] }), task({ id: "b", files: ["x.ts"] })), true)
  assert.equal(conflicts(task({ id: "a", files: [] }), task({ id: "b", files: [] })), true)
})

test("buildGraph collects conflicting pairs", () => {
  const tasks = [
    task({ id: "t1", files: ["a", "b"] }),
    task({ id: "t2", files: ["b"] }),
    task({ id: "t3", files: ["c"] }),
  ]
  const graph = buildGraph(tasks)
  const pairs = graph.conflicts.map(([a, b]) => `${a}~${b}`)
  assert.ok(pairs.includes("t1~t2"))
  assert.ok(!pairs.includes("t1~t3"))
})

test("findCycle detects a dependency cycle", () => {
  const cyclic = [
    task({ id: "a", deps: ["b"] }),
    task({ id: "b", deps: ["c"] }),
    task({ id: "c", deps: ["a"] }),
  ]
  const cycle = findCycle(cyclic)
  assert.ok(cycle.length >= 3)
})

test("previewWaves parallelizes disjoint tasks and serializes conflicting ones", () => {
  const disjoint = [
    task({ id: "a", files: ["a.ts"] }),
    task({ id: "b", files: ["b.ts"] }),
  ]
  const waves = previewWaves(disjoint).waves
  assert.equal(waves.length, 1)
  assert.deepEqual(waves[0]!.taskIDs, ["a", "b"])

  const conflicting = [
    task({ id: "a", files: ["shared.ts"] }),
    task({ id: "b", files: ["shared.ts"] }),
  ]
  const serial = previewWaves(conflicting).waves
  assert.equal(serial.length, 2)
})

test("previewWaves respects dependencies", () => {
  const tasks = [
    task({ id: "a", files: ["a.ts"] }),
    task({ id: "b", files: ["b.ts"], deps: ["a"] }),
  ]
  const waves = previewWaves(tasks).waves
  assert.deepEqual(waves[0]!.taskIDs, ["a"])
  assert.deepEqual(waves[1]!.taskIDs, ["b"])
})
