# Hermes Provider Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Add Hermes/Harness as a first-class Synara provider so users can run Hermes sessions from the existing Synara composer and project workspace.

**Architecture:** Reuse Synara's provider adapter pattern. Add a new `hermes` provider kind in contracts, implement a server-side `HermesAdapter` that spawns `hermes chat` or a future Hermes local API bridge, and map Hermes output into existing `ProviderRuntimeEvent` / thread message projections. Keep the first cut CLI-based and local-first; do not introduce a cloud dependency.

**Tech Stack:** TypeScript, Effect services/layers, Synara provider contracts, Node child_process, Hermes CLI.

---

## Current Baseline Verified

- Synara dev server runs locally from `/Users/joongjae/dev/synara`.
- Isolated dev base dir: `.synara-local`.
- Test project: `/Users/joongjae/dev/synara-smoke`.
- Existing provider smoke tests passed:
  - Codex: `Synara Codex smoke OK.`
  - Claude: `Synara Claude smoke OK.`
  - OpenCode: `Synara OpenCode smoke OK.`

## Existing Provider Architecture

Key files:

- Provider enum/contracts: `packages/contracts/src/orchestration.ts`
- Adapter contract: `apps/server/src/provider/Services/ProviderAdapter.ts`
- Cross-provider service: `apps/server/src/provider/Layers/ProviderService.ts`
- Existing adapters:
  - `apps/server/src/provider/Layers/CodexAdapter.ts`
  - `apps/server/src/provider/Layers/ClaudeAdapter.ts`
  - `apps/server/src/provider/Layers/OpenCodeAdapter.ts`
- UI provider picker:
  - `apps/web/src/components/chat/composerProviderRegistry.tsx`
  - `apps/web/src/components/ProviderIcon.tsx`

## Phase 1 Scope: Minimal Hermes CLI Provider

The first cut should support:

1. Provider appears in model/provider picker as `Hermes`.
2. New thread can be started in a project cwd.
3. User prompt is sent to Hermes CLI.
4. Final Hermes text is displayed as an assistant message.
5. No streaming requirement in phase 1.
6. No file diff/proposed plan integration in phase 1.
7. No Telegram/gateway control in phase 1.

Recommended provider id:

```ts
"hermes";
```

Optional later branding:

```ts
"hermesHarness";
```

Use `hermes` first because it is short and matches provider naming style.

---

## Task 1: Add Hermes provider kind to contracts

**Objective:** Make `hermes` a valid provider kind and model selection.

**Files:**

- Modify: `packages/contracts/src/orchestration.ts`
- Modify tests if present: `packages/contracts/src/*.test.ts`

**Steps:**

1. Add `"hermes"` to `ProviderKind` literals.
2. Add `HermesModelSelection` schema with `provider: Schema.Literal("hermes")` and `model: TrimmedNonEmptyString`.
3. Add it to `ModelSelection` union.
4. Add minimal provider options only if required by type checks; otherwise keep options absent for phase 1.

**Verification:**

```bash
bun run typecheck --filter=@t3tools/contracts
```

Expected: contracts compile.

---

## Task 2: Add server adapter service shape

**Objective:** Define Hermes adapter service type parallel to existing provider adapters.

**Files:**

- Create: `apps/server/src/provider/Services/HermesAdapter.ts`
- Modify: provider adapter registry files discovered during implementation.

**Steps:**

1. Copy the service pattern from `CodexAdapter.ts` or `OpenCodeAdapter.ts` service file.
2. Export `HermesAdapter` service tag.
3. Use `ProviderAdapterShape<ProviderAdapterError>` as the core shape.

**Verification:**

```bash
bun run typecheck --filter=t3
```

Expected: new service compiles after registry wiring.

---

## Task 3: Implement minimal Hermes CLI adapter

**Objective:** Start a Hermes-backed session and run one prompt through Hermes CLI.

**Files:**

- Create: `apps/server/src/provider/Layers/HermesAdapter.ts`
- Add focused tests: `apps/server/src/provider/Layers/HermesAdapter.test.ts`

**Minimal runtime behavior:**

- `startSession(input)` creates a `ProviderSession` with `provider: "hermes"`, cwd, model, and ready status.
- `sendTurn(input)` spawns Hermes CLI from the session cwd:

```bash
hermes chat -q "$PROMPT" --source synara
```

If profile support is needed later:

```bash
hermes --profile coder3 chat -q "$PROMPT" --source synara
```

**Important:** Use `spawn` with args, not shell string concatenation.

Example command assembly:

```ts
const args = ["chat", "-q", input.input ?? "", "--source", "synara"];
const child = spawn(hermesBinary, args, { cwd, env });
```

**Event mapping:**

- On start: emit `turn.started`.
- On stdout completion: create/emit assistant message event with stdout text.
- On exit code 0: emit `turn.completed`.
- On non-zero exit: emit `runtime.error` and `turn.aborted`/failed state using existing error conventions.

**Verification:**

Test with fake child process/spawner first.

