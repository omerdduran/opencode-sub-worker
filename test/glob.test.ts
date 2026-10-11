import { test } from "node:test"
import assert from "node:assert/strict"
import { conflicts } from "../src/core/graph.ts"
import { globToRegExp, hasGlob, matchesAny, pathMatchesGlob, specConflicts } from "../src/core/glob.ts"
import type { Task } from "../src/core/types.ts"

function task(id: string, files: string[]): Task {
  return {
    id,
    index: 1,
    title: id,
    checkedInSource: false,
    files,
    verify: null,
    deps: [],
    status: "pending",
    attempts: 0,
  }
}

test("hasGlob detects wildcard specs", () => {
  assert.equal(hasGlob("src/a.ts"), false)
  assert.equal(hasGlob("src/**"), true)
  assert.equal(hasGlob("src/*.ts"), true)
})

test("pathMatchesGlob: literals, star and doublestar", () => {
  assert.equal(pathMatchesGlob("src/a.ts", "src/a.ts"), true)
  assert.equal(pathMatchesGlob("src/a.ts", "src/b.ts"), false)
  assert.equal(pathMatchesGlob("src/*.ts", "src/a.ts"), true)
  assert.equal(pathMatchesGlob("src/*.ts", "src/nested/a.ts"), false)
  assert.equal(pathMatchesGlob("src/**/*.ts", "src/nested/a.ts"), true)
  assert.equal(pathMatchesGlob("src/**", "src/a/b/c.ts"), true)
})

test("globToRegExp does not match across path separators with a single star", () => {
  assert.equal(globToRegExp("a/*/b").test("a/x/b"), true)
  assert.equal(globToRegExp("a/*/b").test("a/x/y/b"), false)
})

test("matchesAny reports scope membership", () => {
  assert.equal(matchesAny(["src/a.ts", "docs/**"], "docs/guide.md"), true)
  assert.equal(matchesAny(["src/a.ts", "docs/**"], "src/b.ts"), false)
})

test("specConflicts: exact, glob vs literal, and disjoint globs", () => {
  assert.equal(specConflicts("src/a.ts", "src/a.ts"), true)
  assert.equal(specConflicts("src/a.ts", "src/b.ts"), false)
  assert.equal(specConflicts("src/auth/**", "src/auth/cache.ts"), true)
  assert.equal(specConflicts("src/auth/cache.ts", "src/**"), true)
  assert.equal(specConflicts("src/a/**", "src/b/**"), false)
})

test("conflicts uses glob matching for declared scopes", () => {
  assert.equal(conflicts(task("a", ["src/auth/**"]), task("b", ["src/auth/cache.ts"])), true)
  assert.equal(conflicts(task("a", ["src/auth/**"]), task("b", ["docs/**"])), false)
})
