# opencode-sub-worker

[![CI](https://github.com/omerdduran/opencode-sub-worker/actions/workflows/ci.yml/badge.svg)](https://github.com/omerdduran/opencode-sub-worker/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/opencode-sub-worker.svg)](https://www.npmjs.com/package/opencode-sub-worker)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Turn a markdown task checklist into a **dependency- and file-conflict-aware
schedule**, run the ready tasks **in parallel as isolated child sessions**, each
in **its own git worktree**, coordinate through an **orchestrator-mediated
mailbox**, and gate every task with a **verification command**.

Built for [OpenCode](https://opencode.ai) V2.

```md
- [ ] Add cache to the auth module
  - files: src/auth/cache.ts, src/auth/cache.test.ts
  - verify: npm test -- auth
- [ ] Update the docs
  - files: docs/auth.md
  - verify: false
- [ ] Wire the cache into the router
  - files: src/router.ts
  - deps: 1, 2
```

```
/tasks plan TASKS.md     # preview the schedule, run nothing
/tasks run  TASKS.md     # start it
/tasks status            # follow along
```

---

## Why this exists

Most agent orchestrators ask the model to plan and delegate in prose. That is
flexible but hard to reproduce and hard to trust. This plugin moves the loop
into **deterministic code**:

- The plugin owns scheduling, locking, retries, merging and gating.
- The model is only a **worker**: it receives one task, works in one checkout,
  and reports back.
- The schedule is driven by **declared files**, so two workers never edit the
  same file at the same time.

## How it works

1. **Parse** — a `checklist` line (`- [ ]`) or a `headings` task (`### N. [ ]`),
   depending on `taskFormat`; a custom parser can be plugged in.
2. **Graph** — `deps:` become ordering edges; tasks that share a file (or
   declare no files at all) become mutually exclusive.
3. **Schedule** — ready, non-conflicting tasks are launched up to
   `maxConcurrency`; the rest wait.
4. **Isolate** — each worker runs in its own `git worktree` and gets only its
   declared write scope in the prompt.
5. **Wait & read** — the orchestrator waits for a worker to go idle and reads
   its final message for a `[task:done]` / `[task:blocked]` marker.
6. **Gate** — the task's `verify:` command is run in the worker's worktree. A
   failing gate is a failing task.
7. **Integrate** — a passing task's worktree changes are committed on its branch
   and merged back; the worktree is removed and dependents unlock.
8. **Report** — status, usage and a durable ledger are kept in plugin storage.

If a task exhausts its retries, or reports blocked, or its gate keeps failing,
the run **pauses** and the user is notified. `/tasks resume` gives it another
shot.

## Task formats

Two formats are built in; pick one with `taskFormat`.

### `checklist` (default)

A task is a checklist line. Metadata goes on the lines below it, indented at
least as far as the task, with or without a bullet.

| Key | Meaning |
|---|---|
| `id` | Stable id. Defaults to `t1`, `t2`, … (by position). |
| `files` | Comma-separated write scope. **Empty ⇒ never parallel.** |
| `locks` | Comma-separated exclusive named resources (e.g. `db-migration, staging`). |
| `priority` | Higher runs first among ready tasks. Default `0`. |
| `verify` | Shell command that must pass. `false`/`no`/`none`/`-` disables the gate. |
| `deps` | Comma-separated dependencies — a 1-based item number or an `id`. |
| `agent` | Worker agent id. Overrides the plugin default. |
| `model` | `provider/model[#variant]` for this task. Overrides the role map and default. |
| `risk` | Free text; a value listed in `approvalRisks` holds the task for approval. |
| `timeout` | Per-task timeout (`30s`, `5m`, `600000`). |

Already-checked (`- [x]`) items are treated as done and satisfy dependents.

Example: [`examples/tasks.example.md`](examples/tasks.example.md).

### `headings` (PRD / `tasks.md` style)

A task is a `### N. [ ]` heading; fields are bold labels below it; the order in
the file is the dependency chain. `[design]` marks a visual subtask.

```md
### 1. [ ] Add the cache layer
- **Stories:** 1, 3
- **TDD:** yes
- **Risk:** 🟠
- **Files:** `src/auth/cache.ts`, `src/auth/cache.test.ts`
- **Spec & identifiers in scope:** none
- **What to build:** a small cache keyed by token.
- **How verified (end-to-end):** `npm test -- auth`
- **Acceptance criteria:**
  - [ ] a hit avoids the slow path
  - [ ] a miss re-fetches
```

- The task id is the heading number, so `/tasks diff 1` targets it.
- Read labels: `Files`, `Risk`, `Stories`, `TDD`, `Locks`, `Priority`, `Agent`,
  `Model`, `Out of scope`, `Spec & identifiers in scope`, `What to build`,
  `Acceptance criteria`. `How verified` is prose and does **not** become a gate;
  add a `**Verify:**` line with a command to gate the task.
- `sequentialDeps: true` turns file order into explicit dependencies.
- `Risk: 🔴` (or any value in `approvalRisks`) holds the task for `/tasks approve`.
- A task whose body matches `holdPattern` (default `[NEEDS DECISION`) is held and
  the run pauses with the reason.
- Field labels are configurable with `fields`; a custom parser can be plugged
  with `parserModule`.

Example: [`examples/tasks.headings.example.md`](examples/tasks.headings.example.md).

## Running a PRD / `tasks.md` workflow

If your tasks come from a PRD broken into a `tasks.md`, run in **assist** mode so
the plugin implements and verifies but leaves the tree dirty for you to review
and commit:

```jsonc
{
  "plugins": [
    {
      "package": "opencode-sub-worker",
      "options": {
        "taskFormat": "headings",
        "sequentialDeps": true,
        "mode": "assist",
        "detectCompletion": "checkboxes",
        "flipCheckboxes": true,
        "progressFile": "features/<feature>/progress.md",
        "approvalRisks": ["🔴"],
        "workerInstructionsFile": ".opencode/sub-worker-worker.md"
      }
    }
  ]
}
```

- `mode: "assist"` forces `autoMerge`, `commitBeforeMerge` and
  `cleanupWorktrees` off.
- `workerInstructionsFile` appends your project rules (no commits, tracker
  discipline, and so on) to every worker prompt; `workerSkills` and
  `workerInstructions` do the same inline.
- `flipCheckboxes` writes `### N. [x]` back into the source list; `progressFile`
  appends a per-task block. The orchestrator is the **only writer**, so parallel
  workers never race on the file.
- `detectCompletion: "checkboxes"` treats a flipped box as the done signal
  instead of the worker's report.

## Command and tools

| Surface | Description |
|---|---|
| `/tasks plan <file\|markdown>` | Parse and preview the dependency/conflict schedule. No execution. |
| `/tasks run <file\|markdown>` | Start the run. |
| `/tasks add <file\|markdown>` | Add tasks to the active run. |
| `/tasks status` | Task statuses and recent activity. |
| `/tasks list` | One-line summary. |
| `/tasks diff <taskID>` | Show a task's worktree diff. |
| `/tasks logs <taskID>` | Show a task's status, branch, gate output and history. |
| `/tasks approve <taskID>` / `reject <taskID> <reason>` | Resolve a task held at the approval gate. |
| `/tasks answer <taskID> <text>` | Answer a blocked worker and continue it. |
| `/tasks broadcast <text>` | Message every running worker. |
| `/tasks resume` / `abort` | Resume a paused run / stop the run. |
| `taskforce_plan` / `taskforce_run` / `taskforce_add` / `taskforce_status` / `taskforce_resume` / `taskforce_abort` / `taskforce_answer` / `taskforce_approve` / `taskforce_reject` / `taskforce_diff` / `taskforce_logs` / `taskforce_send` / `taskforce_broadcast` | The same actions as model tools. |
| `worker_report` / `worker_inbox` | Worker-side tools for the mailbox. |

## Options

Plugin-level options (V2 object form):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "opencode-sub-worker",
      "options": {
        "taskFormat": "checklist",
        "sequentialDeps": false,
        "parserModule": "",
        "maxConcurrency": 3,
        "taskTimeoutMs": 1200000,
        "verifyTimeoutMs": 600000,
        "maxAttempts": 2,
        "freshWorktreeOnRetry": false,
        "continueOnError": false,
        "repairOnFailure": true,
        "workerAgent": "subworker",
        "installWorkerAgent": true,
        "workerModel": "anthropic/claude-sonnet-4-5",
        "roleModels": { "reviewer": "anthropic/claude-sonnet-4-5" },
        "fallbackModels": ["openai/gpt-4o-mini"],
        "useWorktrees": true,
        "requireWorktrees": true,
        "autoMerge": true,
        "commitBeforeMerge": true,
        "cleanupWorktrees": true,
        "enforceWriteScope": true,
        "enforceDiffScope": true,
        "approvalRisks": ["high"],
        "coChangeLearning": false,
        "coChangeMinCount": 2,
        "mirrorSessionTitles": false,
        "holdPattern": ["\\[NEEDS DECISION"],
        "detectCompletion": "report",
        "progressFile": "",
        "flipCheckboxes": false,
        "mode": "integrate",
        "workerInstructions": "",
        "workerInstructionsFile": "",
        "workerSkills": [],
        "workerContract": "generic",
        "verifierEnabled": false,
        "verifierAgent": "explore",
        "verifierPrompt": "",
        "askUserOnBlocked": false,
        "maxCostUsd": 0,
        "maxTokens": 0,
        "persistState": true
      }
    }
  ]
}
```

| Option | Default | Meaning |
|---|---|---|
| `commandName` | `tasks` | Slash command name. |
| `registerCommand` / `registerTools` | `true` | Toggle the command / tools. |
| `taskFormat` | `checklist` | `checklist` or `headings` (PRD/`tasks.md` style). |
| `fields` | (built-in) | Field-label mapping for the `headings` format. |
| `sequentialDeps` | `false` | Treat file order as the dependency chain. |
| `parserModule` | `""` | Path or package name of a custom parser module (`parse(source) => { tasks, errors }`). |
| `maxConcurrency` | `3` | Max workers running at once. |
| `taskTimeoutMs` | `1200000` | Per-task wall-clock timeout. |
| `verifyTimeoutMs` | `600000` | Gate command timeout. |
| `maxAttempts` | `2` | Attempts per task before the run pauses. |
| `freshWorktreeOnRetry` | `false` | Start a retry from a clean worktree instead of continuing in place. |
| `continueOnError` | `false` | A failed/blocked task pauses the whole run; set `true` to let independent work continue. |
| `repairOnFailure` | `true` | On a failed gate, steer the failure back to the same worker to repair it before counting an attempt. |
| `workerInstructions` | `""` | Extra instructions appended to every worker prompt. |
| `workerInstructionsFile` | `""` | A file whose contents are appended to every worker prompt. |
| `workerSkills` | `[]` | Skills the worker should follow (appended to the prompt). |
| `workerContract` | `generic` | Built-in worker report contract; `none` omits it. |
| `workerAgent` | `subworker` | Worker agent id. |
| `installWorkerAgent` | `true` | Write `.opencode/agents/<workerAgent>.md` on setup. |
| `workerModel` | `""` | `provider/model[#variant]` for workers. Empty = inherit. |
| `roleModels` | `{}` | Per-agent model overrides keyed by the task's `agent:` value. |
| `fallbackModels` | `[]` | Ordered model references tried on retry after a failure. |
| `useWorktrees` | `true` | One `git worktree` per worker. |
| `requireWorktrees` | `true` | If a worktree cannot be created, fail the task instead of running in place. |
| `autoMerge` | `true` | Merge each finished worker's branch back. |
| `commitBeforeMerge` | `true` | Commit the worker's worktree changes so the branch can be merged. |
| `cleanupWorktrees` | `true` | Remove worktrees after integration. |
| `enforceWriteScope` | `true` | Deny edits outside `files:` at the session-permission level. |
| `enforceDiffScope` | `true` | After a worker finishes, fail it if it touched undeclared files. |
| `approvalRisks` | `[]` | Risk labels (case-insensitive) that hold a task for `/tasks approve`/`reject` before integrating. |
| `coChangeLearning` | `false` | Learn file pairs that change together and treat them as conflicts. |
| `coChangeMinCount` | `2` | Co-change count before a learned pair conflicts. |
| `mirrorSessionTitles` | `false` | Mirror run status into the orchestrator session title. |
| `holdPattern` | `["\\[NEEDS DECISION"]` | Regexes; a matching task is held and the run pauses. |
| `detectCompletion` | `report` | `report` (worker report) or `checkboxes` (a flipped box in the source). |
| `progressFile` | `""` | Append a per-task block here (relative to the project root). |
| `flipCheckboxes` | `false` | Write `[x]` back to the source list when a task is done. |
| `mode` | `integrate` | `integrate` (merge) or `assist` (leave the tree dirty; forces merge behaviours off). |
| `verifierEnabled` | `false` | Run an independent read-only verifier session after the gate. |
| `verifierAgent` | `explore` | Agent id used for the verifier. |
| `verifierPrompt` | `""` | Extra verifier instructions appended to the verifier prompt. |
| `askUserOnBlocked` | `false` | Keep a blocked worker alive and wait for `/tasks answer`. |
| `maxCostUsd` | `0` | Pause the run when accumulated cost reaches this. `0` = off. |
| `maxTokens` | `0` | Pause the run when accumulated tokens reach this. `0` = off. |
| `persistState` | `true` | Durable run snapshot in plugin storage. |

## Safety and quality

Four mechanisms turn the declared write scope from advice into an invariant:

1. **Session permissions** (`enforceWriteScope`) — the worker child session is
   created with an `edit` ruleset that denies `*` and allows only the declared
   files, so an out-of-scope edit is refused by the host, not just discouraged.
2. **Diff-scope check** (`enforceDiffScope`) — after a worker finishes, its
   changed files are compared against the (glob-aware) declared scope; a
   violation fails the task.
3. **Independent verifier** (`verifierEnabled`) — an optional read-only session
   inspects the result and can reject it, independent of the gate command.
4. **Fail-closed isolation** (`requireWorktrees`) — if a worktree cannot be
   created, the task fails instead of silently running in place.

Scopes support globs (`*`, `?`, `**`), so `src/auth/**` conflicts with
`src/auth/cache.ts` and covers it in the diff-scope check. Conflict detection is
conservative: when two scopes might intersect, tasks are serialized.

`autoMerge` commits a worker's worktree changes on its branch and merges that
branch. **If your Git worktree strategy does not create a branch**, merging
fails and the run pauses — see Limitations.

## Budgets and model routing

- `maxCostUsd` / `maxTokens` pause the run when the accumulated worker usage
  crosses the limit. Per-task usage is shown in `/tasks status`.
- Model selection: task `model:` → `roleModels[agent]` → `workerModel` →
  inherit. So a `reviewer` task can run on a different model than a `coder`.

## Human-in-the-loop

With `askUserOnBlocked: true`, a worker that reports blocked is **kept alive**
and the run pauses with `awaiting answer`. Reply with:

```
/tasks answer t1 use the test key from .env.test
```

The answer is steered into the same worker, which resumes and finishes its task.

## Repair loop

By default (`repairOnFailure: true`), when a task's verification command fails the
failure output is **steered back into the same worker**, which keeps its context
and fixes the problem in place. Only if it still fails after `maxAttempts` is the
task marked failed and the run paused. Set it to `false` for the old
fail-and-retry-from-scratch behavior.

## Approval gate

List risky labels in `approvalRisks` (for example `["high"]`). A task whose
`risk:` matches still runs and is gated, but before its branch is integrated the
run pauses with the task in `review`:

```
/tasks approve t3            # integrate it
/tasks reject t3 not safe    # block it
```

## Named locks, priority and co-change learning

- `locks:` declares exclusive named resources beyond files (a database, an
  environment, a port). Tasks sharing a lock are serialized.
- `priority:` (higher first) orders ready tasks.
- With `coChangeLearning: true`, the plugin records which files changed together
  across completed tasks and treats a learned pair (>= `coChangeMinCount`) as a
  conflict, so files that historically move together are not edited in
  parallel.

## RPC and the CLI plugin

The package exposes an RPC contract at `opencode-sub-worker/rpc` with a `status`
method and `progress` events (emitted on every task/run transition), so other
plugins and clients can observe a run over HTTP.

It also exports a CLI plugin at `opencode-sub-worker/tui`:

- a **run panel** in the `session.panel` slot — a live task table with per-task
  status colors, counts, cost and tokens. Open it with `/tasks-panel` or the
  "Sub-worker run panel" palette command; `[f]` toggles fullscreen and `[esc]`
  closes it;
- a **"Task force status"** palette / `/tasks` command that shows a compact
  summary;
- **attention notifications** when a task or run finishes or fails.

The panel reads the run over RPC and refreshes on progress events plus a 2s poll.
It renders with `@opentui/solid`; `@opentui/core`, `@opentui/solid` and
`solid-js` are declared as optional peers (the terminal provides them).

```jsonc title="cli.json"
{ "plugins": ["opencode-sub-worker"] }
```

## Worker agent

A plugin cannot register a new agent through `agent.transform` (there is no
`add`). So, when `installWorkerAgent` is on, the plugin writes
`.opencode/agents/<workerAgent>.md` (mode `all`) with the worker contract. Set it
to `false` and point `workerAgent` at an agent you already have.

## Mailbox

Coordination is **orchestrator-mediated**. Two directions are supported:

- **Up:** a worker calls `worker_report` (or ends its message with a marker).
  Reports land in the run's durable state.
- **Down:** the orchestrator calls `taskforce_send`; the message is queued and
  steered into the running worker, which can read it with `worker_inbox`.

## Persistence and recovery

Runs are snapshotted to plugin storage on every transition. A run that was
active when the server restarted loads **paused** (so unattended work never
resumes blindly) and can be restarted with `/tasks resume`.

## Limitations (read these)

- **V2 only.** There is no V1 adapter.
- **The report, not a tool, is the durable contract.** A worker runs in its own
  worktree *location*; tools registered for the orchestrator's location may not
  be visible there. So completion is read from a fenced JSON report at the end of
  the worker's final message (`[task:done]`/`[task:blocked]` markers are the
  fallback); `worker_report` is a best-effort enhancement.
