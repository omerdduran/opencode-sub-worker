import { test } from "node:test"
import assert from "node:assert/strict"
import { nextBatch, propagateSkips } from "../src/core/scheduler.ts"
import type { Task } from "../src/core/types.ts"

function task(partial: Partial<Task> & { id: string }): Task {
  return {
    id: partial.id,
    index: partial.index ?? 1,
    title: partial.title ?? partial.id,
    checkedInSource: false,
    files: partial.files ?? [],
    verify: null,
    deps: partial.deps ?? [],
    status: partial.status ?? "pending",
    attempts: 0,
  }
}

test("nextBatch respects the concurrency bound", () => {
  const tasks = [task({ id: "a", files: ["a"] }), task({ id: "b", files: ["b"] }), task({ id: "c", files: ["c"] })]
  assert.deepEqual(nextBatch(tasks, 2), ["a", "b"])
  assert.deepEqual(nextBatch(tasks, 1), ["a"])
})

test("nextBatch only picks dependency-satisfied tasks", () => {
  const tasks = [task({ id: "a", files: ["a"] }), task({ id: "b", files: ["b"], deps: ["a"] })]
  assert.deepEqual(nextBatch(tasks, 3), ["a"])
  tasks[0]!.status = "done"
  assert.deepEqual(nextBatch(tasks, 3), ["b"])
})

test("nextBatch serializes conflicting tasks", () => {
  const tasks = [
    task({ id: "a", files: ["shared"], status: "running" }),
    task({ id: "b", files: ["shared"] }),
    task({ id: "c", files: ["other"] }),
  ]
  assert.deepEqual(nextBatch(tasks, 3), ["c"])
})

test("nextBatch never runs an undeclared task alongside any running task", () => {
  const tasks = [task({ id: "a", files: ["a"], status: "running" }), task({ id: "b", files: [] })]
  assert.deepEqual(nextBatch(tasks, 3), [])
})

test("propagateSkips skips tasks whose dependency failed", () => {
  const tasks = [
    task({ id: "a", files: ["a"], status: "failed" }),
    task({ id: "b", files: ["b"], deps: ["a"] }),
    task({ id: "c", files: ["c"], deps: ["b"] }),
  ]
  const skipped = propagateSkips(tasks)
  assert.deepEqual(skipped.sort(), ["b", "c"])
  assert.equal(tasks[1]!.status, "skipped")
  assert.equal(tasks[2]!.status, "skipped")
})
