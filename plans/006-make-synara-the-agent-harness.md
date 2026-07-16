# Plan 006: Make Synara the Authoritative Agent Harness

> **Executor instructions**: Follow this plan step by step. Run every focused
> verification command and confirm the expected result before moving on. If a
> STOP condition occurs, stop and report; do not improvise. Do not broaden this
> into an orchestration rewrite.
>
> **Drift check (run first)**:
> `git diff --stat b8ef45b03..HEAD -- packages/contracts/src apps/server/src/agentGateway apps/server/src/provider apps/server/src/codexAppServerManager.ts apps/server/src/orchestration apps/server/src/persistence`
> If an in-scope file changed, compare the current-state evidence below with the
> live implementation before editing.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: none
- **Category**: correctness / architecture
- **Planned at**: commit `b8ef45b03`, 2026-07-16

## Why this matters

An explicit request to start two Synara threads produced six threads. The
parent Grok turn first chose its provider-native `spawn_subagent` tool, ended,
and left background agents alive. Those detached agents later discovered
`synara_create_thread`, tried several invalid provider/model combinations, and
created a new durable thread on every retry. The parent therefore neither
waited for the requested two results nor synthesized them.

The fix must establish three independent layers:

1. **Model awareness** — every provider is told, through its strongest native
   instruction channel, that Synara is the hosting harness and that Synara
   resources are controlled through `synara_*` tools.
2. **Capability truth** — agents can ask Synara which providers, models,
   options, and orchestration operations are actually available; they do not
   guess model slugs or silently substitute providers.
3. **Server authority** — detached sessions, duplicate calls, unsupported
   targets, and second creation plans are rejected before a thread, branch, or
   worktree is created. Prompt compliance improves behavior but is never the
   safety boundary.

The target interaction for the original request is:

```text
user asks for exactly two Synara threads
  -> parent reads synara_context / synara_capabilities
  -> parent calls synara_create_threads once with exactly two entries
  -> gateway validates the entire batch before side effects
  -> gateway reserves one creation plan for this caller turn
  -> gateway creates exactly two threads with deterministic ids
  -> parent calls synara_wait_for_threads until both runs are terminal
  -> parent reports both results, including any failure
  -> parent never creates a replacement unless the user sends a new instruction
```

## Architectural invariants

- Synara is the harness; provider-native subagents are implementation details
  inside a provider turn and never substitute for user-requested Synara
  threads.
- All model-facing host text comes from one versioned
  `SynaraHarnessPolicy`. Provider adapters only choose the delivery mechanism.
- Every state-changing gateway call is bound to a live Synara provider session
  and its active caller turn. Read-only calls may remain available for the
  lifetime of the scoped provider session.
- A caller turn can commit at most one distinct thread-creation plan. A plural
  request is one batch; a replay of that batch returns the same result; a
  different second plan returns `creation_plan_locked`.
- Unsupported provider/model/options fail before `thread.create`, git branch,
  worktree, or provider side effects. Synara never interprets `Low` as part of
  a model slug: Codex Terra Low is `{ model: "gpt-5.6-terra", options:
{ reasoningEffort: "low" } }`.
- A failed worker is reported as failed. The gateway and host policy do not
  auto-replace it with another provider or model.
- Ordinary user-requested threads remain top-level in the sidebar. Provenance
  (`sourceThreadId`, `sourceTurnId`, `gatewayOperationId`) is persisted
  separately from `parentThreadId`, which remains reserved for true subagent
  hierarchy.
- Existing privilege and worktree isolation rules remain in force.

## Current state

### Host identity is not authoritative

- `apps/server/src/agentGateway/Layers/AgentGateway.ts:73-81` owns the only full
  “Synara is hosting this session / use synara\_\*” policy, but
  `AgentGateway.ts:943-950` sends it only as MCP initialize metadata. MCP clients
  are not guaranteed to promote server instructions into the model's persistent
  system/developer context.
