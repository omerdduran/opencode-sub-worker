# Changelog

## 0.1.0

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
