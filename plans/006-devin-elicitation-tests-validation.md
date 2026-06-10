# Plan 006: Harden Devin ACP form elicitation with adapter tests and server-side answer validation

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan in
> `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat dc66c88..HEAD -- apps/server/src/provider/Layers/DevinAdapter.ts apps/server/src/provider/Layers/DevinAdapter.test.ts apps/server/src/provider/acp/DevinElicitation.ts apps/server/src/provider/acp/DevinElicitation.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: security, tests
- **Planned at**: commit `dc66c88`, 2026-06-11

## Why this matters

Plan 003 added Devin ACP form elicitation, but the adapter tests only prove the
handler is registered and unknown request ids fail. They do not prove the real
flow: Devin asks a form question, Synara emits `user-input.requested`, the user
answers, Synara returns ACP `accept`, and a `user-input.resolved` event is emitted.
The server also currently accepts arbitrary answers for a pending request; a
client that bypasses the UI can submit values outside the ACP form schema. This
plan closes both gaps with behavior tests and server-side answer validation.

## Current state

- `apps/server/src/provider/Layers/DevinAdapter.ts` owns Devin sessions and the
  ACP handler registration. Current elicitation path:

```ts
// apps/server/src/provider/Layers/DevinAdapter.ts:331-369
yield* acp.handleElicitation((request) =>
  Effect.gen(function* () {
    if (request.mode !== "form") {
      return { action: { action: "decline" as const } };
    }
    const requestId = ApprovalRequestId.makeUnsafe(crypto.randomUUID());
    const runtimeRequestId = RuntimeRequestId.makeUnsafe(requestId);
    const answers = yield* Deferred.make<ProviderUserInputAnswers>();
    pendingUserInputs.set(requestId, { answers });
    yield* publish({
      type: "user-input.requested",
      ...(yield* makeEventStamp()),
      provider: PROVIDER,
      threadId: input.threadId,
      turnId: ctx?.activeTurnId,
      requestId: runtimeRequestId,
      payload: { questions: elicitationFormToUserInputQuestions(request) },
      raw: {
        source: "acp.jsonrpc",
        method: "session/elicitation",
        payload: request,
      },
    });
    const resolved = yield* Deferred.await(answers);
    pendingUserInputs.delete(requestId);
    yield* publish({
      type: "user-input.resolved",
      ...(yield* makeEventStamp()),
      provider: PROVIDER,
      threadId: input.threadId,
      turnId: ctx?.activeTurnId,
      requestId: runtimeRequestId,
      payload: { answers: resolved },
    });
    const content = userInputAnswersToElicitationContent(request, resolved);
    return Object.keys(content).length > 0
      ? { action: { action: "accept" as const, content } }
      : { action: { action: "cancel" as const } };
  }),
);
```

- `apps/server/src/provider/Layers/DevinAdapter.ts:88-90` currently stores only
  the deferred answer, not the original form request:

```ts
interface PendingUserInput {
  readonly answers: Deferred.Deferred<ProviderUserInputAnswers>;
}
```

- `apps/server/src/provider/Layers/DevinAdapter.ts:762-773` accepts any answer map
  for a pending request:

```ts
respondToUserInput: (threadId, requestId, answers) =>
  Effect.gen(function* () {
    const ctx = yield* requireSession(threadId);
    const pending = ctx.pendingUserInputs.get(requestId);
    if (!pending) {
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "session/elicitation",
        detail: `Unknown pending user-input request: ${requestId}`,
      });
    }
    yield* Deferred.succeed(pending.answers, answers);
  }),