- **The gate, the verifier, the diff and `git` run in the server process** via
  `child_process`, not through OpenCode's permission system. Plugins are trusted
  code; keep that in mind.
- **`repairOnFailure` reuses the same worktree and session**, so a repair keeps
  the worker's context — and any partial edits — rather than starting clean.
- **`enforceWriteScope` is strict by design.** A worker that needs to touch an
  undeclared file (say, a lockfile) will be refused and should report blocked.
  Declare the file or disable the option.
- **The diff-scope check trusts `git status`.** Untracked files and modified
  tracked files are seen; changes a worker makes outside the checkout, or files
  excluded by `.gitignore`, are not.
- **Merging assumes Git and a branch per worktree.** `createWorktree` requires a
  Git repository. If your default worktree strategy does not create a branch,
  `mergeWorktree` reports a failure and the run pauses. With `autoMerge: false`
  the worktree is kept for review instead (and recorded in the run history).
- **Co-change learning is a heuristic.** It only ever *adds* conflicts, so it can
  over-serialize; the learned pairs persist in plugin storage.
- **`continueOnError` still marks dependents of a failed task as skipped.**
- **`askUserOnBlocked` keeps a session alive** while the run is paused; it is
  disposed when the run is aborted or resumed.
- **The bundled CLI plugin renders a live panel** in the TUI; it requires the
  optional `@opentui/core`, `@opentui/solid` and `solid-js` peers that the
  OpenCode terminal provides, and is only active in the TUI.
