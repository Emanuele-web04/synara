# Plan 008: Stop guessing ACP model config id when the session does not advertise one

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan in
> `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat dc66c88..HEAD -- apps/server/src/provider/acp/AcpSessionRuntime.ts apps/server/src/provider/acp/AcpJsonRpcConnection.test.ts apps/server/src/provider/Layers/DevinAdapter.ts apps/server/src/provider/Layers/DevinAdapter.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: MED
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `dc66c88`, 2026-06-11

## Why this matters

The ACP runtime currently falls back to config id `"model"` when a session did
not advertise a model config option. That is not capability-honest: if Devin or
another ACP provider uses a different model config id, or exposes no model option,
Synara still sends `session/set_config_option` to a guessed id. This plan makes
model switching fail early with a clear error instead of relying on a magic id.

## Current state

- `apps/server/src/provider/acp/AcpSessionRuntime.ts:457-465` stores an optional
  `modelConfigId` from session setup:

```ts
yield* Ref.set(modeStateRef, parseSessionModeState(sessionSetupResult));
yield* Ref.set(configOptionsRef, sessionConfigOptionsFromSetup(sessionSetupResult));

const nextState = {
  sessionId,
  initializeResult,
  sessionSetupResult,
  modelConfigId: extractModelConfigId(sessionSetupResult),
} satisfies AcpStartedState;
```

- `apps/server/src/provider/acp/AcpSessionRuntime.ts:565-568` guesses `"model"`
  when no config id was discovered:

```ts
setModel: (model) =>
  getStartedState.pipe(
    Effect.flatMap((started) => setConfigOption(started.modelConfigId ?? "model", model)),
    Effect.asVoid,
  ),
```

- `apps/server/src/provider/acp/AcpSessionRuntime.ts:275-283` validates known config
  options but deliberately returns success when a config id is unknown:

```ts
const configOption = findSessionConfigOption(yield* Ref.get(configOptionsRef), configId);
if (!configOption) {
  return;
}
```

- `apps/server/src/provider/Layers/DevinAdapter.ts:388-395` and `582-589` map
  `setModel` failures into provider adapter errors:

```ts
yield* acp
  .setModel(selectedModel)
  .pipe(
    Effect.mapError((error) =>
      mapAcpToAdapterError(PROVIDER, input.threadId, "session/set_model", error),
    ),
  );
