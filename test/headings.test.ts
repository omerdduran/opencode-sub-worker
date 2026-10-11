import { test } from "node:test"
import assert from "node:assert/strict"
import { Engine } from "../src/core/engine.ts"
import { DEFAULT_FIELDS, normalizeOptions } from "../src/core/options.ts"
import { parseHeadings } from "../src/core/parse-headings.ts"
import { FakeHost, until } from "./helpers.ts"

const SAMPLE = `---
feature: demo
source_prd: myne-agents/features/demo/prd.md
issue: "myne-md/myne#123"
kind: ui
---

## Tasks

### 1. [ ] Add the resolver
- **Stories:** 1, 3
- **TDD:** yes
- **Risk:** 🟠
- **Files:** \`core/src/a.rs\`, \`core/src/a_test.rs\`
- **Spec & identifiers in scope:** \`docs/spec/x.md\` §2
- **Out of scope:** the wrap path
- **What to build:** do the thing.
- **How verified (end-to-end):** cargo test -p core a
- **Acceptance criteria:**
  - [ ] it resolves
  - [ ] it is cached

### 2. [ ] [design] Render the panel
- **Stories:** 2
- **TDD:** no (UI)
- **Risk:** 🟢
- **Files:** src/panel.tsx

### 3. [ ] Bind the AAD prefix
- **Files:** protocol/src/aad.rs
- **Risk:** 🔴
- **[NEEDS DECISION: before or after the pipe?]**
`

test("parseHeadings reads frontmatter, fields, files, risk, stories and acceptance", () => {
  const result = parseHeadings(SAMPLE, DEFAULT_FIELDS)
  assert.equal(result.meta["feature"], "demo")
  assert.equal(result.meta["issue"], "myne-md/myne#123")
  assert.equal(result.tasks.length, 3)

  const t1 = result.tasks[0]!
  assert.equal(t1.id, "1")
  assert.equal(t1.title, "Add the resolver")
  assert.deepEqual(t1.files, ["core/src/a.rs", "core/src/a_test.rs"])
  assert.equal(t1.risk, "🟠")
  assert.deepEqual(t1.stories, [1, 3])
  assert.equal(t1.tdd, "yes")
  assert.equal(t1.verify, null)
  assert.deepEqual(t1.acceptance, ["it resolves", "it is cached"])
  assert.match(t1.whatToBuild ?? "", /do the thing/)
  assert.match(t1.spec ?? "", /docs\/spec\/x\.md/)

  const t2 = result.tasks[1]!
  assert.equal(t2.title, "Render the panel")
  assert.equal(t2.design, true)
  assert.equal(t2.risk, "🟢")

  const t3 = result.tasks[2]!
  assert.equal(t3.risk, "🔴")
  assert.match(t3.raw ?? "", /NEEDS DECISION/)
})

test("a field label can be remapped", () => {
  const source = "### 1. [ ] x\n- **Touches:** `a.ts`, `b.ts`\n"
  const result = parseHeadings(source, { ...DEFAULT_FIELDS, files: ["touches"] })
  assert.deepEqual(result.tasks[0]!.files, ["a.ts", "b.ts"])
})

test("sequentialDeps turns file order into the dependency chain", () => {
  const options = normalizeOptions({ taskFormat: "headings", sequentialDeps: true })
  const engine = new Engine(options, new FakeHost())
  // Reach into the engine's parser through a plan, which is side-effect free.
  const plan = engine.planText(SAMPLE, "inline")
  assert.match(plan, /wave 1: 1/)
  assert.match(plan, /wave 2: 2/)
  assert.match(plan, /wave 3: 3/)
})

test("a [NEEDS DECISION] task is held and pauses the run", async () => {
  const host = new FakeHost()
  const engine = new Engine(normalizeOptions({ taskFormat: "headings", maxConcurrency: 2 }), host)
  const source = "### 1. [ ] x\n- **Files:** `a.ts`\n- **[NEEDS DECISION: choose A or B]**\n"
  const run = await engine.start("s1", source, "inline")
  await until(() => run.status === "paused", 3000, "paused")
  assert.match(run.stopReason, /held/)
  assert.equal(run.tasks[0]!.held, true)
  assert.equal(host.workers.size, 0)
})

