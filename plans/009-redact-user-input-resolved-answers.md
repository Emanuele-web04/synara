# Plan 009: Redact persisted user-input resolved answers across providers

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan in
> `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat dc66c88..HEAD -- packages/contracts/src/providerRuntime.ts apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.test.ts apps/web/src/session-logic.ts apps/web/src/store.ts packages/shared/src/threadSummary.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: HIGH
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `dc66c88`, 2026-06-11

## Why this matters

Multiple providers emit `user-input.resolved` events containing the user's answer
map. Those answers are ingested into orchestration activities and can be persisted
in timeline/projection data. Devin form elicitation increases the risk because ACP
forms can ask for arbitrary structured values, potentially including credential-like
or private data. This is a cross-provider data-retention policy issue; fix it once
at the contract/ingestion seam rather than only inside Devin.

## Current state

- `packages/contracts/src/providerRuntime.ts` defines resolved payloads as raw
  answer maps:

```ts
// packages/contracts/src/providerRuntime.ts:475-478
const UserInputResolvedPayload = Schema.Struct({
  answers: Schema.Record({ key: Schema.String, value: UserInputAnswer }),
});
export type UserInputResolvedPayload = typeof UserInputResolvedPayload.Type;
```

- `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts:740-751`
  stores answers in activity payloads:

```ts
case "user-input.resolved": {
  return [
    {
      id: event.eventId,
      createdAt: event.createdAt,
      tone: "info",
      kind: "user-input.resolved",
      summary: "User input submitted",
      payload: toActivityPayload({
        ...(event.requestId ? { requestId: event.requestId } : {}),
        answers: event.payload.answers,
      }),
      turnId: toTurnId(event.turnId) ?? null,
      ...maybeSequence,
    },
  ];
}
```

- `ProviderRuntimeIngestion.ts:2002-2013` uses the raw answers for runtime-mode
  inference:

```ts
if (event.type === "user-input.resolved") {
  const inferredRuntimeMode = inferRuntimeModeFromUserInputAnswers(event.payload.answers);
  if (inferredRuntimeMode && inferredRuntimeMode !== thread.runtimeMode) {
    // dispatch runtime-mode update
  }
}
```

- Existing providers emit raw answer maps. Examples:

```ts
// apps/server/src/provider/Layers/CursorAdapter.ts:678-684
yield* offerRuntimeEvent({
  type: "user-input.resolved",
  // ...
  payload: { answers: resolved },
});
```

```ts
// apps/server/src/provider/Layers/DevinAdapter.ts:356-364
yield* publish({
  type: "user-input.resolved",
  // ...
  payload: { answers: resolved },
});
```

- Web/shared consumers inspect user-input resolved activities. Search before
  changing shapes:
  `grep -rn "user-input.resolved\|answers" apps/web packages/shared apps/server/src/orchestration --include='*.ts' --include='*.tsx'`.

Repo conventions:

- `packages/contracts` is schema-only. Keep runtime redaction logic outside it.
- Server ingestion is the right persistence seam: adapters can still return full
  answers to providers, while persisted activities can be redacted.
- This plan has higher risk because it changes stored/displayed activity payloads.

## Commands you will need

| Purpose | Command | Expected on success |
| --- | --- | --- |
| Contracts tests | `bunx vitest run packages/contracts/src/providerRuntime.test.ts` | all pass |
| Ingestion tests | `bunx vitest run apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.test.ts` | all pass |
| Web/store tests | `bunx vitest run apps/web/src/store.test.ts apps/web/src/session-logic.test.ts` | all pass |
| Shared tests | `bunx vitest run packages/shared/src/threadSummary.test.ts` | all pass if file exists; otherwise skip with note |
| Final gate | `bun fmt && bun lint && bun typecheck` | exits 0; lint has 0 errors |

## Scope

**In scope** (only files to modify):

- `packages/contracts/src/providerRuntime.ts`
- `packages/contracts/src/providerRuntime.test.ts`
- `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts`
- `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.test.ts`
- `apps/web/src/store.ts`
- `apps/web/src/store.test.ts`
- `apps/web/src/session-logic.ts`
- `apps/web/src/session-logic.test.ts`
- `packages/shared/src/threadSummary.ts`
- matching `packages/shared/src/threadSummary.test.ts` if it exists
- `plans/README.md` (status row only)

**Out of scope** (do NOT touch):

- Provider adapter response paths. Providers still need full answers to complete
  their own request.
- Historical data migrations. This plan changes behavior for newly ingested events;
  backfill can be separate if needed.
- Secret detection heuristics based on answer text. Prefer structural redaction over
  trying to guess whether a value is sensitive.

## Git workflow

- Branch: current branch `devin-acp-provider-v2`.
- Commit per logical unit; message style: short imperative sentence.
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Decide the redacted payload contract at the ingestion boundary

Do not remove `answers` from the provider runtime event contract in Step 1; adapters
and runtime-mode inference currently need it. Instead, redact when converting runtime
events into persisted orchestration activities.

Target persisted activity payload shape:

```ts
{
  requestId?: string;
  answeredQuestionIds: string[];
  redacted: true;
}
```

The provider runtime event still carries raw `event.payload.answers` in memory long
enough for runtime-mode inference, but `toActivityPayload` should receive the
redacted shape.

**Verify**: no command yet; proceed to Step 2.

### Step 2: Redact in `ProviderRuntimeIngestion.ts`

Add a small local helper near the activity conversion helpers:

```ts
function redactedUserInputResolvedPayload(event: Extract<ProviderRuntimeEvent, { type: "user-input.resolved" }>) {
  return {
    ...(event.requestId ? { requestId: event.requestId } : {}),
    answeredQuestionIds: Object.keys(event.payload.answers).sort(),
    redacted: true,
  };
}
```

If sorting triggers lint warnings (`Array#sort()`), use the repo-preferred safe form
such as `toSorted()`.