```

Repo conventions:

- ACP runtime errors use `effect-acp/errors` classes such as `AcpRequestError` or
  `AcpTransportError`.
- Adapter code maps ACP errors using `mapAcpToAdapterError`.
- Use `bunx vitest run <file>` for focused tests.

## Commands you will need

| Purpose | Command | Expected on success |
| --- | --- | --- |
| ACP runtime tests | `bunx vitest run apps/server/src/provider/acp/AcpJsonRpcConnection.test.ts` | all pass |
| Devin adapter tests | `bunx vitest run apps/server/src/provider/Layers/DevinAdapter.test.ts` | all pass |
| Provider tests | `bunx vitest run apps/server/src/provider/**/*.test.ts` | all pass or existing skips only |
| Final gate | `bun fmt && bun lint && bun typecheck` | exits 0; lint has 0 errors |

## Scope

**In scope** (only files to modify):

- `apps/server/src/provider/acp/AcpSessionRuntime.ts`
- `apps/server/src/provider/acp/AcpJsonRpcConnection.test.ts`
- `apps/server/src/provider/Layers/DevinAdapter.test.ts` (only if adapter expectations need updating)
- `plans/README.md` (status row only)

**Out of scope** (do NOT touch):

- Provider capability flags in `DevinAdapter.ts` unless a test proves they are now false in a live-supported case.
- `packages/effect-acp/**`.
- `packages/contracts/**`.
- Web UI model picker behavior.

## Git workflow

- Branch: current branch `devin-acp-provider-v2`.
- Commit per logical unit; message style: short imperative sentence.
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Make `setModel` fail when no model config id exists

In `AcpSessionRuntime.ts`, change `setModel` to check `started.modelConfigId`.
If it is missing, fail with `new EffectAcpErrorsRuntime.AcpRequestError(...)` or
the equivalent runtime import already used in this file. Use a clear message:

```ts
"ACP session did not advertise a model config option."
```

Include diagnostic data such as available config option ids from `configOptionsRef`.
Do not call `setConfigOption("model", model)` when `modelConfigId` is undefined.

Suggested shape:

```ts
setModel: (model) =>
  getStartedState.pipe(
    Effect.flatMap((started) => {
      if (!started.modelConfigId) {
        return Effect.flatMap(Ref.get(configOptionsRef), (configOptions) =>
          Effect.fail(new EffectAcpErrorsRuntime.AcpRequestError({
            code: -32602,
            errorMessage: "ACP session did not advertise a model config option.",
            data: { requestedModel: model, configOptionIds: configOptions.map((option) => option.id) },
          })),
        );
      }
      return setConfigOption(started.modelConfigId, model);
    }),
    Effect.asVoid,
  ),
```

Adapt imports/names to the actual file. Keep the error channel as
`EffectAcpErrors.AcpError`.

**Verify**: `bunx vitest run apps/server/src/provider/acp/AcpJsonRpcConnection.test.ts` should fail until Step 2 tests and any existing expectations are updated.

### Step 2: Add ACP runtime tests

In `AcpJsonRpcConnection.test.ts`, add or update tests:

1. `setModel fails clearly when no model config option is advertised`
   - Use the existing mock ACP agent setup where `sessionSetupResult` lacks
     `configOptions` or has no `category: "model"` option.
   - Start the runtime, call `runtime.setModel("some-model")`, flip the Effect,
     and assert the error message contains `did not advertise a model config option`.
   - Assert no `session/set_config_option` request was started for config id `model`.
2. Preserve the existing happy path where a model config option exists and
   `setModel` uses the advertised id.

If the mock agent currently always exposes a model config option, extend the test
mock configuration locally in the test file. Do not alter production code for test
only.

**Verify**: `bunx vitest run apps/server/src/provider/acp/AcpJsonRpcConnection.test.ts` → all pass.

### Step 3: Confirm Devin adapter error mapping remains actionable

Run `bunx vitest run apps/server/src/provider/Layers/DevinAdapter.test.ts`. If an
existing test now fails because the mock runtime's `start()` returns
`modelConfigId: undefined` and a test calls `setModel`, update that test setup to
include a model config option or a mock `setModel` implementation that reflects the
scenario under test.

Do not change Devin capability flags in this plan unless tests prove the adapter
cannot model-switch even when a model config option exists.

**Verify**: `bunx vitest run apps/server/src/provider/Layers/DevinAdapter.test.ts` → all pass.

### Step 4: Final verification

Run:

1. `bunx vitest run apps/server/src/provider/acp/AcpJsonRpcConnection.test.ts apps/server/src/provider/Layers/DevinAdapter.test.ts` → all pass.
2. `bunx vitest run apps/server/src/provider/**/*.test.ts` → all pass or existing skips only.
3. `bun fmt && bun lint && bun typecheck` → exits 0; lint has 0 errors.

## Test plan

- `AcpJsonRpcConnection.test.ts`: missing model config id fails early and does not
  send guessed `session/set_config_option` for `"model"`; advertised config id
  still works.
- Existing Devin adapter tests should remain green.

## Done criteria

- [ ] `AcpSessionRuntime.setModel` no longer contains `?? "model"`.
- [ ] Missing model config id fails with a clear ACP error before sending
      `session/set_config_option`.
- [ ] Happy-path model switching still uses the advertised model config id.
- [ ] `bunx vitest run apps/server/src/provider/acp/AcpJsonRpcConnection.test.ts apps/server/src/provider/Layers/DevinAdapter.test.ts` exits 0.
- [ ] `bunx vitest run apps/server/src/provider/**/*.test.ts` exits 0 or only existing skips remain.
- [ ] `bun fmt && bun lint && bun typecheck` exits 0.
- [ ] No files outside the in-scope list are modified except `plans/README.md` status row.

## STOP conditions

- The current `setModel` implementation no longer matches the excerpt.
- Effect error imports are unclear and changing them would require broad ACP
  runtime refactors.
- Fixing this appears to require changing public contracts or web UI behavior.
- A verification command fails twice after a reasonable fix attempt.

## Maintenance notes

- Future ACP providers should not rely on magic config ids. The session setup
  response is the source of truth for model config id.
- Reviewer should check that the error is surfaced cleanly through Devin adapter
  `session/set_model` mapping.
