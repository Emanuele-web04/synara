# Contributing

## Read This First

We are accepting focused contributions, especially small bug fixes, reliability fixes, performance improvements, and maintenance work.

You can open an issue or PR, but please do so knowing that Synara is still early and we are keeping scope, quality, and direction tight.

Large, unfocused, or direction-changing PRs may still be closed quickly.

PRs are automatically labeled with a `vouch:*` trust status and a `size:*` diff size based on changed lines.

If you are an external contributor, expect `vouch:unvouched` until we explicitly add you to [.github/VOUCHED.td](.github/VOUCHED.td).

## What We Are Most Likely To Accept

Small, focused bug fixes.

Small reliability fixes.

Small performance improvements.

Tightly scoped maintenance work that clearly improves the project without changing its direction.

## What We Are Least Likely To Accept

Large PRs.

Drive-by feature work.

Opinionated rewrites.

Anything that expands product scope without us asking for it first.

If you open a 1,000+ line PR full of new features, we will probably close it quickly and remember that you ignored the clearly written instructions.

## If You Still Want To Open A PR

Keep it small.

Explain exactly what changed.

Explain exactly why the change should exist.

Do not mix unrelated fixes together.

If the PR makes anything resembling a UI change, include clear before/after images.

If the change depends on motion, timing, transitions, or interaction details, include a short video.

If we have to guess what changed, we are much less likely to review it.

## Issues First

If you are thinking about a non-trivial change, open an issue first.

That gives you a chance to check whether the direction fits before spending time on a larger patch.

## Testing

Run the full workspace test suite from the repository root with:

```bash
bun run test
```

For focused web tests, pass paths relative to `apps/web` through the dedicated root command:

```bash
bun run test:web:focused src/path/to/example.test.ts
```

The pinned `@pierre/diffs` patch refreshes file-editor rows after line insertions
and deletions. When upgrading the dependency, verify repeated Enter, subsequent
typing, undo, and redo with the real editor browser tests before removing it:

```bash
bun run --cwd apps/web test:browser src/components/codeEditor/CodeEditorPane.browser.tsx
```

The pinned `@effect/platform-node-shared` patch preserves Windows spawn options
and rejects invalid PIDs before converting child handles into process-group
signals. Valid groups may outlive their leader; cleanup must continue to reach
those descendants. When updating Effect, keep these behaviors and run
`apps/server/src/platform/effectProcessSignals.test.ts` against the installed
runtime, including its Windows cases.

Process-tree teardown captures POSIX start times and Windows creation times for
checking descendants during delayed cleanup and exit verification. This rejects
observed PID reuse without depending on stable command-line text. POSIX start
times have second resolution and observation followed by signaling is not atomic;
these checks are not proof of arbitrary PID ownership. Root signaling still
requires the caller to own the live process lifecycle. Direct owned-child
cancellation must work even when external process-table tools are unavailable.

## Be Realistic

Opening a PR does not create an obligation on our side.

We may close it. We may ignore it. We may ask you to shrink it. We may reimplement the idea ourselves later.

If you are fine with that, proceed.
