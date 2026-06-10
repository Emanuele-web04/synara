# Plan 007: Make Devin slash-command discovery thread-scoped and prove ACP runtime command updates

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan in
> `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat dc66c88..HEAD -- apps/server/src/provider/Layers/DevinAdapter.ts apps/server/src/provider/Layers/DevinAdapter.test.ts apps/server/src/provider/acp/AcpSessionRuntime.ts apps/server/src/provider/acp/AcpJsonRpcConnection.test.ts apps/server/src/provider/acp/AcpRuntimeModel.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: MED
- **Depends on**: none
- **Category**: bug, tests
- **Planned at**: commit `dc66c88`, 2026-06-11

## Why this matters

Plan 004 added native Devin slash-command discovery. The adapter now supports
`listCommands`, but if a caller supplies a `threadId` and that thread has no live
session, the code falls back to any other active Devin session with commands. That
can leak workspace/session-specific command names into the wrong thread. The shared
ACP runtime also stores `available_commands_update`, but the current tests only
prove parsing, not that the runtime ref updates and `getAvailableCommands` returns
the new commands.

## Current state

- `apps/server/src/provider/Layers/DevinAdapter.ts:848-865` currently falls back
  across sessions even when a specific `threadId` was supplied:

```ts
listCommands: (input) =>
  Effect.gen(function* () {
    const ctx = input.threadId
      ? sessions.get(ThreadId.makeUnsafe(input.threadId))
      : undefined;
    if (ctx && !ctx.stopped) {
      const commands = yield* ctx.acp.getAvailableCommands;
      return { commands, source: "devin.acp", cached: false };
    }
    for (const candidate of sessions.values()) {
      if (candidate.stopped) continue;
      const commands = yield* candidate.acp.getAvailableCommands;
      if (commands.length > 0) {
        return { commands, source: "devin.acp", cached: false };
      }
    }
    return { commands: [], source: "devin.acp", cached: false };
  }),