- **RPC status is per orchestrator session** and returns JSON; progress events
  are live only (disconnected subscribers miss them).
- **In `assist` mode the plugin is the only writer of the source list and the
  progress file.** It flips checkboxes and appends progress after each task, so
  parallel workers never race on `tasks.md`; a worker that also writes the file
  would race it.
- **`headings` "How verified" is prose, not a gate.** Only an explicit
  `**Verify:**` line gates the task; otherwise rely on the verifier and the
  acceptance criteria.
- **`detectCompletion: "checkboxes"` and `flipCheckboxes` are alternatives.** The
  first trusts the worker to flip the box; the second has the plugin flip it (use
  `report` detection then).
- **Not a sandbox.** Workers inherit the session's permissions except for the
  write-scope rules the plugin adds.

## Development

```sh
npm install
npm run typecheck
npm test          # core parser/graph/scheduler/engine + the V2 adapter
npm run build
```

Tests import the TypeScript sources directly, so they need **Node 22.18+**
(type stripping on by default). The published package is plain JavaScript.

To dogfood locally, build and run OpenCode from this repo root (the bundled
loader at `.opencode/plugins/opencode-sub-worker.ts` re-exports `dist/`):

```sh
npm run build
opencode
# then: /tasks plan examples/tasks.example.md
```