Change only the activity payload for `user-input.resolved` to use this helper.
Keep the later `inferRuntimeModeFromUserInputAnswers(event.payload.answers)` logic
unchanged so behavior still works before persistence.

**Verify**: `bunx vitest run apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.test.ts` should fail until Step 3 expectations are updated.

### Step 3: Update ingestion tests

Update `ProviderRuntimeIngestion.test.ts` tests that expect raw answers in
activities. Expected activity payload should include `answeredQuestionIds` and
`redacted: true`, not answer values.

Add a regression test:

- Ingest a `user-input.resolved` event with answers containing a credential-like
  value such as `"secret-value"`.
- Assert the resulting activity payload JSON/stringified payload does not contain
  that value.
- Assert the activity still contains the request id and answered question id.

Do not reproduce real secrets in tests.

**Verify**: `bunx vitest run apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.test.ts` → all pass.

### Step 4: Update web/shared consumers of resolved activities

Search for consumers that read `activity.payload.answers` for `user-input.resolved`.
Likely files from current grep include:

- `apps/web/src/store.ts`
- `apps/web/src/session-logic.ts`
- `packages/shared/src/threadSummary.ts`

Update them to use redacted payload semantics. For UI copy/summary, show that input
was submitted and optionally how many fields were answered, but never display answer
values.

Keep compatibility only if needed for already-persisted activities. If the existing
app must load old local state, add narrow read-side tolerance for old `answers` shape
without continuing to write it. Do not add broad compatibility sludge.

**Verify**: `bunx vitest run apps/web/src/store.test.ts apps/web/src/session-logic.test.ts` → all pass.

### Step 5: Consider contract test update only if needed

If `packages/contracts/src/providerRuntime.test.ts` only verifies the runtime event
schema, leave it as raw answers. If you add a new redacted activity payload type in
contracts, update tests accordingly.

**Verify**: `bunx vitest run packages/contracts/src/providerRuntime.test.ts` → all pass.

### Step 6: Final verification

Run:

1. `bunx vitest run apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.test.ts apps/web/src/store.test.ts apps/web/src/session-logic.test.ts packages/contracts/src/providerRuntime.test.ts` → all pass.
2. If `packages/shared/src/threadSummary.test.ts` exists, run it too.
3. `bun fmt && bun lint && bun typecheck` → exits 0; lint has 0 errors.

## Test plan

- Server ingestion test proves answer values are not persisted.
- Web/store/session tests prove the UI/state logic handles the redacted payload.
- Contract tests remain valid for in-memory provider runtime events unless a new
  contract type is introduced.

## Done criteria

- [ ] New `user-input.resolved` orchestration activities do not include raw answer values.
- [ ] Runtime-mode inference still uses in-memory raw answers before redaction.
- [ ] UI/shared summaries still show that user input was submitted without answer values.
- [ ] Tests include a credential-like dummy value and prove it is absent from persisted activity payload.
- [ ] Relevant focused tests exit 0.
- [ ] `bun fmt && bun lint && bun typecheck` exits 0.
- [ ] No files outside the in-scope list are modified except `plans/README.md` status row.

## STOP conditions

- Redacting persisted answers breaks a required UI flow that cannot work without
  answer values.
- Historical local state requires a migration rather than read-side tolerance.
- A public contract must be narrowed or removed to complete the change.
- A verification command fails twice after a reasonable fix attempt.

## Maintenance notes

- This plan intentionally redacts at ingestion, not adapter emission. Providers
  still need the answers to complete pending requests.
- Reviewer should inspect projection/timeline payloads to ensure no raw answer
  values are still persisted through a second path.
