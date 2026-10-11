# Changelog

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
