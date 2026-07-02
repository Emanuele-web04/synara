You are Codex CLI running as a supervised runner for a Synara repository task.

Repository: /Users/joongjae/dev/synara
Current branch: main
Important: The working tree is intentionally dirty with an in-progress Hermes provider integration. Do not revert unrelated existing changes. Keep edits minimal and scoped.

User goal:
Continue the Hermes provider integration by completing the remaining implementation phases, with verification. Treat docs/plans/2026-07-02-hermes-provider-runner-phases.md as the phase checklist and update it only if useful.

Baseline already done by Hermes supervisor:

- Added initial Hermes provider contracts/settings/UI metadata.
- Added `apps/server/src/provider/Services/HermesAdapter.ts`.
- Added `apps/server/src/provider/Layers/HermesAdapter.ts`.
- Registered Hermes in adapter registry/runtime layer.
- `hermes chat --quiet --query 'Reply with exactly: Synara Hermes CLI OK.'` worked.
- `bun run --filter=t3 typecheck` passed.
- `bun run test --filter=t3 -- ProviderHealth HermesAdapter ProviderAdapterRegistry` passed.

Your required phases:

Phase 1 — Close provider-health completeness

1. Implement a real Hermes health probe in `apps/server/src/provider/Layers/ProviderHealth.ts`.
2. Use `settings.providers.hermes.binaryPath` and cheap command `hermes --version`.
3. Add tests in `ProviderHealth.test.ts`:
   - ready when Hermes version probe succeeds
   - configured binary path is used
   - unavailable/error when Hermes binary is missing/spawn fails
4. Maintain disabled provider count at 9.
5. Verify:
   - `bun run --filter=t3 typecheck`
   - `bun run test --filter=t3 -- ProviderHealth`

Phase 2 — Async turn execution if feasible in this pass

1. Improve `HermesAdapter.sendTurn` so it does not block until the Hermes CLI process completes.
2. Use Effect APIs that exist in this repository version. Do not use `Effect.forkDaemon`; it failed previously.
3. Existing patterns include `.pipe(Effect.forkIn(scope))` where a Scope is available. If adding a scope is too invasive, leave a clear note and keep code stable.
4. Preserve `interruptTurn` using AbortController.
5. Add/adjust tests only if the async change is implemented.
6. Verify:
   - `bun run --filter=t3 typecheck`
   - `bun run test --filter=t3 -- HermesAdapter ProviderAdapterRegistry`

Phase 3 — Integration sweep

1. Run:
   - `bun run test --filter=t3 -- HermesAdapter ProviderAdapterRegistry ProviderHealth ProviderDiscoveryService`
2. If web settings files are touched, run relevant web tests; discover the correct command from package scripts if needed.
3. Inspect final diff and ensure no unrelated churn.

Optional Phase 4 — UI/DB smoke
If browser/tooling is available inside your environment, do the live UI smoke described in docs/plans/2026-07-02-hermes-provider-runner-phases.md. If not, leave it for the supervisor with exact manual steps.

Constraints:

- Do not commit.
- Do not create a PR.
- Do not run broad heavyweight full-suite commands unless needed; use targeted tests above.
- Do not modify secrets or cross-profile Hermes data.
- Do not invent test results. If a command fails, fix if in scope or report the blocker.
- Final response must include:
  - phases completed / skipped
  - changed files
  - exact verification commands and pass/fail output summary
  - residual risks / next steps
