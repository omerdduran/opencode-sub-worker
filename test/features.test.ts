import { test } from "node:test"
import assert from "node:assert/strict"
import { Engine } from "../src/core/engine.ts"
import { normalizeOptions } from "../src/core/options.ts"
import { FakeHost, until } from "./helpers.ts"

test("write-scope permissions are passed to the worker session", async () => {
  const host = new FakeHost()
  const engine = new Engine(normalizeOptions({ maxConcurrency: 1 }), host)
  await engine.start("s1", "- [ ] a\n  - files: src/a.ts, src/b.ts", "inline")
  await until(() => host.specForTask("t1") !== undefined, 3000, "worker")
  const spec = host.specForTask("t1")!
  assert.ok(spec.permissions, "expected a permission ruleset")
  assert.equal(spec.permissions![0]!.action, "edit")
  assert.equal(spec.permissions![0]!.effect, "deny")
  assert.equal(spec.permissions![0]!.resource, "*")
  const allowed = spec.permissions!.filter((r) => r.effect === "allow").map((r) => r.resource)
  assert.deepEqual(allowed.sort(), ["src/a.ts", "src/b.ts"])
  await engine.abort("s1")
})

test("write-scope permissions are omitted when enforcement is off", async () => {
  const host = new FakeHost()
  const engine = new Engine(normalizeOptions({ maxConcurrency: 1, enforceWriteScope: false }), host)
  await engine.start("s1", "- [ ] a\n  - files: src/a.ts", "inline")
  await until(() => host.specForTask("t1") !== undefined, 3000, "worker")
  assert.equal(host.specForTask("t1")!.permissions, undefined)
  await engine.abort("s1")
})

test("a worker that touches undeclared files fails the diff-scope check", async () => {
  const host = new FakeHost()
  host.changed = ["src/a.ts", "src/rogue.ts"]
  const engine = new Engine(normalizeOptions({ maxConcurrency: 1, maxAttempts: 1 }), host)
  const run = await engine.start("s1", "- [ ] a\n  - files: src/a.ts", "inline")
  await until(() => host.sessionForTask("t1") !== undefined, 3000, "worker")
  host.finishTask("t1", "[task:done] did stuff")
  await until(() => run.status === "paused", 3000, "paused")
  assert.equal(run.tasks[0]!.status, "failed")
  assert.deepEqual(run.tasks[0]!.scopeViolations, ["src/rogue.ts"])
})

test("a worker that stays in scope passes the diff-scope check", async () => {
  const host = new FakeHost()
  host.changed = ["src/a.ts", "src/deep/b.ts"]
  const engine = new Engine(normalizeOptions({ maxConcurrency: 1 }), host)
  const run = await engine.start("s1", "- [ ] a\n  - files: src/**", "inline")
  await until(() => host.sessionForTask("t1") !== undefined, 3000, "worker")
  host.finishTask("t1", "[task:done] fine")
  await until(() => run.status === "completed", 3000, "completed")
  assert.equal(run.tasks[0]!.status, "done")
})

test("continueOnError lets independent tasks finish after one fails", async () => {
  const host = new FakeHost()
  host.gateQueue = [{ ok: false, output: "boom", exitCode: 1, timedOut: false }]
  const engine = new Engine(
    normalizeOptions({ maxConcurrency: 1, maxAttempts: 1, continueOnError: true }),
    host,
  )
  const source = "- [ ] a\n  - files: a.txt\n  - verify: npm test\n- [ ] b\n  - files: b.txt"
  const run = await engine.start("s1", source, "inline")
  await until(() => host.sessionForTask("t1") !== undefined, 3000, "a")
  host.finishTask("t1", "[task:done] attempted")
  await until(() => run.tasks[0]!.status === "failed", 3000, "a failed")
  await until(() => host.sessionForTask("t2") !== undefined, 3000, "b started")
  host.finishTask("t2", "[task:done] b")
  await until(() => run.status === "failed", 3000, "run failed")
  assert.equal(run.tasks[1]!.status, "done")
})

test("requireWorktrees fails closed when a worktree cannot be created", async () => {
  const host = new FakeHost()
  host.failWorktree = true
  const engine = new Engine(
    normalizeOptions({ maxConcurrency: 1, maxAttempts: 1, requireWorktrees: true }),
    host,
  )
  const run = await engine.start("s1", "- [ ] a\n  - files: a.txt", "inline")
  await until(() => run.status === "paused", 3000, "paused")
  assert.equal(run.tasks[0]!.status, "failed")
  assert.match(run.tasks[0]!.lastError ?? "", /worktree required/)
  assert.equal(host.workers.size, 0)
})

test("worktree failure is tolerated when requireWorktrees is off", async () => {
  const host = new FakeHost()
  host.failWorktree = true
  const engine = new Engine(
    normalizeOptions({ maxConcurrency: 1, requireWorktrees: false }),
    host,
  )
  const run = await engine.start("s1", "- [ ] a\n  - files: a.txt", "inline")
  await until(() => host.sessionForTask("t1") !== undefined, 3000, "worker")
  assert.equal(host.specForTask("t1")!.isolated, false)
  host.finishTask("t1", "[task:done] in place")
  await until(() => run.status === "completed", 3000, "completed")
})

test("start refuses a dependency cycle", async () => {
  const host = new FakeHost()
  const engine = new Engine(normalizeOptions({}), host)
  await assert.rejects(
    () => engine.start("s1", "- [ ] a\n  - deps: 2\n- [ ] b\n  - deps: 1", "inline"),
    /cycle/,
  )
  assert.equal(host.workers.size, 0)
})

