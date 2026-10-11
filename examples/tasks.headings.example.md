---
feature: example-headings
source_prd: features/example-headings/prd.md
issue: "acme/repo#123"
kind: ui
generated: 2026-10-11
---

## Tasks

### 1. [ ] Add the cache layer
- **Stories:** 1, 3
- **TDD:** yes
- **Risk:** 🟠
- **Files:** `src/auth/cache.ts`, `src/auth/cache.test.ts`
- **Spec & identifiers in scope:** none
- **Out of scope:** the router
- **What to build:** a small cache keyed by token.
- **How verified (end-to-end):** `npm test -- auth`
- **Acceptance criteria:**
  - [ ] a hit avoids the slow path
  - [ ] a miss re-fetches

### 2. [ ] [design] Render the status badge
- **Stories:** 2
- **TDD:** no (UI subtask)
- **Risk:** 🟢
- **Files:** `src/ui/Badge.tsx`

### 3. [ ] Rotate the signing key
- **Files:** `protocol/src/keys.rs`
- **Risk:** 🔴
- **[NEEDS DECISION: rotate in place or add a second key first?]**
