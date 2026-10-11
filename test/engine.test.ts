import { test } from "node:test"
import assert from "node:assert/strict"
import { Engine, parseModel } from "../src/core/engine.ts"
import { normalizeOptions } from "../src/core/options.ts"
import { FakeHost, until } from "./helpers.ts"

test("parseModel parses provider/model with an optional variant", () => {
  assert.deepEqual(parseModel("anthropic/claude-sonnet-4-5"), {
    providerID: "anthropic",
    modelID: "claude-sonnet-4-5",
  })
  assert.deepEqual(parseModel("anthropic/claude-sonnet-4-5#high"), {
    providerID: "anthropic",
    modelID: "claude-sonnet-4-5",
    variant: "high",
  })
  assert.equal(parseModel(""), undefined)
  assert.equal(parseModel("bare"), undefined)
})

test("disjoint tasks run in parallel worktrees, are merged, then cleaned up", async () => {
  const host = new FakeHost()
  const engine = new Engine(normalizeOptions({ maxConcurrency: 2 }), host)
  const source = "- [ ] a\n  - files: a.txt\n- [ ] b\n  - files: b.txt"

  const run = await engine.start("s1", source, "inline")
  await until(() => host.workers.size === 2, 3000, "two workers")
  assert.equal(host.worktrees.length, 2)

  host.finishTask("t1", "[task:done] wrote a.txt and verified")
  host.finishTask("t2", "[task:done] wrote b.txt and verified")
  await until(() => run.status === "completed", 3000, "run completed")

  assert.equal(run.tasks[0]!.status, "done")
  assert.equal(run.tasks[1]!.status, "done")
  assert.equal(host.merged.length, 2)
  assert.equal(host.worktrees.length, 0)
})

test("tasks that share a file are serialized", async () => {
  const host = new FakeHost()
  const engine = new Engine(normalizeOptions({ maxConcurrency: 2 }), host)
  const source = "- [ ] a\n  - files: shared.txt\n- [ ] b\n  - files: shared.txt"

  const run = await engine.start("s1", source, "inline")
  await until(() => host.workers.size === 1, 3000, "one worker")
  assert.equal(host.sessionForTask("t2"), undefined)

  host.finishTask("t1", "[task:done] a")
  await until(() => host.sessionForTask("t2") !== undefined, 3000, "second worker")
  host.finishTask("t2", "[task:done] b")
  await until(() => run.status === "completed", 3000, "completed")
})

test("tasks with no declared files are serialized", async () => {
  const host = new FakeHost()
  const engine = new Engine(normalizeOptions({ maxConcurrency: 3 }), host)
  const run = await engine.start("s1", "- [ ] a\n- [ ] b", "inline")
  await until(() => host.workers.size === 1, 3000, "one worker only")
  assert.equal(host.runningTaskIDs().length, 1)
  host.finishTask("t1", "[task:done] a")
  await until(() => host.sessionForTask("t2") !== undefined, 3000, "second worker")
  host.finishTask("t2", "[task:done] b")
  await until(() => run.status === "completed", 3000, "completed")
})

test("a verification gate runs in the worktree and a passing gate completes the task", async () => {
  const host = new FakeHost()
  const engine = new Engine(normalizeOptions({ maxConcurrency: 1 }), host)
  const source = "- [ ] a\n  - files: a.txt\n  - verify: npm test"
  const run = await engine.start("s1", source, "inline")
  await until(() => host.sessionForTask("t1") !== undefined, 3000, "worker")
  host.finishTask("t1", "[task:done] implemented")
  await until(() => run.status === "completed", 3000, "completed")
  assert.equal(host.gateCalls.length, 1)
  assert.equal(host.gateCalls[0]!.command, "npm test")
  assert.ok(host.gateCalls[0]!.directory.includes("wt-"))
})

test("a failing gate pauses the run when retries are exhausted", async () => {
  const host = new FakeHost()
  host.gateQueue = [{ ok: false, output: "boom", exitCode: 1, timedOut: false }]
  const engine = new Engine(normalizeOptions({ maxConcurrency: 1, maxAttempts: 1 }), host)
  const source = "- [ ] a\n  - files: a.txt\n  - verify: npm test"
  const run = await engine.start("s1", source, "inline")
  await until(() => host.sessionForTask("t1") !== undefined, 3000, "worker")
  host.finishTask("t1", "[task:done] attempted")
  await until(() => run.status === "paused", 3000, "paused")
  assert.equal(run.tasks[0]!.status, "failed")
  assert.ok(host.notes.some((n) => n.includes("failed")))
})