Expected behavior:

- Input: `Say exactly: Hermes smoke OK.`
- Fake stdout: `Hermes smoke OK.`
- Projection receives assistant message.

---

## Task 4: Register Hermes adapter in provider registry

**Objective:** Allow `ProviderService` to route `provider: "hermes"` calls to `HermesAdapter`.

**Files:**

- Modify registry/layer files under `apps/server/src/provider/Layers/`
- Search targets:
  - `ProviderAdapterRegistry`
  - `CodexAdapterLive`
  - `OpenCodeAdapterLive`

**Steps:**

1. Add Hermes service/layer to registry composition.
2. Ensure `listSessions`, `hasSession`, `stopSession`, `stopAll`, and `streamEvents` are implemented.
3. Keep unsupported methods explicit:
   - `startReview`: omit or unsupported.
   - `forkThread`: omit in phase 1.
   - `compactThread`: omit in phase 1.
   - approvals: no-op or unsupported error until Hermes approval bridge exists.

**Verification:**

```bash
bun run typecheck --filter=t3
```

Expected: server compiles.

---

## Task 5: Add provider health check for Hermes CLI

**Objective:** Show Hermes as available only when Hermes CLI is installed and runnable.

**Files:**

- Modify: `apps/server/src/provider/Layers/ProviderHealth.ts`
- Add tests near existing provider health tests.

**Probe:**

```bash
hermes --version
```

Fallback if version output is unavailable:

```bash
hermes chat -q "ping" --toolsets safe --source synara-health
```

Prefer version check first to avoid model calls.

**Statuses:**

- ready: Hermes CLI exists and version returns 0.
- error: command missing.
- warning: command exists but health details incomplete.

**Verification:**

Focused provider health tests with fake spawner.

---

## Task 6: Add Hermes to web provider picker

**Objective:** Let users select Hermes from the composer.

**Files:**

- Modify: `apps/web/src/components/chat/composerProviderRegistry.tsx`
- Modify: `apps/web/src/components/ProviderIcon.tsx`
- Modify model capability helpers if needed:
  - `apps/web/src/components/chat/runtimeModelCapabilities.ts`
  - `packages/shared/src/model*` files if provider-specific model normalization is required.

**Phase 1 model choices:**

Use static models/profiles until runtime discovery exists:

- `default`
- `coder3`
- optionally `local`

Better label:

- `Hermes default`
- `Hermes coder3`

**Verification:**

Open Synara UI and confirm:

1. Provider menu contains `Hermes`.
2. Selecting Hermes updates composer button.
3. Sending a prompt creates a Hermes-backed thread.

---

## Task 7: End-to-end smoke test

**Objective:** Prove Hermes works through Synara UI.

**Steps:**

1. Start dev server with isolated base dir:

```bash
env -u T3CODE_AUTH_TOKEN \
  T3CODE_PORT_OFFSET=3158 \
  T3CODE_NO_BROWSER=1 \
  bun run dev -- --home-dir ./.synara-local --port 58090
```

2. Open:

```text
http://localhost:8891/
```

3. Use project:

```text
/Users/joongjae/dev/synara-smoke
```

4. Select provider: `Hermes`.
5. Send:

```text
Say exactly: Synara Hermes smoke OK. Do not modify files.
```

6. Verify DB projection:

```bash
python3 - <<'PY'
import sqlite3
p='/Users/joongjae/dev/synara/.synara-local/dev/state.sqlite'
con=sqlite3.connect(p)
for row in con.execute("select role,text,is_streaming from projection_thread_messages order by created_at desc limit 10"):
    print(row)
PY
```

Expected assistant row:

```text
Synara Hermes smoke OK.
```

---

## Known Risks

1. **Hermes CLI is interactive by default**
   - Always use `hermes chat -q` for phase 1.

2. **Profile selection**
   - Phase 1 can hardcode default/current environment.
   - Phase 2 should expose profile picker.

3. **Long-running turns**
   - Need child process tracking and cancellation support.
   - Implement `interruptTurn` by killing the child process group.

4. **Tool approvals**
   - Hermes approval prompts are not bridged in phase 1.
   - Start with simple non-interactive smoke use cases.

5. **Streaming**
   - Phase 1 can buffer stdout and display final text.
   - Phase 2 can parse streaming output if Hermes exposes structured events.

6. **Output formatting**
   - Strip banners/spinners if `hermes chat -q` emits them.
   - Prefer `--quiet` if supported after verification.

---

## Phase 2 Ideas

- Hermes profile picker.
- Harness mode: route tasks to Hermes harness/team skills.
- Structured event bridge instead of stdout buffering.
- Approval bridge into Synara pending approval UI.
- Hermes memory/session resume display.
- Attachments/images support.
- Diff/checkpoint integration.

---

## Final Verification Before PR

Run once after implementation:

```bash
bun run typecheck
bun run lint
bun run test -- --runInBand
```

Repository note: follow `AGENTS.md`; do not run heavyweight checks repeatedly during iteration.
