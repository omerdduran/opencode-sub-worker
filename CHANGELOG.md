# Changelog

## [0.3.0](https://github.com/omerdduran/opencode-sub-worker/compare/v0.2.0...v0.3.0) (2026-10-11)


### Features

* live TUI run panel (JSX session.panel) over RPC ([1dd0812](https://github.com/omerdduran/opencode-sub-worker/commit/1dd0812b7cc240231d0aadf307899357910cce00))

## [0.2.0](https://github.com/omerdduran/opencode-sub-worker/compare/v0.1.2...v0.2.0) (2026-10-11)


### Features

* repair loop, approval gate, locks/priority, RPC/CLI, co-change learning ([efc5652](https://github.com/omerdduran/opencode-sub-worker/commit/efc565287c68d619c48a5286231f0a01854e635d))

## [0.1.2](https://github.com/omerdduran/opencode-sub-worker/compare/v0.1.1...v0.1.2) (2026-10-11)


### Bug Fixes

* keep the worker worktree when autoMerge is off ([7031ad8](https://github.com/omerdduran/opencode-sub-worker/commit/7031ad8df8f96601850edc619363c785c0f8b53a))

## 0.1.1

Initial release.

- Turn a markdown task checklist into a dependency- and file-conflict-aware
  schedule.
- Run ready tasks in parallel as isolated child sessions, each in its own git
  worktree.
- Orchestrator-mediated mailbox (`taskforce_send` / `worker_report` /
  `worker_inbox`) and human-in-the-loop `/tasks answer`.
- Enforced write scope: session permissions plus a post-run `git` diff-scope
  check, with glob-aware scopes (`*`, `?`, `**`).
- Verification gates, an optional independent verifier session, and fail-closed
  worktrees.
- Cost/token budgets and per-task/per-role model routing.
- Durable run state with recovery-paused loading.
- `/tasks` command and `taskforce_*` tools.
