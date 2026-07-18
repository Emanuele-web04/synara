# Effect ACP Deletion Plan

**Status:** Not started — planning only  
**Decision date:** 2026-07-18  
**Validated with:** Fable 5 High  
**Related PR:** [#390 — Add Kimi Code provider support](https://github.com/Emanuele-web04/synara/pull/390)

## Decision

Remove `effect-acp` from `main` before deciding whether to merge the Kimi provider.

Keep the Effect framework. Effect continues to own scopes, typed failures, queues, cancellation,
process supervision, teardown, and Synara lifecycle policy. The official
`@agentclientprotocol/sdk` becomes the only owner of standard ACP transport, validation, method
definitions, and request/response types.

PR #390 remains unmerged while Kimi cannot be tested with an authenticated account. After the
deletion lands on `main`, rebase the Kimi branch and port its small residual type surface to the new
ACP boundary. Do not keep `effect-acp` alive for an optional provider.

## Why deletion comes first

- Kimi is not currently a release candidate because there is no subscription/account-backed smoke
  test available.
- `effect-acp` is already only a transitional schema/error compatibility package; the official SDK
  owns the production wire.
- Deleting the compatibility layer now simplifies the permanent architecture without making a
  product decision about Kimi.
- PR #390 has five type-only `effect-acp` references and no Kimi-specific runtime codec or error
  construction. Its later port should be mechanical.
- The deletion must not wait indefinitely for a provider that may never be merged.

## Target architecture

Production ACP code may depend on:

1. `@agentclientprotocol/sdk` for the standard ACP protocol and types.
2. `effect` for Synara runtime and lifecycle ownership.
3. Two small local modules beside the ACP runtime:
   - `AcpErrors.ts`, containing only the Effect-native errors Synara still consumes;
   - `AcpExtensions.ts`, containing only the non-standard `session/set_model` types and the minimal
     config-option codecs that genuinely require runtime decoding.

The final tree must not contain:

- the `packages/effect-acp` package;
- imports from `effect-acp/schema` or `effect-acp/errors`;
- a replacement compatibility package, barrel, generated ACP schema, or private SDK-internal
  imports;
- a second JSON-RPC/NDJSON parser or fallback wire.

## Non-goals

- Do not remove or replace Effect.
- Do not change ACP queue sizes, frame limits, cancellation, session-update gating, teardown proof,
  tool-call merging, event ordering, or resume behavior.
- Do not upgrade `@agentclientprotocol/sdk` during this migration.
- Do not refactor unrelated provider architecture or large runtime files.
- Do not merge, redesign, or product-approve Kimi as part of this migration.

## Execution plan

### Phase 0 — Preflight and baseline

1. Start from current `main` in a clean isolated branch/worktree.
2. Keep unrelated local changes out of the migration.
3. Record the focused ACP baseline:
   - `AcpSessionRuntime.test.ts`;
   - `AcpRuntimeModel.test.ts`;
   - `AcpSdkConformance.test.ts`;
   - Grok, Droid, and Cursor ACP support tests.
4. Confirm the installed SDK remains pinned to the reviewed version before changing types.

### Phase 1 — Local Effect-native errors

Create `apps/server/src/provider/acp/AcpErrors.ts` with only:

- `AcpSpawnError`;
- `AcpTransportError`;
- `AcpRequestError`;
- the `AcpError` union/type.

Use the official SDK `ErrorCode` in `AcpRequestError`. Preserve the existing tagged-error behavior
needed by `Schema.is(...)` checks.

Do not port `AcpProtocolParseError`; it is unused. Do not port `AcpProcessExitedError`; its old
transport producer is gone. Delete the now-unreachable `AcpProcessExitedError` classification branch
from `AcpAdapterSupport.ts`.

Replace every `effect-acp/errors` import in the runtime, Grok, Droid, Cursor, and their tests. This
phase must be behavior-neutral.

**Gate:** server typecheck plus focused error/support tests.

### Phase 2 — Minimal extension surface

Create `apps/server/src/provider/acp/AcpExtensions.ts` containing only:

1. Small request/response TypeScript types for `session/set_model`, which is not part of the pinned
   official SDK method table.
2. A minimal Effect codec for the parts of `SessionConfigOption` Synara reads.
3. A minimal `SetSessionConfigOptionResponse` codec built from that config-option codec.

The two retained runtime decode sites are:

- the `session/set_config_option` response, because agents may return `{}` and publish the real
  options through a notification;
- the Cursor config-option extension response.

Anchor the local codec to `OfficialAcp.SessionConfigOption` with a compile-time compatibility check.
Do not import Zod validators or other files from SDK `dist/` internals.

**Gate:** server typecheck.

### Phase 3 — Shared ACP runtime seam

Migrate these shared files to official SDK types first:

- `AcpSessionRuntime.ts`;
- `AcpRuntimeModel.ts`;
- `AcpAdapterSessionSupport.ts`;
- `AcpElicitationSupport.ts`;
- their focused tests.

Required changes:

1. Replace standard `EffectAcpSchema.*` types with `OfficialAcp.*` types.
2. Apply the elicitation renames:
   - `ElicitationRequest` → `CreateElicitationRequest`;
   - `ElicitationResponse` → `CreateElicitationResponse`;
   - `ElicitationCompleteNotification` → `CompleteElicitationNotification`.
3. Delete the redundant Effect-Schema decode of `session/update`; the official SDK already validates
   it before invoking Synara's handler.
4. Delete `toOfficialMcpServers` and `toOfficialContentBlocks`. Construct fresh arrays only at
   readonly-to-mutable call sites when required.
5. Make elicitation handlers return the SDK response shape directly and delete the transitional
   response reshape.
6. Keep `officialSdkError()` as the single SDK-error-to-local-Effect-error translation.
7. Normalize SDK `null` values at consumption sites where Synara uses `undefined`; do not introduce
   compatibility aliases or unsafe casts.

**Gate:** shared runtime/model/conformance suites plus server typecheck.

### Phase 4 — Existing provider migration

Migrate one provider at a time in this order:

1. Grok;
2. Droid;
3. Cursor.

Use official SDK types directly. Cursor remains last because it owns the retained config-option
extension decode.

Run only each provider's focused tests during iteration. Do not run the full workspace suite after
every provider.

### Phase 5 — Zero-import gate and package deletion

Before deleting the package, prove there are zero source imports from `effect-acp`.

Then:

1. Remove `effect-acp` from `apps/server/package.json`.
2. Remove `packages/effect-acp/`.
3. Remove `packages/effect-acp/package.json` from
   `scripts/lib/release-workspace-manifests.ts`.
4. Remove the dead `effect-acp` engine option from the ACP wire benchmark script.
5. Regenerate `bun.lock` through the normal Bun install workflow.
6. Preserve historical audit, changelog, and benchmark-result references that describe past state;
   they are not live dependencies.

### Phase 6 — Final verification

Run one bundled final pass:

- `bun fmt`;
- `bun lint`;
- `bun typecheck`;
- `bun run test` — never `bun test`;
- relevant browser/build/Windows process checks in CI.

The ACP conformance and Grok/Droid/Cursor focused suites must match or improve on the Phase 0
baseline.

## Future Kimi handoff

Only after the deletion is complete:

1. Rebase PR #390 onto the new `main`.
2. Replace its five type-only `effect-acp` references with official SDK types and the local
   `AcpErrors.ts` type where required.
3. Replace Kimi's effect-acp-only plural `SessionConfigSelectOptions` type with the explicit SDK
   union:
   `ReadonlyArray<SessionConfigSelectOption> | ReadonlyArray<SessionConfigSelectGroup>`.
4. Confirm the Kimi branch does not recreate local standard ACP types or compatibility shims.
5. Run Kimi ACP support, adapter, registry, health, and integration tests.
6. Require an authenticated, account-backed `kimi acp` smoke test before making the final merge
   decision.

If Kimi is abandoned, no additional cleanup should be necessary on `main`.

## Stop conditions

Stop and report rather than forcing the migration if:

- type compatibility requires `as any`, a double cast, or importing SDK internals;
- a same-name official SDK type differs structurally beyond readonly or nullability friction;
- removing the redundant session-update decode changes persisted or projected behavior;
- any change would alter the production wire, queue/resource limits, cancellation, teardown, or
  resume semantics;
- focused tests reveal a behavioral regression instead of fixture-only type drift.

## Completion criteria

The migration is complete only when:

- the official SDK is the sole standard ACP type and wire authority;
- Effect still owns Synara runtime/lifecycle policy;
- live source imports from `effect-acp` are zero;
- `packages/effect-acp` and all live workspace/release/lockfile references are deleted;
- focused ACP gates and the final workspace verification are green;
- PR #390 is either still safely unmerged or rebased without reintroducing `effect-acp`.