```

- `apps/server/src/provider/acp/DevinElicitation.ts` maps answers to ACP content,
  but does not enforce enums, `oneOf`, array item constraints, or required fields:

```ts
// apps/server/src/provider/acp/DevinElicitation.ts:81-128
export function userInputAnswersToElicitationContent(
  request: ElicitationForm,
  answers: Record<string, string | ReadonlyArray<string> | null>,
): Record<string, ElicitationContentValue> {
  const schema = request.requestedSchema.properties;
  const content: Record<string, ElicitationContentValue> = {};
  // ... converts by property type, skips unknown keys, returns content
  return content;
}
```

- `apps/server/src/provider/Layers/DevinAdapter.test.ts` has only these elicitation
  adapter tests:

```ts
// apps/server/src/provider/Layers/DevinAdapter.test.ts:593-655
it.effect("respondToUserInput fails for unknown request id", () => { ... });
it.effect("registers elicitation handler during Devin session startup", () => { ... });
```

- The mock runtime already lets tests capture the handler:

```ts
// apps/server/src/provider/Layers/DevinAdapter.test.ts:20-45
readonly onHandleElicitation?: (handler: (...) => Effect.Effect<...>) => void;
handleElicitation: (handler) => {
  input?.onHandleElicitation?.(handler);
  return Effect.void;
},
```

Repo conventions:

- Tests use `@effect/vitest` with `it.effect`, `assert`, `Effect`, and `Stream`.
- Provider adapters publish `ProviderRuntimeEvent` values and expose them through
  `adapter.streamEvents`.
- Never run `bun test`; use `bunx vitest run <file>` or `bun run test` only when
  invoking a real package script without path forwarding.
- Per repo AGENTS.md, run `bun fmt && bun lint && bun typecheck` exactly once as
  the final heavy gate for an implementation task.

## Commands you will need

| Purpose | Command | Expected on success |
| --- | --- | --- |
| Elicitation helper tests | `bunx vitest run apps/server/src/provider/acp/DevinElicitation.test.ts` | all pass |
| Devin adapter tests | `bunx vitest run apps/server/src/provider/Layers/DevinAdapter.test.ts` | all pass |
| Provider tests | `bunx vitest run apps/server/src/provider/**/*.test.ts` | all pass or existing skips only |
| Final gate | `bun fmt && bun lint && bun typecheck` | exits 0; lint has 0 errors |

## Scope

**In scope** (only files to modify):

- `apps/server/src/provider/acp/DevinElicitation.ts`
- `apps/server/src/provider/acp/DevinElicitation.test.ts`
- `apps/server/src/provider/Layers/DevinAdapter.ts`
- `apps/server/src/provider/Layers/DevinAdapter.test.ts`
- `plans/README.md` (status row only)

**Out of scope** (do NOT touch):

- `packages/contracts/**` — no contract shape changes in this plan.
- Other provider adapters — redaction across all providers is Plan 009.
- `AcpSessionRuntime.ts` / `effect-acp` — this plan only consumes the existing
  ACP elicitation types.
- UI behavior in `apps/web/**`.

## Git workflow

- Branch: current branch `devin-acp-provider-v2`.
- Commit per logical unit; message style: short imperative sentence, e.g.
  `Harden Devin elicitation answer handling`.
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Add explicit answer validation helpers

In `apps/server/src/provider/acp/DevinElicitation.ts`, add an exported helper that
validates a submitted answer map against a form request before the adapter resolves
the deferred. Keep it pure and total.

Suggested shape:

```ts
export interface DevinElicitationValidationResult {
  readonly valid: boolean;
  readonly issues: ReadonlyArray<string>;
}

export function validateUserInputAnswersForElicitation(
  request: ElicitationForm,
  answers: Record<string, string | ReadonlyArray<string> | null>,
): DevinElicitationValidationResult { ... }
```

Validation rules:

- Unknown keys are invalid when `requestedSchema.properties` exists, except the
  synthetic `response` key when properties are empty/missing.
- Required properties from `requestedSchema.required` must be present with a
  non-null value.
- `string` enum answers must be one of `prop.enum`.
- `string` `oneOf` answers must be one of `prop.oneOf[].const`.
- `boolean` answers must be `Yes`, `No`, `true`, or `false` case-insensitively.
- `number` / `integer` answers must parse to finite numbers; integers must satisfy
  `Number.isInteger`.
- `array` answers must be arrays, or a single string that can be wrapped. If items
  have `enum` or `anyOf`, every selected value must be allowed.
- Null means skipped; null is invalid only when the field is required.

Do not throw. Return `valid: false` with human-readable issue strings.

**Verify**: `bunx vitest run apps/server/src/provider/acp/DevinElicitation.test.ts` should fail until Step 2 tests are added and implementation is complete.

### Step 2: Add helper tests for invalid answers

Extend `apps/server/src/provider/acp/DevinElicitation.test.ts` with tests for the
new validation helper:

- rejects a string enum value not in the enum.
- rejects a string `oneOf` value not in the allowed constants.
- rejects an array enum value containing an unlisted item.
- rejects missing required answers.
- rejects non-integer text for an `integer` property.
- accepts the existing valid cases already tested for content conversion.

Keep existing conversion tests. They should still pass.

**Verify**: `bunx vitest run apps/server/src/provider/acp/DevinElicitation.test.ts` → all pass.

### Step 3: Store the original form request with pending user input

Update `PendingUserInput` in `DevinAdapter.ts` to include the original form
request. Use the ACP type locally:

```ts
type DevinFormElicitationRequest = Extract<EffectAcpSchema.ElicitationRequest, { mode: "form" }>;

interface PendingUserInput {
  readonly request: DevinFormElicitationRequest;
  readonly answers: Deferred.Deferred<ProviderUserInputAnswers>;
}
```

When registering the handler, change `pendingUserInputs.set(requestId, { answers });`
to store `{ request, answers }`.

**Verify**: `bunx vitest run apps/server/src/provider/Layers/DevinAdapter.test.ts` should still compile or fail only where Step 4 validation is not wired yet.

### Step 4: Validate answers in `respondToUserInput`

In `respondToUserInput`, after finding `pending`, call the validation helper with
`pending.request` and `answers`. If invalid, fail with `ProviderAdapterValidationError`.
Use operation/method wording that points at Devin elicitation, for example:

```ts
return yield* new ProviderAdapterValidationError({
  provider: PROVIDER,
  operation: "respondToUserInput",
  issue: `Invalid Devin elicitation answers: ${validation.issues.join("; ")}`,
});
```

Do not resolve the deferred on invalid input. Leave the pending request in place so
the user can answer again.

**Verify**: `bunx vitest run apps/server/src/provider/Layers/DevinAdapter.test.ts` → existing tests pass after Step 5 is complete.

### Step 5: Add end-to-end adapter tests for Devin elicitation

Extend `DevinAdapter.test.ts` using the existing `onHandleElicitation` hook.
Capture the handler in a local variable:

```ts
let elicitationHandler: Parameters<NonNullable<Parameters<typeof makeMockRuntime>[0]>["onHandleElicitation"]>[0] | undefined;
```

If that type is awkward, define a local explicit handler type using
`EffectAcpSchema.ElicitationRequest` and `EffectAcpSchema.ElicitationResponse`.

Add tests:

1. `publishes user-input.requested for a Devin form elicitation and resolves with accepted answers`
   - Start a session with `onHandleElicitation` capturing the handler.
   - Fork/run the handler with a form request containing a string enum question.
   - Read `adapter.streamEvents` until `user-input.requested` for this request appears.
   - Call `adapter.respondToUserInput(threadId, requestId, { choice: "a" })`.
   - Assert handler result is `{ action: { action: "accept", content: { choice: "a" } } }`.
   - Assert a `user-input.resolved` event follows.
2. `declines URL-mode elicitation without publishing user-input.requested`
   - Invoke handler with `mode: "url"` request.
   - Assert result is `{ action: { action: "decline" } }`.
   - Assert no `user-input.requested` event is emitted for that invocation. Use a small stream take/timeout pattern already used in nearby tests if present; avoid flaky sleeps.
3. `rejects invalid answers without resolving the pending Devin elicitation`
   - Trigger a form request with enum `a`/`b`.
   - Call `respondToUserInput(..., { choice: "not-allowed" })` and assert `ProviderAdapterValidationError`.
   - Then call `respondToUserInput(..., { choice: "a" })` and assert the original handler resolves successfully.
4. `stopSession settles pending user input with cancel`
   - Trigger a form elicitation, wait for `user-input.requested`, then call `adapter.stopSession(threadId)`.
   - Assert the handler resolves to `{ action: { action: "cancel" } }`.

Do not remove the existing unknown-request test; keep it.

**Verify**: `bunx vitest run apps/server/src/provider/Layers/DevinAdapter.test.ts` → all pass with at least four new meaningful elicitation tests.

### Step 6: Final verification

Run the provider tests and final gate:

1. `bunx vitest run apps/server/src/provider/acp/DevinElicitation.test.ts apps/server/src/provider/Layers/DevinAdapter.test.ts` → all pass.
2. `bunx vitest run apps/server/src/provider/**/*.test.ts` → all pass or existing skips only.
3. `bun fmt && bun lint && bun typecheck` → exits 0; lint has 0 errors.

## Test plan

- `DevinElicitation.test.ts`: new validation helper tests for invalid enum,
  oneOf, array item, required, and integer answers.
- `DevinAdapter.test.ts`: captured-handler tests for request publication, answer
  resolution, URL decline, invalid answer retry, and stop-session cancellation.
- Pattern exemplars: existing `DevinAdapter.test.ts` mock runtime, existing
  `DevinElicitation.test.ts` pure helper tests.

## Done criteria

- [ ] `PendingUserInput` stores the original form request.
- [ ] Invalid enum/oneOf/array/required/integer answers are rejected server-side.
- [ ] URL-mode elicitation is declined with a test proving it.
- [ ] Form elicitation publishes `user-input.requested`, accepts valid answers,
      and publishes `user-input.resolved` with tests proving it.
- [ ] `stopSession` settles a pending form elicitation as ACP `cancel` with a test.
- [ ] `bunx vitest run apps/server/src/provider/acp/DevinElicitation.test.ts apps/server/src/provider/Layers/DevinAdapter.test.ts` exits 0.
- [ ] `bunx vitest run apps/server/src/provider/**/*.test.ts` exits 0 or only existing skips remain.
- [ ] `bun fmt && bun lint && bun typecheck` exits 0.
- [ ] No files outside the in-scope list are modified except `plans/README.md` status row.

## STOP conditions

- The code at the locations in "Current state" does not match the excerpts.
- `ElicitationPropertySchema` shape differs from the assumptions above.
- Capturing the handler requires changes to `AcpSessionRuntime` or `effect-acp`.
- The test stream cannot observe `user-input.requested`/`resolved` without adding
  sleeps or timing hacks; stop and report the testing seam problem.
- A verification command fails twice after a reasonable fix attempt.

## Maintenance notes

- This plan validates Devin answers only. A separate Plan 009 handles redaction of
  resolved user-input answers across all providers.
- If Synara later adds native free-text question types, revisit the fallback
  `OK / Continue` mapping in `DevinElicitation.ts`.
- Reviewer should scrutinize that invalid answers do not complete the deferred and
  that pending entries are still cleaned up on stop/interrupt.
