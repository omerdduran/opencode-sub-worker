# Example task checklist for opencode-sub-worker
#
# Preview:  /tasks plan examples/tasks.example.md
# Run:      /tasks run  examples/tasks.example.md

- [ ] Add a cache layer to the auth module
  - files: src/auth/cache.ts, src/auth/cache.test.ts
  - verify: npm test -- auth
  - risk: touches the login path

- [ ] Document the cache
  - files: docs/auth.md
  - verify: false

- [ ] Wire the cache into the router
  - files: src/router.ts
  - deps: 1, 2
  - verify: npm test

- [ ] Bump the changelog
  - verify: true
