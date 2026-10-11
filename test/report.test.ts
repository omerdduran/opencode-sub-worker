import { test } from "node:test"
import assert from "node:assert/strict"
import { parseWorkerReport } from "../src/core/prompt.ts"
import { CoChangeStore } from "../src/core/cochange.ts"

test("parseWorkerReport reads a fenced JSON report", () => {
  const text = 'done\n```json\n{ "status": "done", "evidence": "ran tests", "files": ["a.ts"] }\n```\n'
  const report = parseWorkerReport(text)
  assert.equal(report.status, "done")
  assert.equal(report.evidence, "ran tests")
  assert.deepEqual(report.files, ["a.ts"])
})

test("parseWorkerReport reads a blocked JSON report", () => {
  const report = parseWorkerReport('```json\n{"status":"blocked","blocker":"no token"}\n```')
  assert.equal(report.status, "blocked")
  assert.equal(report.blocker, "no token")
})

test("parseWorkerReport falls back to bracket markers", () => {
  assert.equal(parseWorkerReport("[task:done] shipped it").status, "done")
  assert.equal(parseWorkerReport("[task:blocked] no creds").status, "blocked")
})

test("parseWorkerReport defaults to progress when there is no report", () => {
  assert.equal(parseWorkerReport("still working on it").status, "progress")
})

test("CoChangeStore learns pairs and reports conflicts above the threshold", () => {
  const store = new CoChangeStore(2)
  assert.equal(store.conflicts(["a.ts"], ["b.ts"]), false)
  store.record(["a.ts", "b.ts", "c.ts"])
  store.record(["a.ts", "b.ts"])
  assert.equal(store.score("a.ts", "b.ts"), 2)
  assert.equal(store.conflicts(["a.ts"], ["b.ts"]), true)
  assert.equal(store.conflicts(["a.ts"], ["c.ts"]), false)
})

test("CoChangeStore round-trips through serialize/load", () => {
  const a = new CoChangeStore(2)
  a.record(["x", "y"])
  a.record(["x", "y"])
  const b = new CoChangeStore(2)
  b.load(a.serialize())
  assert.equal(b.score("x", "y"), 2)
  assert.equal(b.conflicts(["x"], ["y"]), true)
})