- `apps/server/src/provider/Layers/ClaudeAdapter.ts:880-885` tells Claude it is
  running inside Synara, but does not define Synara-thread versus native
  subagent precedence.
- `apps/server/src/codexAppServerManager.ts:475-486,620-648` sends Codex
  developer instructions for collaboration mode, but those instructions do not
  include the Synara harness contract.
- Cursor, Grok, Gemini, and Droid receive MCP transport configuration and a
  Synara `clientInfo`, but no shared model-facing host policy. See
  `apps/server/src/agentGateway/mcpInjection.ts:91-117` and the adapter startup
  paths.
- `apps/server/src/provider/runtimeLayer.ts:54-70` explicitly excludes OpenCode
  and Kilo from MCP because their server process is pooled across threads. Pi
  has no MCP client support. These providers still need truthful host identity
  and a clear “Synara control unavailable” capability instead of pretending
  parity.

### Thread creation is neither validated nor idempotent

- `apps/server/src/agentGateway/Layers/AgentGateway.ts:133-154` validates only a
  static provider enum and accepts any non-empty model string.
- `AgentGateway.ts:170-177` generates random thread, command, and message ids on
  every call, bypassing the existing command-receipt deduplication in
  `apps/server/src/orchestration/Layers/OrchestrationEngine.ts:363-381`.
- `AgentGateway.ts:383-427` exposes a single free-form model slug and no
  provider-specific model options.
- `AgentGateway.ts:497-584` can create a worktree, commit `thread.create`, and
  only then dispatch `thread.turn.start`. A later failure can leave an orphan
  worktree or idle thread.
- `apps/server/src/agentGateway/Layers/AgentGateway.test.ts:475-493` explicitly
  codifies unlimited creation rather than retry safety.
- `packages/contracts/src/model.ts:102-165` already defines provider-specific
  model options, and `packages/contracts/src/providerDiscovery.ts:245-291`
  already describes runtime-discovered models, reasoning efforts, and other
  options. The gateway does not use them.

### Caller identity is too weak

- `apps/server/src/agentGateway/Services/AgentGatewayCredentials.ts:28-38` and
  `apps/server/src/agentGateway/tokens.ts` bind a stable token only to a thread.
- `AgentGateway.ts:83-90,986-1012` reduces invocation context to
  `callerThreadId`; it drops JSON-RPC request id, provider session, active turn,
  capabilities, and issuance/revocation state.
- A background native agent that retains the same MCP connection can therefore
  mutate Synara after the visible parent turn has completed.

### Coordination primitives are missing

- The gateway creates one thread at a time and reads one thread at a time.
- There is no exact batch operation, no pinned run id, no batch wait, and no
  durable operation handle. The model must improvise coordination and is
  tempted to retry creation when a child fails.

## Selective lessons from pingdotgg/t3code PR #2829

PR #2829 is a large, draft orchestration rewrite and is not an authority for
this change. Adopt only its narrow, proven shapes:

- an MCP invocation scope containing thread, provider session, provider, and
  capabilities;
- capability/model discovery before destructive dispatch;
- deterministic ids plus request keys reusing durable command receipts;
- batch thread creation and explicit thread waiting;
- separate provenance for agent/MCP-created work; and
- MCP annotations that distinguish read-only, destructive, and idempotent
  tools.

Relevant reference points:

