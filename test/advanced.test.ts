import { test } from "node:test"
import assert from "node:assert/strict"
import { Engine } from "../src/core/engine.ts"
import { normalizeOptions } from "../src/core/options.ts"
import { buildCommands, subscribeProgress, type CliContext, type RpcClient } from "../src/tui-commands.ts"
import { FakeHost, until } from "./helpers.ts"

test("a high-risk task waits for approval, then integrates on approve", async () => {
  const host = new FakeHost()
  const engine = new Engine(normalizeOptions({ maxConcurrency: 1, approvalRisks: ["high"] }), host)
  const run = await engine.start("s1", "- [ ] risky\n  - files: a.txt\n  - risk: high", "inline")
  await until(() => host.sessionForTask("t1") !== undefined, 3000, "worker")
  host.finishTask("t1", "[task:done] did it")
  await until(() => run.tasks[0]!.status === "review", 3000, "review")
  assert.equal(run.status, "paused")
  assert.equal(host.merged.length, 0)

  const ok = await engine.approve("s1", "t1")
  assert.equal(ok, true)
  await until(() => run.status === "completed", 3000, "completed")
  assert.equal(run.tasks[0]!.status, "done")
  assert.equal(host.merged.length, 1)
  assert.equal(host.worktrees.length, 0)
})

test("a rejected task is blocked and never merged", async () => {
  const host = new FakeHost()
  const engine = new Engine(normalizeOptions({ maxConcurrency: 1, approvalRisks: ["high"] }), host)
  const run = await engine.start("s1", "- [ ] risky\n  - files: a.txt\n  - risk: high", "inline")
  await until(() => host.sessionForTask("t1") !== undefined, 3000, "worker")
  host.finishTask("t1", "[task:done] did it")
  await until(() => run.tasks[0]!.status === "review", 3000, "review")
  const ok = await engine.reject("s1", "t1", "not safe")
  assert.equal(ok, true)
  await until(() => run.status === "failed", 3000, "failed")
  assert.equal(run.tasks[0]!.status, "blocked")
  assert.equal(host.merged.length, 0)
})

test("integration is idempotent: a resume does not merge an integrated task twice", async () => {
  const host = new FakeHost()
  const engine = new Engine(normalizeOptions({ maxConcurrency: 1 }), host)
  const run = await engine.start("s1", "- [ ] a\n  - files: a.txt", "inline")
  await until(() => host.sessionForTask("t1") !== undefined, 3000, "worker")
  host.finishTask("t1", "[task:done] a")
  await until(() => run.status === "completed", 3000, "completed")
  assert.equal(host.merged.length, 1)
  assert.equal(run.tasks[0]!.integrated, true)

  // Simulate a crash-resume that reopens the run with the task still pending.
  run.status = "paused"
  run.tasks[0]!.status = "pending"
  const resumed = await engine.resume("s1")
  assert.ok(resumed)
  await until(() => resumed!.status === "completed", 3000, "completed again")
  assert.equal(host.merged.length, 1, "the integrated task must not be merged twice")
})

test("resume disposes a session kept for a blocked answer", async () => {
  const host = new FakeHost()
  const engine = new Engine(normalizeOptions({ maxConcurrency: 1, askUserOnBlocked: true }), host)
  const run = await engine.start("s1", "- [ ] a\n  - files: a.txt", "inline")
  await until(() => host.sessionForTask("t1") !== undefined, 3000, "worker")
  host.finishTask("t1", "[task:blocked] need a key")
  await until(() => run.stopReason.includes("awaiting answer"), 3000, "awaiting")
  const kept = run.tasks[0]!.sessionID!
  assert.ok(kept)
  await engine.resume("s1")
  assert.equal(host.workers.has(kept), false, "the kept session must be disposed")
  await engine.abort("s1")
})