test("a failing gate retries once, then completes when the gate passes", async () => {
  const host = new FakeHost()
  host.gateQueue = [
    { ok: false, output: "first failure", exitCode: 1, timedOut: false },
    { ok: true, output: "ok", exitCode: 0, timedOut: false },
  ]
  const engine = new Engine(normalizeOptions({ maxConcurrency: 1, maxAttempts: 2 }), host)
  const source = "- [ ] a\n  - files: a.txt\n  - verify: npm test"
  const run = await engine.start("s1", source, "inline")

  await until(() => host.sessionForTask("t1") !== undefined, 3000, "first worker")
  host.finishTask("t1", "[task:done] first try")
  await until(() => host.gateCalls.length === 1, 3000, "first gate")
  await until(() => host.sessionForTask("t1") !== undefined, 3000, "retry worker")
  host.finishTask("t1", "[task:done] second try")
  await until(() => run.status === "completed", 3000, "completed")
  assert.equal(run.tasks[0]!.attempts, 1)
})

test("a worker that reports blocked pauses the run", async () => {
  const host = new FakeHost()
  const engine = new Engine(normalizeOptions({ maxConcurrency: 1 }), host)
  const run = await engine.start("s1", "- [ ] a\n  - files: a.txt", "inline")
  await until(() => host.sessionForTask("t1") !== undefined, 3000, "worker")
  host.finishTask("t1", "[task:blocked] missing production API token")
  await until(() => run.status === "paused", 3000, "paused")
  assert.equal(run.tasks[0]!.status, "blocked")
  assert.match(run.tasks[0]!.lastError ?? "", /token/)
})

test("the mailbox delivers an orchestrator message to a running worker", async () => {
  const host = new FakeHost()
  const engine = new Engine(normalizeOptions({ maxConcurrency: 1 }), host)
  const run = await engine.start("s1", "- [ ] a\n  - files: a.txt", "inline")
  await until(() => host.sessionForTask("t1") !== undefined, 3000, "worker")
  const sessionID = host.sessionForTask("t1")!

  const sent = await engine.send("s1", "t1", "please also update the changelog")
  assert.equal(sent, true)
  assert.equal(host.steers.length, 1)
  assert.match(host.steers[0]!.text, /changelog/)

  const inbox = await engine.inbox(sessionID)
  assert.equal(inbox.length, 1)
  assert.match(inbox[0]!.text, /changelog/)

  host.finishTask("t1", "[task:done] done")
  await until(() => run.status === "completed", 3000, "completed")
})

test("worker_report records a mailbox report for the owning task", async () => {
  const host = new FakeHost()
  const engine = new Engine(normalizeOptions({ maxConcurrency: 1 }), host)
  const run = await engine.start("s1", "- [ ] a\n  - files: a.txt", "inline")
  await until(() => host.sessionForTask("t1") !== undefined, 3000, "worker")
  const sessionID = host.sessionForTask("t1")!

  const ok = await engine.report(sessionID, { status: "progress", note: "halfway" })
  assert.equal(ok, true)
  assert.equal(await engine.report("nobody", { status: "progress" }), false)
  assert.equal(run.tasks[0]!.reports?.length, 1)

  host.finishTask("t1", "[task:done] done")
  await until(() => run.status === "completed", 3000, "completed")
})

test("a recovered run loads paused and resume restarts it", async () => {
  const host = new FakeHost()
  const options = normalizeOptions({ maxConcurrency: 1 })
  const engine1 = new Engine(options, host)
  const run = await engine1.start("s1", "- [ ] a\n  - files: a.txt", "inline")
  assert.equal(run.status, "running")

  // Simulate a restart: a fresh store loads the same snapshot.
  const engine2 = new Engine(options, host)
  await engine2.load()
  const recovered = engine2.store.active("s1")
  assert.ok(recovered)
  assert.equal(recovered!.status, "paused")

  const resumed = await engine2.resume("s1")
  assert.ok(resumed)
  assert.equal(resumed!.status, "running")
  await until(() => host.sessionForTask("t1") !== undefined, 3000, "worker after resume")
  // Clean up the background loop.
  await engine2.abort("s1")
})

test("resume un-skips tasks that were skipped only because a dependency failed", async () => {
  const host = new FakeHost()
  host.gateQueue = [{ ok: false, output: "boom", exitCode: 1, timedOut: false }]
  const engine = new Engine(normalizeOptions({ maxConcurrency: 1, maxAttempts: 1 }), host)
  const source =
    "- [ ] a\n  - files: a.txt\n  - verify: npm test\n- [ ] b\n  - files: b.txt\n  - deps: 1"
  const run = await engine.start("s1", source, "inline")
  await until(() => host.sessionForTask("t1") !== undefined, 3000, "worker")
  host.finishTask("t1", "[task:done] attempted")
  await until(() => run.status === "paused", 3000, "paused")
  assert.equal(run.tasks[1]!.status, "skipped")

  const resumed = await engine.resume("s1")
  assert.ok(resumed)
  assert.equal(resumed!.tasks.find((t) => t.id === "t2")!.status, "pending")
  await engine.abort("s1")
})
