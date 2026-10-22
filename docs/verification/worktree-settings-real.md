# Production worktree settings verification

The production app, including the ownership-fence repair, was driven through actual Chromium in a disposable home on 13 October 2026. Every provider was disabled; no NativeApi was replaced. The test passed default-off, real settings-file persistence, reload retaining on, and reverting off. The adjacent default/enabled PNGs are from that run.

After building web and server, run from the repository root:

```sh
node docs/verification/worktree-settings-real-check.mjs
```

The separate `SYNARA_LIVE_GITHUB=1 bun run --cwd apps/server test src/managedWorktrees.live.test.ts` also passed against native Git and live GitHub metadata, including locked removal refusal, snapshot preservation, retry, and retained branches. The settings screenshots alone do not prove file removal.

Merge cleanup holds the server data-home lifecycle fence across its final ownership/dirty checks and native removal. Engine commits (including restore), terminal launch/restart, settings changes, and automation ownership changes use the same fence. Snapshots and GitHub lookups happen before that short critical section. Normal lifecycle work remains concurrent; cleanup skips rather than waits when any actor holds an activity lease. Regression tests prove a queued real engine restore cannot commit during removal and that ownership changed during snapshotting prevents removal.