test("taskforce_diff shows the retained worktree diff, and logs show the gate output", async () => {
  const host = new FakeHost()
  host.diff = "diff --git a/a.txt b/a.txt"
  host.gateQueue = [{ ok: true, output: "all good", exitCode: 0, timedOut: false }]
  const engine = new Engine(normalizeOptions({ maxConcurrency: 1, autoMerge: false }), host)
  const run = await engine.start("s1", "- [ ] a\n  - files: a.txt\n  - verify: npm test", "inline")
  await until(() => host.sessionForTask("t1") !== undefined, 3000, "worker")
  host.finishTask("t1", "[task:done] a")
  await until(() => run.status === "completed", 3000, "completed")

  const diff = await engine.diffText("s1", "t1")
  assert.match(diff, /diff --git a\/a.txt/)
  assert.match(diff, /branch branch-t-t1/)

  const logs = engine.logsText("s1", "t1")
  assert.match(logs, /Gate output/)
  assert.match(logs, /all good/)
})

test("taskforce_add appends tasks to a completed run and they execute", async () => {
  const host = new FakeHost()
  const engine = new Engine(normalizeOptions({ maxConcurrency: 2 }), host)
  const run = await engine.start("s1", "- [ ] a\n  - files: a.txt", "inline")
  await until(() => host.sessionForTask("t1") !== undefined, 3000, "a")
  host.finishTask("t1", "[task:done] a")
  await until(() => run.status === "completed", 3000, "completed")

  const added = await engine.add("s1", "- [ ] b\n  - id: tb\n  - files: b.txt", "inline")
  assert.ok(added)
  assert.equal(added!.tasks.length, 2)
  assert.ok(added!.tasks.some((t) => t.id === "tb"))
  await until(() => host.sessionForTask("tb") !== undefined, 3000, "b")
  host.finishTask("tb", "[task:done] b")
  await until(() => run.status === "completed", 3000, "completed again")
})

test("taskforce_broadcast reaches every running worker", async () => {
  const host = new FakeHost()
  const engine = new Engine(normalizeOptions({ maxConcurrency: 2 }), host)
  await engine.start("s1", "- [ ] a\n  - files: a.txt\n- [ ] b\n  - files: b.txt", "inline")
  await until(() => host.workers.size === 2, 3000, "two workers")
  const reached = await engine.broadcast("s1", "heads up")
  assert.equal(reached, 2)
  assert.equal(host.steers.length, 2)
  await engine.abort("s1")
})

test("co-change learning serializes files that historically change together", async () => {
  const host = new FakeHost()
  const engine = new Engine(
    normalizeOptions({ maxConcurrency: 2, coChangeLearning: true, coChangeMinCount: 2 }),
    host,
  )
  engine.cochange.record(["a.ts", "b.ts"])
  engine.cochange.record(["a.ts", "b.ts"])

  const run = await engine.start("s1", "- [ ] x\n  - files: a.ts\n- [ ] y\n  - files: b.ts", "inline")
  await until(() => host.workers.size === 1, 3000, "one worker")
  assert.equal(host.runningTaskIDs().length, 1)
  host.finishTask("t1", "[task:done] x")
  await until(() => host.sessionForTask("t2") !== undefined, 3000, "second worker")
  host.finishTask("t2", "[task:done] y")
  await until(() => run.status === "completed", 3000, "completed")
})

test("a retry rotates to the next fallback model", async () => {
  const host = new FakeHost()
  host.gateQueue = [
    { ok: false, output: "boom", exitCode: 1, timedOut: false },
    { ok: true, output: "ok", exitCode: 0, timedOut: false },
  ]
  const engine = new Engine(
    normalizeOptions({
      maxConcurrency: 1,
      maxAttempts: 2,
      repairOnFailure: false,
      fallbackModels: ["anthropic/haiku", "openai/mini"],
    }),
    host,
  )
  const run = await engine.start("s1", "- [ ] a\n  - files: a.txt\n  - verify: npm test", "inline")
  await until(() => host.sessionForTask("t1") !== undefined, 3000, "worker")
  host.finishTask("t1", "[task:done] a")
  await until(() => run.tasks[0]!.attempts === 1, 3000, "attempt 1")
  await until(() => host.specForTask("t1")?.model?.providerID === "anthropic", 3000, "fallback model")
  host.finishTask("t1", "[task:done] a2")
  await until(() => run.status === "completed", 3000, "completed")
})