## Design

The core (`src/core/`) is platform-independent and talks to the host through
the `HostPort` interface (`src/ports.ts`). The OpenCode V2 adapter
(`src/v2/`) duck-types the plugin context so the package does not pull the
Effect-based type tree into consumers. This mirrors the architecture of
[`opencode-goal-loop`](https://github.com/omerdduran/opencode-goal-loop).

## Releasing

Releases are automated with GitHub Actions, mirroring
[`opencode-goal-loop`](https://github.com/omerdduran/opencode-goal-loop).

- **`ci.yml`** runs `typecheck`, `test`, `build`, and `pack:check` on every push
  to `main` and every pull request, across Node 22, 24, and 26.
- **`release.yml`** runs [release-please](https://github.com/googleapis/release-please).
  It reads [Conventional Commits](https://www.conventionalcommits.org) and opens
  a "release PR" that bumps the version and updates `CHANGELOG.md`. Merging that
  PR creates the git tag and GitHub Release, and the same workflow then publishes
  to npm with OIDC **trusted publishing** — no tokens stored, provenance attached.

So a release is just: merge a `feat:`/`fix:` PR, then merge the release PR that
release-please opens. For a one-off manual release, use `npm version <patch|minor|major>`
and push the tag (the trusted publisher must allow direct `npm publish`).

### One-time npm setup

Add a Trusted Publisher for the package on npmjs.com
(**Package → Settings → Trusted publishing**) with:

| Field | Value |
|---|---|
| Organization or user | `omerdduran` |
| Repository | `opencode-sub-worker` |
| Workflow filename | `release.yml` |
| Allowed actions | enable **`npm publish`** (Allow npm publish) |

The workflow filename must match exactly (case-sensitive, `.yml` included) and
the first publish must succeed within 2 days, otherwise the configuration expires.

Or configure it from the CLI (after the first publish):

```sh
npm trust github opencode-sub-worker \
  --file release.yml \
  --repository omerdduran/opencode-sub-worker \
  --allow-publish -y
npm trust list opencode-sub-worker
```

### Development requirements

The published package is plain JavaScript, but the test suite imports the
TypeScript sources directly, so running this repo's tests requires **Node 22.18+**
(type stripping on by default).

## License

MIT