```

- `apps/server/src/provider/Layers/DevinAdapter.test.ts:521-568` covers the happy
  path and no-session path, but not a supplied `threadId` that points to a missing
  or stopped session while another session has commands.

- `apps/server/src/provider/acp/AcpSessionRuntime.ts:600-625` updates an internal
  ref for `AvailableCommandsUpdated`:

```ts
for (const event of parsed.events) {
  if (event._tag === "AvailableCommandsUpdated") {
    yield* Ref.set(availableCommandsRef, event.commands);
  }
  // ... other event handling
}
```

- `apps/server/src/provider/acp/AcpSessionRuntime.ts:517-521` exposes the ref:

```ts
getEvents: () => Stream.fromQueue(eventQueue),
getModeState: Ref.get(modeStateRef),
getConfigOptions: Ref.get(configOptionsRef),
getAvailableCommands: Ref.get(availableCommandsRef),
```

- `apps/server/src/provider/acp/AcpRuntimeModel.test.ts:485-564` only proves
  `parseSessionUpdateEvent` maps `available_commands_update` into an
  `AvailableCommandsUpdated` event.

Repo conventions:

- ACP runtime integration tests already live in
  `apps/server/src/provider/acp/AcpJsonRpcConnection.test.ts` and use a mock ACP
  agent script plus `AcpSessionRuntime.layer`.
- Use `bunx vitest run <file>` for focused tests. Do not use `bun run test -- <path>`.

## Commands you will need

| Purpose | Command | Expected on success |
| --- | --- | --- |
| Devin adapter tests | `bunx vitest run apps/server/src/provider/Layers/DevinAdapter.test.ts` | all pass |
| ACP runtime tests | `bunx vitest run apps/server/src/provider/acp/AcpJsonRpcConnection.test.ts apps/server/src/provider/acp/AcpRuntimeModel.test.ts` | all pass |
| Provider tests | `bunx vitest run apps/server/src/provider/**/*.test.ts` | all pass or existing skips only |
| Final gate | `bun fmt && bun lint && bun typecheck` | exits 0; lint has 0 errors |

## Scope

**In scope** (only files to modify):

- `apps/server/src/provider/Layers/DevinAdapter.ts`
- `apps/server/src/provider/Layers/DevinAdapter.test.ts`
- `apps/server/src/provider/acp/AcpJsonRpcConnection.test.ts`
- `apps/server/src/provider/acp/AcpRuntimeModel.test.ts` (only if needed for helper reuse)
- `plans/README.md` (status row only)

**Out of scope** (do NOT touch):

- `packages/contracts/**` — command result shape is already sufficient.
- `packages/effect-acp/**` — schema already has `available_commands_update`.
- `apps/web/**` — composer UI is presentation-only here.
- Adding a static Devin command catalog. Runtime discovery remains full-discovery-first.

## Git workflow

- Branch: current branch `devin-acp-provider-v2`.
- Commit per logical unit; message style: short imperative sentence.
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Make `listCommands` honor a supplied thread id strictly

In `DevinAdapter.ts`, change `listCommands` so a supplied `input.threadId` never
falls back to another session.

Target behavior:

- If `input.threadId` is supplied and the matching session exists and is not
  stopped, return that session's commands.
- If `input.threadId` is supplied and no live matching session exists, return
  `{ commands: [], source: "devin.acp", cached: false }`.
- If `input.threadId` is omitted, keep the existing fallback across live sessions.

This preserves provider-global discovery for callers that do not specify a thread,
while preventing cross-thread leakage for scoped calls.

**Verify**: `bunx vitest run apps/server/src/provider/Layers/DevinAdapter.test.ts` should pass after Step 2 tests are added.

### Step 2: Add adapter tests for command scoping

In `DevinAdapter.test.ts`, add tests:

1. `does not return commands from another Devin session when threadId is unknown`
   - Start session A with commands.
   - Call `adapter.listCommands!({ provider: "devin", cwd: "/tmp/project", threadId: "missing-thread" })`.
   - Assert `commands` is `[]`.
2. `returns provider-global commands from any live session when threadId is omitted`
   - Start session A with commands.
   - Call `adapter.listCommands!({ provider: "devin", cwd: "/tmp/project" })`.
   - Assert commands from session A are returned.
3. If test setup can cheaply create and stop a second session, add:
   `does not return commands from a stopped matching session`.

Use `ThreadId.makeUnsafe("thread-other")` for a second real session id if needed.

**Verify**: `bunx vitest run apps/server/src/provider/Layers/DevinAdapter.test.ts` → all pass.

### Step 3: Add ACP runtime coverage for stored command updates

Add a test in `AcpJsonRpcConnection.test.ts` proving the full runtime updates
`getAvailableCommands` after receiving an ACP `available_commands_update`.

Use the existing mock-agent test style in the file. If the current mock agent can
be extended to emit a `session/update` notification, do that. The test should:

- Build `AcpSessionRuntime.layer` with the mock agent.
- Start the runtime.
- Trigger or wait for an `available_commands_update` notification with commands
  such as `/revert` and `/steps`.
- Assert `yield* runtime.getAvailableCommands` equals normalized commands.

If `AcpJsonRpcConnection.test.ts`'s mock agent cannot emit session updates without
a large rewrite, create a narrow test-only helper in the same test file rather than
changing production code. Do not add sleeps; use deterministic synchronization.

**Verify**: `bunx vitest run apps/server/src/provider/acp/AcpJsonRpcConnection.test.ts apps/server/src/provider/acp/AcpRuntimeModel.test.ts` → all pass.

### Step 4: Final verification

Run:

1. `bunx vitest run apps/server/src/provider/Layers/DevinAdapter.test.ts apps/server/src/provider/acp/AcpJsonRpcConnection.test.ts apps/server/src/provider/acp/AcpRuntimeModel.test.ts` → all pass.
2. `bunx vitest run apps/server/src/provider/**/*.test.ts` → all pass or existing skips only.
3. `bun fmt && bun lint && bun typecheck` → exits 0; lint has 0 errors.

## Test plan

- `DevinAdapter.test.ts`: scoped thread id cannot receive commands from another
  session; omitted thread id can use any live session.
- `AcpJsonRpcConnection.test.ts`: runtime stores `available_commands_update` and
  exposes it through `getAvailableCommands`.
- Keep existing `AcpRuntimeModel.test.ts` parser tests unchanged unless a helper
  needs minor adjustment.

## Done criteria

- [ ] `listCommands` returns another session's commands only when `threadId` is omitted.
- [ ] `listCommands` with a missing/stopped supplied `threadId` returns `commands: []`.
- [ ] A runtime-level test proves `available_commands_update` updates `getAvailableCommands`.
- [ ] `bunx vitest run apps/server/src/provider/Layers/DevinAdapter.test.ts apps/server/src/provider/acp/AcpJsonRpcConnection.test.ts apps/server/src/provider/acp/AcpRuntimeModel.test.ts` exits 0.
- [ ] `bunx vitest run apps/server/src/provider/**/*.test.ts` exits 0 or only existing skips remain.
- [ ] `bun fmt && bun lint && bun typecheck` exits 0.
- [ ] No files outside the in-scope list are modified except `plans/README.md` status row.

## STOP conditions

- The `listCommands` code does not match the excerpt in Current state.
- The ACP runtime test requires modifying `packages/effect-acp/**` or production
  runtime code just to expose test hooks.
- Deterministic testing of `available_commands_update` is not possible with the
  existing mock-agent setup without sleeps or timing hacks.
- A verification command fails twice after a reasonable fix attempt.

## Maintenance notes

- If future UI calls command discovery without a thread id before any Devin
  session exists, it will still receive an empty list. That is intentional until
  Devin supports provider-global command discovery outside a live ACP session.
- Reviewer should check that thread-scoped discovery cannot leak commands across
  projects/worktrees.
