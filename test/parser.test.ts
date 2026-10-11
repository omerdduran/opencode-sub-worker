import { test } from "node:test"
import assert from "node:assert/strict"
import { parseChecklist } from "../src/core/parser.ts"

test("parses a basic checklist with two tasks", () => {
  const { tasks, errors } = parseChecklist("- [ ] first\n- [x] second")
  assert.equal(tasks.length, 2)
  assert.equal(errors.length, 0)
  assert.equal(tasks[0]!.id, "t1")
  assert.equal(tasks[0]!.title, "first")
  assert.equal(tasks[0]!.checkedInSource, false)
  assert.equal(tasks[1]!.checkedInSource, true)
})

test("parses files, normalizes separators, and drops blanks", () => {
  const { tasks } = parseChecklist("- [ ] a\n  - files: src\\a.ts, ./b.ts ,, src/c.ts")
  assert.deepEqual(tasks[0]!.files, ["src/a.ts", "b.ts", "src/c.ts"])
})

test("resolves deps by 1-based index and by id", () => {
  const { tasks, errors } = parseChecklist(
    ["- [ ] a", "  - id: alpha", "- [ ] b", "  - deps: 1", "- [ ] c", "  - deps: alpha"].join("\n"),
  )
  assert.equal(errors.length, 0)
  assert.deepEqual(tasks[1]!.deps, ["alpha"])
  assert.deepEqual(tasks[2]!.deps, ["alpha"])
})

test("reports an unknown dependency but keeps parsing", () => {
  const { tasks, errors } = parseChecklist("- [ ] a\n  - deps: nope")
  assert.equal(tasks.length, 1)
  assert.equal(tasks[0]!.deps.length, 0)
  assert.ok(errors.some((e) => e.includes("unknown id")))
})

test("reports a duplicate id with a suffix", () => {
  const { tasks, errors } = parseChecklist("- [ ] a\n  - id: x\n- [ ] b\n  - id: x")
  assert.equal(tasks[0]!.id, "x")
  assert.equal(tasks[1]!.id, "x-2")
  assert.ok(errors.some((e) => e.includes("duplicate")))
})

test("verify: false disables the gate; timeout parses units", () => {
  const { tasks } = parseChecklist("- [ ] a\n  - verify: false\n  - timeout: 90s")
  assert.equal(tasks[0]!.verify, null)
  assert.equal(tasks[0]!.timeoutMs, 90_000)
})

test("a task with no files has an empty write set", () => {
  const { tasks } = parseChecklist("- [ ] a")
  assert.deepEqual(tasks[0]!.files, [])
})

test("empty input reports an error", () => {
  const { tasks, errors } = parseChecklist("# just a heading\nsome prose")
  assert.equal(tasks.length, 0)
  assert.ok(errors.some((e) => e.includes("no tasks")))
})

test("asterisk bullets and nested checkboxes are both recognised", () => {
  const { tasks } = parseChecklist("* [ ] top\n  - [ ] nested\n    - files: n.txt")
  assert.equal(tasks.length, 2)
  assert.deepEqual(tasks[1]!.files, ["n.txt"])
})

test("parses named locks and priority", () => {
  const { tasks } = parseChecklist("- [ ] a\n  - locks: db, staging\n  - priority: 5")
  assert.deepEqual(tasks[0]!.locks, ["db", "staging"])
  assert.equal(tasks[0]!.priority, 5)
})
