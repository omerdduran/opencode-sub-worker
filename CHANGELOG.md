# Changelog

## [0.2.0](https://github.com/omerdduran/opencode-sub-worker/compare/v0.1.1...v0.2.0) (2026-10-11)


### Features

* initial release of opencode-sub-worker ([5ef3d42](https://github.com/omerdduran/opencode-sub-worker/commit/5ef3d42456bdebcf5b5605a16b945797522659c3))

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