test("mode assist forces the merge behaviours off", () => {
  const options = normalizeOptions({ mode: "assist" })
  assert.equal(options.autoMerge, false)
  assert.equal(options.commitBeforeMerge, false)
  assert.equal(options.cleanupWorktrees, false)
})

test("flipCheckboxes writes [x] back to the source list", async () => {
  const host = new FakeHost()
  host.files.set("/repo/TASKS.md", SAMPLE)
  const engine = new Engine(
    normalizeOptions({ taskFormat: "headings", autoMerge: false, flipCheckboxes: true }),
    host,
  )
  const run = await engine.start("s1", SAMPLE, "TASKS.md")
  await until(() => host.sessionForTask("1") !== undefined, 3000, "worker")
  host.finishTask("1", "[task:done] did it")
  await until(() => run.tasks[0]!.status === "done", 3000, "done")
  const updated = host.files.get("/repo/TASKS.md") ?? ""
  assert.match(updated, /### 1\. \[x\] Add the resolver/)
  await engine.abort("s1")
})

test("progressFile receives an appended block", async () => {
  const host = new FakeHost()
  host.files.set("/repo/TASKS.md", SAMPLE)
  const engine = new Engine(
    normalizeOptions({ taskFormat: "headings", autoMerge: false, progressFile: "features/demo/progress.md" }),
    host,
  )
  const run = await engine.start("s1", SAMPLE, "TASKS.md")
  await until(() => host.sessionForTask("1") !== undefined, 3000, "worker")
  host.finishTask("1", "[task:done] evidence here")
  await until(() => run.tasks[0]!.status === "done", 3000, "done")
  const appended = host.files.get("/repo/features/demo/progress.md") ?? ""
  assert.match(appended, /## 1: Add the resolver/)
  assert.match(appended, /evidence here/)
  await engine.abort("s1")
})

test("detectCompletion checkboxes trusts a flipped box in the source", async () => {
  const source = "### 1. [ ] do it\n- **Files:** `a.ts`\n"
  const flipped = "### 1. [x] do it\n- **Files:** `a.ts`\n"
  const host = new FakeHost()
  host.files.set("/repo/TASKS.md", flipped)
  const engine = new Engine(
    normalizeOptions({ taskFormat: "headings", detectCompletion: "checkboxes", autoMerge: false }),
    host,
  )
  const run = await engine.start("s1", source, "TASKS.md")
  await until(() => host.sessionForTask("1") !== undefined, 3000, "worker")
  // The worker's report says nothing; the flipped checkbox is the signal.
  host.finishTask("1", "still working, no report")
  await until(() => run.tasks[0]!.status === "done", 3000, "done")
  await engine.abort("s1")
})

test("worker instructions, skills and contract injection reach the prompt", async () => {
  const host = new FakeHost()
  const engine = new Engine(
    normalizeOptions({
      maxConcurrency: 1,
      workerInstructions: "PROJECT RULE: never commit.",
      workerSkills: ["do-work"],
      workerContract: "none",
    }),
    host,
  )
  await engine.start("s1", "- [ ] a\n  - files: a.txt", "inline")
  await until(() => host.specForTask("t1") !== undefined, 3000, "worker")
  const prompt = host.specForTask("t1")!.prompt
  assert.match(prompt, /PROJECT RULE: never commit\./)
  assert.match(prompt, /do-work/)
  assert.doesNotMatch(prompt, /fenced JSON report/)
  await engine.abort("s1")
})

test("a custom parser option replaces the built-in adapters", async () => {
  const host = new FakeHost()
  const options = normalizeOptions({ maxConcurrency: 1 })
  options.customParser = (source: string) => ({
    tasks: [
      {
        id: "custom",
        index: 1,
        title: source.trim(),
        checkedInSource: false,
        files: ["a.txt"],
        verify: null,
        deps: [],
        status: "pending",
        attempts: 0,
      },
    ],
    errors: [],
  })
  const engine = new Engine(options, host)
  const run = await engine.start("s1", "whatever", "inline")
  assert.equal(run.tasks[0]!.id, "custom")
  await until(() => host.sessionForTask("custom") !== undefined, 3000, "worker")
  host.finishTask("custom", "[task:done] ok")
  await until(() => run.status === "completed", 3000, "completed")
})
