# Plan 009: Narrow preview-pane store subscriptions and make swallowed WS listener errors observable

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat d94f416d9..HEAD -- apps/web/src/components/chat/DockTerminalPane.tsx apps/web/src/components/chat/GitPanel.tsx apps/web/src/wsNativeApi.ts apps/web/src/wsTransport.ts apps/web/src/storeSelectors.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: perf + bug
- **Planned at**: commit `d94f416d9`, 2026-07-07

## Why this matters

Two independent, low-risk fixes on the client streaming path:

1. **Perf**: The dock terminal pane and the git panel each subscribe to the full
   derived `Thread` (whose reference changes on every streaming message/activity
   event) just to read `worktreePath`. A purpose-built shell-only selector already
   exists. These panes typically mount alongside an active turn, so they currently
   re-render continuously during streaming for data that never changed.
2. **Reliability**: The client's sole real-time ingestion path fans WS events out
   to listeners inside 17 bare `catch { /* Swallow listener errors */ }` blocks
   with no logging. In production a single listener per channel processes each
   event; if it throws (unexpected payload, a bug in the ~2,270-line store event
   switch), the event is silently dropped and the UI desyncs from the server with
   zero diagnostic trace. "Reliability first" is a stated repo priority; a
   swallowed exception on the core streaming path violates it.

## Current state

### Part A — over-broad selectors

`apps/web/src/components/chat/DockTerminalPane.tsx:29-35`:

```ts
const thread = useStore(
  useMemo(() => createThreadSelector(props.hostThreadId), [props.hostThreadId]),
);
// …
const worktreePath = thread?.worktreePath ?? null;
```

`apps/web/src/components/chat/GitPanel.tsx:213-219`:

```ts
const thread = useStore(
  useMemo(() => createThreadSelector(props.hostThreadId), [props.hostThreadId]),
);
// …
const cwd = thread?.worktreePath ?? project?.cwd ?? null;
```

`createThreadSelector` (`apps/web/src/storeSelectors.ts`) returns the full derived
`Thread`, whose reference changes whenever `messages`/`activities`/`proposedPlans`/
`turnDiffSummaries` change. The shell-only alternative already exists
(`apps/web/src/storeSelectors.ts:159-187`) and is already used by
`routes/_chat.$threadId.tsx:1437`:

```ts
export function createThreadWorkspaceMetadataSelector(
  threadId: ThreadId | null | undefined,
): (state: AppState) => ThreadWorkspaceMetadata {
  // …memoized; returns EMPTY_THREAD_WORKSPACE_METADATA unless envMode/worktreePath change…
  // Shell-only: avoid subscribing preview panes to live message/activity detail slices.
}
```

It returns `{ envMode, worktreePath }` and only produces a new reference when
`envMode` or `worktreePath` actually change (it reads from `state.threadShellById`,
not the live message/activity slices). Neither `DockTerminalPane` nor `GitPanel`
reads anything from `thread` other than `worktreePath` (confirmed by grep — the
only `thread?.` access in each file is `thread?.worktreePath`).

### Part B — swallowed listener errors

`apps/web/src/wsNativeApi.ts` — 17 occurrences of `// Swallow listener errors`
inside bare `catch {}` blocks. Two shapes:

Replay-on-subscribe (e.g. `wsNativeApi.ts:216-220`):

```ts
try {
  listener(latestWelcome);
} catch {
  // Swallow listener errors
}
```

Fan-out loops (e.g. `wsNativeApi.ts:415-424`, the `orchestration.domainEvent`
channel — the hottest path):

```ts
transport.subscribe(ORCHESTRATION_WS_CHANNELS.domainEvent, (message) => {
  const payload = message.data;
  for (const listener of orchestrationDomainEventListeners) {
    try {
      listener(payload);
    } catch {
      // Swallow listener errors
    }
  }
});
```

The same silent-catch pattern also exists in `apps/web/src/wsTransport.ts` in
**two** places — both must be fixed:

1. Connection-state listeners (`wsTransport.ts:321-326`), comment
   `// Listener errors must not break reconnect or RPC state transitions.`
2. **Push-stream fan-out** (`wsTransport.ts:363-368`) — the hotter one — where
   `emit`/`startStream` dispatches each push message to channel listeners:

```ts
for (const listener of listeners) {
  try {
    listener(message);
  } catch {
    // Listener errors must not break transport streams.
  }
}
```

This second catch is at the transport layer, *before* events reach the
`wsNativeApi` fan-out and the store, so a throw here drops the event even more
silently. Note its comment text differs (`// Listener errors must not break
transport streams.`), so a grep for the `Swallow listener errors` string will NOT
find it — the verification must grep for the actual silent-catch shape, not that
one comment.

`grep -rn "Swallow listener errors" apps/web/src/wsNativeApi.ts` → 17 matches;
in `wsTransport.ts`, locate BOTH `catch {` blocks (around lines 321 and 363)
before editing — do not rely on the `Swallow listener errors` text there.

## Commands you will need

| Purpose             | Command                                                  | Expected on success |
| ------------------- | -------------------------------------------------------- | ------------------- |
| Web tests (focused) | `cd apps/web && bun run test src/storeSelectors.test.ts` | all pass            |
| Typecheck (web)     | `cd apps/web && bun run typecheck`                       | exit 0, no errors   |
| Full suite          | `bun run test`                                           | all pass            |

Repo rule (`AGENTS.md`): use `bun run test`, never `bun test`.

## Scope

**In scope**:

- `apps/web/src/components/chat/DockTerminalPane.tsx`
- `apps/web/src/components/chat/GitPanel.tsx`
- `apps/web/src/wsNativeApi.ts`
- `apps/web/src/wsTransport.ts` (BOTH swallowed catches: the connection-state one at ~321 and the push-stream fan-out one at ~363)
- `apps/web/src/storeSelectors.test.ts` (extend if adding a selector case)

**Out of scope** (do NOT touch):

- `createThreadSelector` / `createThreadWorkspaceMetadataSelector` implementations
  — reuse the existing selector, do not modify it.
- Listener isolation semantics — a throwing listener must STILL not break the loop
  for other listeners. Only add logging; do not change control flow.
- The store event switch itself — this plan makes failures observable, it does not
  fix any specific listener bug.

## Git workflow

- Branch: `advisor/009-web-streaming-quick-wins`
- Commit style: match `git log` (short imperative subjects). Two commits (Part A,
  Part B) is fine.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Swap `DockTerminalPane` to the shell-only selector

In `apps/web/src/components/chat/DockTerminalPane.tsx`:

- Update the import on line 18 from `createThreadSelector` to
  `createThreadWorkspaceMetadataSelector` (keep `createProjectSelector`).
- Replace the `thread` subscription (lines 29-31) with:

```ts
const workspace = useStore(
  useMemo(() => createThreadWorkspaceMetadataSelector(props.hostThreadId), [props.hostThreadId]),
);
```

- Replace `const worktreePath = thread?.worktreePath ?? null;` (line 35) with
  `const worktreePath = workspace.worktreePath ?? null;`.
- Confirm `thread` is not referenced anywhere else in the file after this
  (`grep -n "thread" apps/web/src/components/chat/DockTerminalPane.tsx`); the only
  use should have been `worktreePath`.

**Verify**: `cd apps/web && bun run typecheck` → exit 0.

### Step 2: Swap `GitPanel` to the shell-only selector

In `apps/web/src/components/chat/GitPanel.tsx`:

- Update the import on line 34 from `createThreadSelector` to
  `createThreadWorkspaceMetadataSelector` (keep `createProjectSelector`).
- Replace the `thread` subscription (lines 213-215) with the
  `createThreadWorkspaceMetadataSelector` form (as in Step 1, binding to
  `workspace`).
- Replace `const cwd = thread?.worktreePath ?? project?.cwd ?? null;` (line 219)
  with `const cwd = workspace.worktreePath ?? project?.cwd ?? null;`.
- Confirm no other `thread?.` access remains.

**Verify**: `cd apps/web && bun run typecheck` → exit 0.

### Step 3: Add a single listener-error logging helper and use it everywhere

At the top of `apps/web/src/wsNativeApi.ts`, add one helper (match the file's
existing style; if the repo has a shared logger utility, prefer it — check
`apps/web/src` for an existing `logger`/`log` util before adding a raw
`console.error`):