test("a worker's JSON report drives completion and evidence", async () => {
  const host = new FakeHost()
  const engine = new Engine(normalizeOptions({ maxConcurrency: 1 }), host)
  const run = await engine.start("s1", "- [ ] a\n  - files: a.txt", "inline")
  await until(() => host.sessionForTask("t1") !== undefined, 3000, "worker")
  host.finishTask("t1", '```json\n{"status":"done","evidence":"json evidence"}\n```')
  await until(() => run.status === "completed", 3000, "completed")
  assert.match(run.tasks[0]!.evidence ?? "", /json evidence/)
})

test("session titles mirror run status when enabled", async () => {
  const host = new FakeHost()
  const engine = new Engine(normalizeOptions({ maxConcurrency: 1, mirrorSessionTitles: true }), host)
  const run = await engine.start("s1", "- [ ] a\n  - files: a.txt", "inline")
  await until(() => host.titles.length > 0, 3000, "title")
  assert.match(host.titles[0]!.title, /tasks/)
  await until(() => host.sessionForTask("t1") !== undefined, 3000, "worker")
  host.finishTask("t1", "[task:done] a")
  await until(() => run.status === "completed", 3000, "completed")
  assert.ok(host.titles.some((t) => t.title.includes("completed")))
})

test("the engine emits lifecycle events", async () => {
  const events: string[] = []
  const host = new FakeHost()
  const engine = new Engine(normalizeOptions({ maxConcurrency: 1 }), host, (event) => events.push(event.type))
  const run = await engine.start("s1", "- [ ] a\n  - files: a.txt", "inline")
  await until(() => host.sessionForTask("t1") !== undefined, 3000, "worker")
  host.finishTask("t1", "[task:done] a")
  await until(() => run.status === "completed", 3000, "completed")
  assert.ok(events.includes("run.started"))
  assert.ok(events.includes("task.launched"))
  assert.ok(events.includes("task.done"))
  assert.ok(events.includes("run.completed"))
})

test("priority ordering starts the higher-priority task first", async () => {
  const host = new FakeHost()
  const engine = new Engine(normalizeOptions({ maxConcurrency: 1 }), host)
  const source = "- [ ] low\n  - files: a.txt\n- [ ] high\n  - files: b.txt\n  - priority: 10"
  const run = await engine.start("s1", source, "inline")
  await until(() => host.workers.size === 1, 3000, "one worker")
  assert.equal(host.sessionForTask("t2") !== undefined, true, "the high-priority task starts first")
  host.finishTask("t2", "[task:done] high")
  await until(() => host.sessionForTask("t1") !== undefined, 3000, "low")
  host.finishTask("t1", "[task:done] low")
  await until(() => run.status === "completed", 3000, "completed")
})

test("the bundled CLI plugin exposes panel/status commands and subscribes to progress", () => {
  const subscribed: string[] = []
  const rpc: RpcClient = {
    status: async () => ({ json: '{"status":"none"}' }),
    events: {
      on: (name: string) => {
        subscribed.push(name)
        return () => {}
      },
    },
  }
  const context: CliContext = {
    ui: { router: { current: () => ({ type: "session", sessionID: "s1" }) } },
  }
  const commands = buildCommands(context, rpc)
  const ids = commands.map((c) => c.id)
  assert.ok(ids.includes("opencode-sub-worker.panel"))
  assert.ok(ids.includes("opencode-sub-worker.status"))

  const unsubscribe = subscribeProgress(context, rpc)
  assert.equal(typeof unsubscribe, "function")
  assert.deepEqual(subscribed, ["progress"])
  unsubscribe()
})
