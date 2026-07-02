# Hermes Provider Runner Phases

## Baseline already verified

- Repo: `/Users/joongjae/dev/synara`
- Dev server: `proc_371e9c826abe`, `http://localhost:8891/`, home dir `./.synara-local`
- Hermes CLI smoke passed:
  - `hermes chat --quiet --query 'Reply with exactly: Synara Hermes CLI OK.'`
  - output contained `Synara Hermes CLI OK.`
- Typecheck passed:
  - `bun run --filter=t3 typecheck`
- Targeted tests passed:
  - `bun run test --filter=t3 -- ProviderHealth HermesAdapter ProviderAdapterRegistry`
  - `82 passed`
  - broader earlier pass: `ProviderHealth HermesAdapter ProviderAdapterRegistry ProviderDiscoveryService`, `87 passed`

## Phase 1 — Close provider-health completeness

Goal: Hermes should be visible as a real installable/runnable provider in server status.

Tasks:

1. Add a Hermes health probe to `apps/server/src/provider/Layers/ProviderHealth.ts`.
2. Prefer a cheap version probe:
   - binary from `settings.providers.hermes.binaryPath`
   - command: `hermes --version`
3. Status rules:
   - ready: process exits 0 and command is runnable
   - unavailable/error: missing binary or spawn failure
   - warning/error: non-zero version check
4. Add focused tests to `ProviderHealth.test.ts`:
   - ready when version probe succeeds
   - uses configured binary path
   - unavailable when binary missing
5. Ensure disabled-provider paths still expect 9 providers.

Verification:

- `bun run --filter=t3 typecheck`
- `bun run test --filter=t3 -- ProviderHealth`

## Phase 2 — Live UI/DB Hermes smoke

Goal: prove Synara UI can create a Hermes-backed turn and persist the assistant result.

Tasks:

1. Use existing dev server if still running: `http://localhost:8891/`.
2. Project cwd: `/Users/joongjae/dev/synara-smoke`.
3. Select provider `Hermes`.
4. Send: `Say exactly: Synara Hermes smoke OK. Do not modify files.`
5. Verify SQLite projection at:
   - `/Users/joongjae/dev/synara/.synara-local/dev/state.sqlite`
6. Confirm:
   - assistant message contains `Synara Hermes smoke OK.`
   - latest Hermes turn is `completed`

Verification commands may inspect:

- `projection_thread_messages`
- `projection_turns`

## Phase 3 — Runner-safe async turn execution

Goal: avoid blocking `sendTurn` for long Hermes calls while preserving current tests.

Tasks:

1. Refactor `HermesAdapter.sendTurn` so it returns `{ threadId, turnId }` promptly after publishing `turn.started`.
2. Run Hermes CLI work in a supervised Effect fiber/process path compatible with this Effect version.
   - Do not use unavailable APIs such as `Effect.forkDaemon`.
   - Follow existing patterns: `Effect.forkIn(scope)` or scoped runtime layer if needed.
3. Preserve `interruptTurn` behavior using `AbortController`.
4. Add/adjust tests:
   - `sendTurn` returns before fake exec resolves
   - completion events are eventually emitted
   - interrupt aborts the active run

Verification:

- `bun run --filter=t3 typecheck`
- `bun run test --filter=t3 -- HermesAdapter ProviderAdapterRegistry`

## Phase 4 — Final integration sweep

Goal: verify the entire provider integration did not break existing providers.

Tasks:

1. Run targeted suite:
   - `bun run test --filter=t3 -- HermesAdapter ProviderAdapterRegistry ProviderHealth ProviderDiscoveryService`
2. Run app/web settings tests if touched:
   - `bun run test --filter=@t3tools/web -- appSettings`
   - or the repo-correct equivalent discovered from package scripts
3. Run typecheck:
   - `bun run --filter=t3 typecheck`
4. Inspect final diff for unrelated changes.

## Out of scope for this runner pass

- Hermes structured streaming protocol
- Hermes approval bridge into Synara approvals UI
- Harness/team mode UI
- Attachments/images
- PR creation/commit unless explicitly requested