test("an independent verifier can reject a task", async () => {
  const host = new FakeHost()
  const engine = new Engine(
    normalizeOptions({ maxConcurrency: 1, maxAttempts: 1, verifierEnabled: true, verifierAgent: "explore" }),
    host,
  )
  const run = await engine.start("s1", "- [ ] a\n  - files: a.txt", "inline")
  await until(() => host.sessionForTask("t1") !== undefined, 3000, "worker")
  host.finishTask("t1", "[task:done] wrote a")
  await until(() => host.sessionForTask("verify-t1") !== undefined, 3000, "verifier")
  assert.equal(host.specForTask("verify-t1")!.agent, "explore")
  host.finishTask("verify-t1", "[task:blocked] the change is wrong")
  await until(() => run.status === "paused", 3000, "paused")
  assert.equal(run.tasks[0]!.status, "failed")
  assert.match(run.tasks[0]!.lastError ?? "", /verifier rejected/)
})

test("a passing verifier lets the task complete", async () => {
  const host = new FakeHost()
  const engine = new Engine(
    normalizeOptions({ maxConcurrency: 1, verifierEnabled: true }),
    host,
  )
  const run = await engine.start("s1", "- [ ] a\n  - files: a.txt", "inline")
  await until(() => host.sessionForTask("t1") !== undefined, 3000, "worker")
  host.finishTask("t1", "[task:done] wrote a")
  await until(() => host.sessionForTask("verify-t1") !== undefined, 3000, "verifier")
  host.finishTask("verify-t1", "[task:done] looks correct")
  await until(() => run.status === "completed", 3000, "completed")
  assert.equal(run.tasks[0]!.status, "done")
})

test("the run pauses when the cost budget is exceeded", async () => {
  const host = new FakeHost()
  host.stats = { cost: 5, tokens: 0 }
  const engine = new Engine(normalizeOptions({ maxConcurrency: 1, maxCostUsd: 1 }), host)
  const run = await engine.start("s1", "- [ ] a\n  - files: a.txt", "inline")
  await until(() => host.sessionForTask("t1") !== undefined, 3000, "worker")
  host.finishTask("t1", "[task:done] a")
  await until(() => run.status === "paused", 3000, "paused")
  assert.match(run.stopReason, /budget/)
  assert.ok(run.cost >= 5)
})

test("per-task and per-role models are routed to the worker", async () => {
  const host = new FakeHost()
  const engine = new Engine(normalizeOptions({ maxConcurrency: 1 }), host)
  await engine.start("s1", "- [ ] a\n  - files: a.txt\n  - model: openai/gpt-4o", "inline")
  await until(() => host.specForTask("t1") !== undefined, 3000, "worker")
  assert.deepEqual(host.specForTask("t1")!.model, { providerID: "openai", modelID: "gpt-4o" })
  await engine.abort("s1")

  const host2 = new FakeHost()
  const engine2 = new Engine(
    normalizeOptions({ maxConcurrency: 1, roleModels: { reviewer: "anthropic/claude-x" } }),
    host2,
  )
  await engine2.start("s2", "- [ ] a\n  - files: a.txt\n  - agent: reviewer", "inline")
  await until(() => host2.specForTask("t1") !== undefined, 3000, "worker")
  assert.deepEqual(host2.specForTask("t1")!.model, { providerID: "anthropic", modelID: "claude-x" })
  await engine2.abort("s2")
})

test("askUserOnBlocked keeps the worker alive for an answer, then completes", async () => {
  const host = new FakeHost()
  const engine = new Engine(normalizeOptions({ maxConcurrency: 1, askUserOnBlocked: true }), host)
  const run = await engine.start("s1", "- [ ] a\n  - files: a.txt", "inline")
  await until(() => host.sessionForTask("t1") !== undefined, 3000, "worker")
  host.finishTask("t1", "[task:blocked] need an API key")
  await until(() => run.status === "paused" && run.stopReason.includes("awaiting answer"), 3000, "awaiting")
  const task = run.tasks[0]!
  assert.equal(task.status, "blocked")
  assert.ok(task.sessionID, "worker session should be kept alive")

  const ok = await engine.answer("s1", "t1", "use the test key")
  assert.equal(ok, true)
  assert.equal(task.status, "running")
  assert.equal(host.steers.length, 1)
  assert.match(host.steers[0]!.text, /test key/)

  host.finishTask("t1", "[task:done] done with the test key")
  await until(() => run.status === "completed", 3000, "completed")
})

test("worker changes are committed before merging", async () => {
  const host = new FakeHost()
  const engine = new Engine(normalizeOptions({ maxConcurrency: 1 }), host)
  const run = await engine.start("s1", "- [ ] a\n  - files: a.txt", "inline")
  await until(() => host.sessionForTask("t1") !== undefined, 3000, "worker")
  host.finishTask("t1", "[task:done] a")
  await until(() => run.status === "completed", 3000, "completed")
  assert.equal(host.commits.length, 1)
  assert.match(host.commits[0]!.message, /sub-worker: t1/)
  assert.equal(host.merged.length, 1)
})

test("the worktree is kept for review when autoMerge is off", async () => {
  const host = new FakeHost()
  const engine = new Engine(normalizeOptions({ maxConcurrency: 1, autoMerge: false }), host)
  const run = await engine.start("s1", "- [ ] a\n  - files: a.txt", "inline")
  await until(() => host.sessionForTask("t1") !== undefined, 3000, "worker")
  host.finishTask("t1", "[task:done] a")
  await until(() => run.status === "completed", 3000, "completed")
  assert.equal(host.merged.length, 0)
  assert.equal(host.worktrees.length, 1)
  assert.ok(run.tasks[0]!.worktree, "the worktree path should be retained")
  assert.ok(run.history.some((h) => h.type === "worktree-kept"))
})