```ts
function reportListenerError(channel: string, error: unknown): void {
  // Keep listener isolation (loop continues) but make failures observable.
  console.error(`[ws:${channel}] listener threw`, error);
}
```

Then replace each `catch { // Swallow listener errors }` with
`catch (error) { reportListenerError("<channel>", error); }`, passing a stable
channel label per site (e.g. `"serverWelcome"`, `"serverConfigUpdated"`,
`"automationEvent"`, `"orchestration.domainEvent"`, `"orchestration.shellEvent"`,
`"orchestration.threadEvent"`, etc. — derive the label from the surrounding
`transport.subscribe(<CHANNEL>, …)` or function name so logs are diagnosable).

Do the same for **both** swallowed catches in `apps/web/src/wsTransport.ts`:
- the connection-state one (~line 321), label `"transport-state"`;
- the push-stream fan-out one (~line 363, inside the channel-listener loop),
  label `"transport-stream"` (or the channel if available at that point).

Do NOT change the loop structure — the `for … of` continues to the next listener;
you are only replacing the empty catch body.

**Verify**: neither `wsTransport.ts` catch remains empty — grep for the actual
shape, not the old comment text:
`grep -rn "Swallow listener errors" apps/web/src/wsNativeApi.ts` → **0 matches**;
`grep -n "catch {$\|catch {}" apps/web/src/wsTransport.ts` → **0 matches** (every
`catch` now binds `error` and logs); and confirm two `reportListenerError`/
`console.error` calls exist in `wsTransport.ts` (one per catch).
`cd apps/web && bun run typecheck` → exit 0.

### Step 4: Run tests

**Verify**: `cd apps/web && bun run test` → all pass. If a test asserts on
`console.error` not being called during WS event dispatch, that test is exercising
a real listener that throws — STOP and report (it means Part B surfaced a latent
bug, which is the point, but the operator should triage it).

## Test plan

- Part A: if `storeSelectors.test.ts` has a pattern for asserting a selector
  returns a stable reference when unrelated slices change, add/confirm a case that
  `createThreadWorkspaceMetadataSelector` returns the same reference when only
  `messages`/`activities` change. (It already has a case at line 124 — extend if
  natural, otherwise rely on the existing coverage since the selector itself is
  unchanged.)
- Part B: no new unit test required (pure logging addition); rely on typecheck +
  the full suite staying green. Optionally add a test that a throwing listener is
  isolated (other listeners still fire) AND `reportListenerError` is invoked, if
  the WS API has a testable surface for registering listeners.
- Verification: `cd apps/web && bun run test` → all pass.

## Done criteria

ALL must hold:

- [ ] `cd apps/web && bun run typecheck` exits 0.
- [ ] `grep -rn "Swallow listener errors" apps/web/src/` → 0 matches.
- [ ] `grep -n "catch {$\|catch {}" apps/web/src/wsTransport.ts` → 0 matches (both the connection-state AND the push-stream fan-out catch now bind `error` and log).
- [ ] `grep -n "createThreadSelector" apps/web/src/components/chat/DockTerminalPane.tsx apps/web/src/components/chat/GitPanel.tsx` → 0 matches (both now use the workspace metadata selector).
- [ ] `bun run test` exits 0.
- [ ] `bun run fmt` and `bun run lint` pass (final validation pass).
- [ ] No files outside the in-scope list are modified (`git status`).
- [ ] `plans/README.md` status row for 009 updated.

## STOP conditions

Stop and report back (do not improvise) if:

- Either component reads a `thread` field other than `worktreePath` (drift — the
  workspace metadata selector only exposes `envMode`/`worktreePath`; a broader
  read means the swap would drop data).
- The excerpts in "Current state" do not match the live code.
- A test starts failing because a real WS listener throws once logging surfaces it
  — report the listener/channel so it can be triaged separately (do not silence it
  again).

## Maintenance notes

- Other components subscribing to the full `Thread` only for shell metadata should
  migrate to `createThreadWorkspaceMetadataSelector` too — grep
  `createThreadSelector` for further candidates as a follow-up.
- Once listener errors are logged, watch for recurring `[ws:…] listener threw`
  entries — they indicate real store-reducer bugs previously hidden.
- Reviewer should scrutinize: that listener isolation is unchanged (one throwing
  listener still doesn't block the others) and that channel labels are accurate.