- [MCP invocation scope](https://github.com/pingdotgg/t3code/blob/c14c9088e3df74c9c33f282c13906fb61b3f017e/apps/server/src/mcp/McpInvocationContext.ts)
- [Stable ids/request keys](https://github.com/pingdotgg/t3code/blob/c14c9088e3df74c9c33f282c13906fb61b3f017e/apps/server/src/mcp/OrchestratorMcpService.ts#L300-L350)
- [Provider/model target validation](https://github.com/pingdotgg/t3code/blob/c14c9088e3df74c9c33f282c13906fb61b3f017e/apps/server/src/mcp/OrchestratorMcpService.ts#L573-L658)
- [Batch creation](https://github.com/pingdotgg/t3code/blob/c14c9088e3df74c9c33f282c13906fb61b3f017e/apps/server/src/mcp/OrchestratorMcpService.ts#L1040-L1170)

Explicitly do **not** copy:

- the full V2 migration or its provider adapter rewrite;
- T3 naming (`t3-code`, `t3_*`) — Synara identity must remain consistent;
- client-request-id-only deduplication with a random fallback;
- a ten-minute default HTTP wait; use bounded rolling waits;
- an exclusive Claude `allowedTools: ["mcp__...__*"]` fallback, which can
  disable native Read/Bash/Edit tools; or
- client-facing “agent awareness” projection as a substitute for model-facing
  host instructions.

## Public API and contract changes

Create `packages/contracts/src/agentGateway.ts`, export it from
`packages/contracts/src/index.ts`, and define Effect Schemas for these payloads.
Do not keep hand-written, unvalidated `Record<string, unknown>` inputs for new
tools.

### `synara_context` (read-only, idempotent)

```ts
type SynaraContextResult = {
  harness: { name: "Synara"; policyVersion: string };
  caller: {
    threadId: ThreadId;
    turnId: TurnId | null;
    provider: ProviderKind;
    projectId: ProjectId;
  };
  capabilities: {
    threadRead: boolean;
    threadCreate: boolean;
    threadWait: boolean;
    automations: boolean;
  };
};
```

This tool makes host identity inspectable. It is not a substitute for native
system/developer instructions.

### `synara_capabilities` (read-only, idempotent)

Returns supported provider targets with canonical model slugs, option
descriptors, availability constraints, and gateway limits. It must expose the
same model data used by target validation.

### `synara_create_threads` (destructive, idempotent with request id)

```ts
type SynaraCreateThreadsInput = {
  requestId: string; // required, max 256 chars
  threads: ReadonlyArray<{
    prompt: string;
    title?: string;
    target: ModelSelection; // includes provider-specific options
    projectId?: ProjectId;
    environment?: "local" | "worktree";
    baseBranch?: string;
    branchName?: string;
    runtimeMode?: "approval-required" | "full-access";
  }>;
};
```

Rules:

- 1–20 entries, validated as one plan.
- The array length is the exact committed count.
- All entries preflight successfully before any side effect.
- The active caller turn may commit only one distinct creation plan.
- Repeating the same `(callerThreadId, callerTurnId, requestId, fingerprint)`
  returns the same operation and threads.
- Reusing the request id with a different payload returns
  `idempotency_conflict`.
- A different request id after a plan is committed in the same turn returns
  `creation_plan_locked` and the existing operation summary.
- No automatic provider/model substitution.

Keep `synara_create_thread` as a backwards-compatible single-entry wrapper
over the same service. Mark it inappropriate for plural requests in its tool
description. It receives the same required `requestId` and creation-plan rules.

### `synara_wait_for_threads` (read-only, idempotent)

```ts
type SynaraWaitForThreadsInput = {
  threadIds: ReadonlyArray<ThreadId>; // 1–20
  runIds?: ReadonlyArray<TurnId | null>;
  timeoutMs?: number; // default 30_000, max 60_000
};
```

Pin the selected active/latest turn for each thread at call time. Return every
thread's terminal/running status, final assistant summary, and error. A timeout
never creates, retries, replaces, interrupts, or cancels work.

### Typed errors

Return stable machine-readable codes in the JSON tool result, including:

```text
caller_session_inactive
caller_turn_inactive
capability_denied
provider_unavailable
model_unavailable
model_option_unavailable
idempotency_conflict
creation_plan_locked
creation_limit_exceeded
thread_not_found
wait_timed_out
operation_failed
```

### MCP tool annotations

Extend `McpToolDefinition` with MCP annotations (`title`, `readOnlyHint`,
`destructiveHint`, `idempotentHint`, `openWorldHint`). These are advisory model
signals; backend checks remain authoritative.

## Commands you will need

| Purpose                    | Command                                                                                                                                                                                                                                                                                                                                                                    | Expected on success                                                              |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Gateway tests              | `cd apps/server && bun run test src/agentGateway/Layers/AgentGateway.test.ts src/agentGateway/mcpInjection.test.ts src/agentGateway/protocol.test.ts`                                                                                                                                                                                                                      | exit 0; focused suites pass                                                      |
| Provider policy tests      | `cd apps/server && bun run test src/provider/Layers/CodexAdapter.test.ts src/provider/Layers/ClaudeAdapter.test.ts src/provider/Layers/CursorAdapter.test.ts src/provider/Layers/GrokAdapter.test.ts src/provider/Layers/GeminiAdapter.test.ts src/provider/Layers/DroidAdapter.test.ts src/provider/Layers/OpenCodeAdapter.test.ts src/provider/Layers/PiAdapter.test.ts` | exit 0; policy marker and lifecycle cases pass                                   |
| Contracts tests            | `cd packages/contracts && bun run test src/agentGateway.test.ts src/orchestration.test.ts src/providerDiscovery.test.ts`                                                                                                                                                                                                                                                   | exit 0                                                                           |
| Orchestration tests        | `cd apps/server && bun run test src/orchestration/Layers/OrchestrationEngine.test.ts src/orchestration/Layers/ProviderRuntimeIngestion.test.ts`                                                                                                                                                                                                                            | exit 0                                                                           |
| Full required verification | `bun fmt && bun lint && bun typecheck`                                                                                                                                                                                                                                                                                                                                     | exit 0; run only when explicitly authorized by the operator in that conversation |

Repo rule: use `bun run test`, never `bun test`. Do not run `bun fmt`,
`bun lint`, or `bun typecheck` unless the operator explicitly authorizes them
in the implementation conversation.

## Scope

**In scope**:

- `packages/contracts/src/agentGateway.ts` (new)
- `packages/contracts/src/agentGateway.test.ts` (new)
- `packages/contracts/src/index.ts`
- `packages/contracts/src/orchestration.ts` only for immutable gateway
  provenance on thread-created command/event/projected state
- `apps/server/src/agentGateway/harnessPolicy.ts` (new, pure policy builder)
- `apps/server/src/agentGateway/targetResolver.ts` (new)
- `apps/server/src/agentGateway/Services/AgentGatewaySessionRegistry.ts` (new)
- `apps/server/src/agentGateway/Layers/AgentGatewaySessionRegistry.ts` (new)
- `apps/server/src/agentGateway/Services/AgentGatewayOperationRepository.ts` (new)
- `apps/server/src/agentGateway/Layers/AgentGatewayOperationRepository.ts` (new)
- `apps/server/src/agentGateway/Layers/AgentGateway.ts`
- `apps/server/src/agentGateway/Layers/AgentGateway.test.ts`
- `apps/server/src/agentGateway/Services/AgentGatewayCredentials.ts`
- `apps/server/src/agentGateway/Layers/AgentGatewayCredentials.ts`
- `apps/server/src/agentGateway/mcpInjection.ts`
- `apps/server/src/agentGateway/mcpInjection.test.ts`
- `apps/server/src/agentGateway/protocol.ts`
- `apps/server/src/agentGateway/protocol.test.ts`
- `apps/server/src/persistence/Migrations/055_AgentGatewayOperations.ts` (new)
- `apps/server/src/persistence/Migrations.ts`
- `apps/server/src/serverLayers.ts`
- `apps/server/src/provider/runtimeLayer.ts`
- provider adapter/session construction files needed to deliver the shared
  policy on start/resume/fork
- `apps/server/src/codexAppServerManager.ts` and focused tests
- orchestration command/event/projector files needed only for immutable
  gateway provenance and deterministic receipt reuse

**Out of scope**:

- Replacing the existing orchestration engine with the PR #2829 V2 design.
- Rebranding or renaming `synara_*` tools.
- Disabling provider-native subagents globally. They remain available for
  ordinary in-turn delegation; the host policy only establishes precedence for
  explicit Synara-resource requests.
- Making ordinary gateway-created threads appear as nested subagents in the
  sidebar.
- Building a full app-owned subagent task graph or result context-transfer
  system. This plan adds operation provenance and batch wait only.
- Granting MCP control to a pooled provider process by placing one thread's
  bearer token in shared configuration.
- UI redesign. Existing Synara MCP logo/labels may consume tool annotations,
  but UI work is not required to make backend behavior safe.
- Auto-parsing arbitrary natural-language model aliases on the server.

## Git workflow

- Branch from the current feature branch with `codex/synara-harness-control-plane`.
- Keep commits grouped by the milestones below: policy delivery, invocation
  scope, target resolution, operation/idempotency, coordination, verification.
- Do not push or open a PR unless the operator requests it.
- Preserve unrelated working-tree changes; do not reset or rewrite them.

## Steps

### Step 1: Characterize the incident before changing behavior

Add tests that fail against current behavior:

- an MCP create after the caller's projected active turn has completed is
  rejected with zero orchestration dispatches;
- two identical create calls in the same turn replay one result;
- a second distinct create plan in the same turn is rejected;
- `gpt-5.6-terra-low` is rejected before `thread.create`;
- `gpt-5.6-terra` with Codex `reasoningEffort: "low"` is accepted and persists
  the exact selection;
- a two-entry batch dispatches exactly two thread creates and two initial turns;
- one invalid entry rejects the entire batch with zero thread/worktree side
  effects;
- a failed initial-turn dispatch does not leave an untracked visible worker or
  worktree;
- wait returns two pinned results and never creates replacements.

Replace the current “unlimited number of threads regardless of prior spawns”
assertion with a distinction between unlimited **user turns over time** and one
bounded creation plan per active caller turn.

**Verify**: Run the gateway tests and confirm only the newly added regression
cases fail for the expected missing safeguards.

### Step 2: Centralize and deliver the Synara harness policy

Create a pure `harnessPolicy.ts` exporting:

- `SYNARA_HARNESS_POLICY_VERSION`;
- one canonical identity/routing policy;
- a capability-aware renderer that never claims unavailable MCP support; and
- small provider delivery helpers, without duplicating policy text in adapters.

The canonical policy must state:

1. “You are running inside Synara. Synara is the host/harness for this
   session.”
2. Use `synara_*` for Synara threads, projects, automations, and coordination.
3. Provider-native `spawn_subagent`/Task/collaboration tools do not create
   Synara threads and must not substitute for an explicit request for Synara
   threads.
4. Use one `synara_create_threads` call for plural requests; the array count is
   exact.
5. Resolve canonical models/options through `synara_capabilities`; do not guess
   slugs or silently change provider/model.
6. Wait with `synara_wait_for_threads`, then synthesize all results.
7. Report failures; do not create replacements without a new user instruction.

Deliver it through the strongest channel available:

- **Codex**: append it to both default and plan collaboration-mode developer
  instructions. Preserve all existing mode content.
- **Claude**: append it to the existing Claude system-prompt append. Add MCP
  configuration additively; never turn it into an exclusive allowed-tools
  list.
- **Cursor/Grok/Gemini/Droid ACP paths**: include consistent Synara clientInfo
  and inject a private host-context envelope on the first prompt for new/load/
  fork when ACP has no system-instruction field. Keep the envelope out of the
  user-visible Synara message projection.
- **OpenCode/Kilo**: deliver truthful host identity, but advertise Synara MCP
  mutation capability as false until a per-thread credential can be safely
  bound to the pooled runtime. If their session API supports per-session MCP,
  implement that binding; if it only supports shared server config, STOP and
  leave the capability false.
- **Pi**: deliver host identity through its supported prompt/extension path and
  explicitly advertise that Synara MCP control is unavailable. Do not simulate
  successful Synara actions.

Keep MCP initialize `instructions` generated from the same policy. Add tool
annotations and make every description begin with its user-facing Synara
purpose, not the literal transport name.

**Verify**: provider tests assert the same policy version/marker appears exactly
once on start and remains effective on resume/fork. Negative tests assert
OpenCode/Kilo/Pi never claim capabilities they do not have.

### Step 3: Bind gateway credentials to a live provider session and active turn

Replace thread-only invocation identity with an in-memory
`AgentGatewaySessionRegistry` that issues an opaque random token scoped to:

- caller thread id;
- a Synara-generated provider-session key (not an upstream provider id);
- provider kind;
- allowed capability set;
- issue time and expiry; and
- revocation state.

Allow multiple legitimate sessions for the same thread; issuing a new token
must not blindly revoke another active token. Revoke a token when its owning
provider session stops. On server restart, provider sessions are reconstructed
and receive new credentials, so old in-memory credentials become invalid.
Never persist or log raw tokens.

At request time, build `AgentGatewayInvocationContext` with JSON-RPC id,
caller thread, current projected active turn, provider session key, provider,
and capabilities. For all destructive tools:

- require the scoped provider session to still own the caller thread;
- require an active caller turn;
- reject calls after turn completion with `caller_turn_inactive`;
- retain existing runtime/worktree privilege checks.

This is the authoritative fix for detached native background agents: once the
parent turn is terminal, they can no longer create, send, archive, rename,
interrupt, or schedule through the retained connection. Read-only inspection
may continue only while the provider session credential remains valid.

**Verify**: tests cover active call, post-completion detached call, stale token
after session stop, two legitimate sessions on one thread, token expiry, server
restart semantics, and no token leakage in logs/config snapshots.

### Step 4: Add one provider target resolver shared by capabilities and creation

Create `targetResolver.ts` using `ProviderDiscoveryService` and the existing
provider health/settings sources. It must return either a canonical
`ModelSelection` or a typed error before side effects.

Rules:

- provider must be enabled, installed/available, authenticated where the
  current health layer exposes that state, and supported by orchestration;
- model must exactly match an advertised canonical slug when a catalog exists;
- provider-specific options must be among the advertised/static allowed values;
- if model discovery is unsupported or temporarily unavailable, allow only the
  provider's configured default; require user intervention for an unverified
  custom model rather than agent opt-in;
- return the same catalog from `synara_capabilities` that validation uses;
- never rewrite a malformed slug into a guessed provider/model pair;
- persist requested and effective selections when they differ for a documented
  provider normalization, and surface that difference in the result.

Wire the resolver into both single and batch creation before branch/worktree
creation. Keep model options intact in `thread.create` and
`thread.turn.start`.

**Verify**: contracts and gateway tests cover canonical Terra Low, unknown
model, unsupported effort, unavailable provider, catalog-unavailable default,
and exact model/options propagation.

### Step 5: Make creation a durable, exact, idempotent operation

Add migration 055 and a small operation repository with a unique key over
`(caller_thread_id, caller_turn_id, operation_kind)`. Persist:

- operation id and request id;
- canonical input fingerprint;
- exact requested count;
- deterministic thread/command/message ids for every array index;
- status (`reserved`, `dispatching`, `completed`, `failed`, `compensating`);
- result/error JSON without secrets; and
- timestamps.

Reservation happens before any git or orchestration side effect. Use the
existing orchestration command-receipt path by deriving stable command ids from
`callerThreadId + callerTurnId + operationId + index + operation`. Do not hash
only the prompt because two intentionally identical entries in one batch are
valid and are distinguished by index.

Preflight the entire batch first. Then execute the reserved plan. If branch,
worktree, thread create, or initial-turn dispatch fails:

- stop dispatching later entries;
- archive/delete any newly visible thread according to existing safe lifecycle
  semantics;
- remove only worktrees/branches created by this operation through `GitCore`;
- record compensation outcome; and
- return one operation error with per-entry state.

Add startup recovery for non-terminal operation rows. It must reconcile
deterministic thread ids and command receipts before retrying or compensating;
it must never generate fresh ids.

Persist immutable provenance on created threads/events/projections:

```text
creationSource = synara_mcp
sourceThreadId = caller thread
sourceTurnId = caller turn
gatewayOperationId = operation id
gatewayOperationIndex = array index
```

Do not set `parentThreadId` for ordinary user-requested top-level threads.

**Verify**: run duplicate/concurrent/restart/failure tests. In every case,
SQLite contains at most the reserved count and no operation-owned orphan
worktree remains.

### Step 6: Add bounded batch waiting and result synthesis support

Implement `synara_wait_for_threads` as a read-only long poll over projections:

- select/pin each latest active turn at call time;
- poll durable projection state, not provider process internals;
- default timeout 30 seconds, maximum 60 seconds;
- return all entries in input order;
- include terminal assistant summary/error and `timedOut` per entry;
- do not treat timeout as failure or trigger any mutation;
- allow repeated waits to continue observing the same pinned turn ids.

Update the harness policy and tool descriptions to require waiting and final
synthesis when the user asks for results. A terminal child error is part of the
result set, not a signal to create another child.

**Verify**: tests cover two children completing in either order, one failure,
one timeout followed by success, idle thread, child receiving a later queued
turn (wait remains pinned), and caller interruption.

### Step 7: Close provider lifecycle and native-collaboration gaps

Add adapter-level characterization for MCP transport and host policy on fresh,
resume/load, and fork paths for Codex, Claude, Cursor, Grok, Gemini, and Droid.
Add explicit capability tests for OpenCode, Kilo, and Pi.

For provider-native collaboration ingestion:

- clear stale Codex receiver-parent maps at every turn/session reset;
- derive provider-ingestion command ids deterministically from event id, tag,
  and target rather than appending a random UUID;
- bind materialized native child provenance to its source turn; and
- add a conservative per-parent-turn native-child cap with one overflow
  activity rather than unbounded materialization.

This cap protects Synara projections from provider fan-out, but it does not
disable native subagent execution. Keep native-child budgeting separate from
the ordinary top-level `synara_create_threads` operation.

**Verify**: repeat one provider event after a simulated recovery and observe one
projected effect; reuse a receiver id in a later turn and confirm it is not
attached to stale parent state; send more receiver ids than the cap and confirm
only the cap is materialized plus one audit activity.

### Step 8: Run the focused incident replay and final gates

Add an integration fixture equivalent to the original request:

> Start 2 threads: Codex GPT 5.6 Terra Low and Claude Sonnet 5. Ask both what
> the repo is about, wait for both, then report.

The deterministic model/tool script should attempt the historical failure
sequence: choose a native subagent first, complete the parent turn, then try
multiple alternative model/provider creates through the retained MCP token.
Expected result:

- detached creates are rejected;
- the active parent path uses one two-entry Synara batch;
- exactly two durable threads exist for the gateway operation;
- the Codex selection stores model `gpt-5.6-terra` plus
  `reasoningEffort: "low"`;
- no OpenCode fallback thread exists;
- the parent waits for both pinned turns and returns one synthesis;
- repeated JSON-RPC calls and simulated restart do not change the count.

Run all focused commands. Run `bun fmt`, `bun lint`, and `bun typecheck` only
after the operator explicitly authorizes them in the implementation
conversation; all three must pass before implementation is called complete.

## Test plan

### Contract tests

- Exact batch bounds (0, 1, 20, 21).
- Required bounded request id.
- Provider-specific model option decode and invalid cross-provider options.
- Typed tool result/error schemas.

### Gateway unit/integration tests

- Session/turn authorization for every destructive tool.
- Same request replay, payload conflict, second-plan lock, concurrent calls.
- JSON-RPC batch cap and duplicate ids.
- Whole-batch preflight and deterministic ids.
- Worktree/thread compensation and startup recovery.
- Capability and target validation.
- Batch wait pinning, ordering, timeouts, failures, and no replacement.

### Provider tests

- Canonical policy delivery exactly once through each strongest native channel.
- MCP injection survives start/resume/fork for supported providers.
- Unsupported providers receive truthful identity/capability instructions.
- Claude built-in tools remain available after additive MCP configuration.
- Detached native background work cannot mutate after the parent turn ends.

### Orchestration tests

- Stable command ids hit existing receipts.
- Gateway provenance survives projection rebuild/restart.
- Native collaboration event replay is idempotent and stale maps are cleared.

## Done criteria

- [x] Every provider receives the same versioned Synara host identity through
      its strongest available instruction channel.
- [x] Every provider truthfully reports whether it can call Synara MCP; no
      provider simulates unsupported host actions.
- [x] MCP initialize identity, tool descriptions, and native host instructions
      all say Synara, never T3 or a provider-branded harness.
- [x] Every destructive call requires a live scoped provider session and active
      caller turn.
- [x] A detached background agent cannot create or mutate Synara threads after
      its parent turn completes.
- [x] Plural thread requests use one batch with an exact count.
- [x] The same creation request is idempotent; a different second plan in the
      same caller turn is rejected.
- [x] Provider/model/options are validated before thread/git/worktree effects.
- [x] Codex Terra Low is represented as canonical model plus low reasoning
      effort.
- [x] Creation failure/recovery leaves no untracked visible thread or
      operation-owned worktree.
- [x] Batch wait returns pinned child outcomes and never auto-replaces failures.
- [x] The original incident fixture produces exactly two threads and one final
      synthesis.
- [x] Focused tests pass.
- [x] Operator-authorized `bun fmt`, `bun lint`, and `bun typecheck` pass before
      implementation is marked complete.
- [x] `plans/README.md` marks plan 006 DONE only after all gates pass.

## STOP conditions

- A provider exposes no safe private/system/prompt channel for host identity;
  report the provider and keep its capability false rather than placing secret
  text in user-visible history.
- OpenCode/Kilo only allow MCP configuration at a pooled shared-process level;
  do not attach a per-thread token to that shared configuration.
- Target validation cannot distinguish catalog unavailable from model absent;
  fail closed and report instead of silently accepting arbitrary models.
- Existing orchestration receipts cannot safely represent the two-command
  create-plus-initial-turn operation; keep the gateway operation repository and
  do not invent partial replay behavior.
- Compensation would remove a pre-existing user branch/worktree. Record the
  failed operation and stop; never delete resources not proven to be owned by
  the operation.
- Provider-native tool gating would require globally disabling Read/Bash/Edit
  or ordinary subagents. Keep tools additive and rely on host precedence plus
  server authorization.
- The implementation requires adopting the external PR's full V2 architecture.
  Stop and split that migration into a separate proposal.

## Maintenance notes

- `SynaraHarnessPolicy` is the single source of truth. Any new provider must add
  an explicit delivery/capability test before it is considered supported.
- Capability discovery and target validation must consume the same catalog;
  separate lists will drift and recreate late model failures.
- Gateway operation receipts are durable product state. Schema changes require
  backward-compatible decode and recovery tests.
- Keep the wait timeout short and rolling. Long-lived HTTP waits make provider
  cancellation, desktop shutdown, and token rotation harder.
- Tool annotations improve model choice and UI presentation but are not a
  security or idempotency boundary.
- Reviewers should focus on token lifetime/revocation, active-turn races,
  operation recovery, compensation ownership, and model-catalog fallback.
