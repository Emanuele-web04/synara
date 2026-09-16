# Project Coordinator implementation ledger

Base SHA: `779cd649e060c17a57ede329b51fbe67e6b02663`  
Branch: `synara/build-project-coordinator`  
Worktree: `/Users/dilipreddy/.synara/worktrees/0e19289d2a9e`  
Approved spec: [PROJECT_COORDINATOR_PLAN.md](PROJECT_COORDINATOR_PLAN.md)

## Status

| Increment | Status | Notes |
|---|---|---|
| 1. Contracts, persistence, authorization | repaired | Unmanaged MCP principals are not user; worker drive requires active-goal association |
| 2. Context workspace | repaired | Context Save uses CAS; preview/source/history/export; Environment instructions use server doc when configured |
| 3. Project interface | repaired | Editable setup/settings; Work evidence/archive; activity pagination; thread exclusion |
| 4. Observation and summaries | repaired | `generateProjectDigest` with 60s debounce, one inflight, source validation, last-good retention |
| 5. Bounded coordination | repaired | Wake event-range receipts + restart reconcile; creationCoordinator goal/limit hook; context packet injected at provider turn dispatch |
| 6. Integration and rollout | in progress | Focused Vitest; isolated preview owned by root; no fmt/lint/typecheck |

Feature stays disabled until a project is configured. Autonomous work starts only after a user starts a goal.

## Settled decisions

- Ordinary projects only (not Chats/Studio). One named coordinator thread per project.
- SQLite is authoritative; Markdown under `stateDir/project-context/<projectId>/` is a recoverable mirror.
- Automation checkout has heartbeat/standalone only. Coordinator wakes use heartbeat + internal `project-event` trigger (no calendar `nextRunAt`).
- Worker attempt completion → `review`, never business `done`.
- Existing `creationCoordinator` privilege elevation stays; add managed goal/project scope to `assertCallerMayDriveThread`.
- Public user text must distinguish provider-stopped vs accepted work.

## Commits

- `3bad29eecfb842e387a35f46c53c13f9eff9e82e` Add Project Coordinator domain, panel, and bounded wakes.

## Checks

- `packages/shared` `src/projectAgent.test.ts` passed
- `packages/contracts` `src/projectAgent.test.ts`, `src/automation.test.ts`, `src/ws.test.ts` passed
- `apps/web` auxiliary panel + ChatView.logic + disclosureMotion passed
- `apps/server` principal, schedule, ProjectAgentRepository, Migrations, AutomationRepository, ProviderTextGeneration passed
- Did not run `bun fmt`, `bun lint`, or `bun typecheck`

## Remaining requirements

- Isolated Synara preview (separate state/ports) remains root-owned; this repair did not relaunch it
- No 1,000-thread / 10,000-activity soak
- `bun fmt` / `bun lint` / `bun typecheck` still unauthorized
- ProviderCommandReactor tests stub `formatContextPacketForTurn`; live injection needs preview
- Settings model picker reuses the current chat model rather than a full composer catalog

## Risks

- `Effect.service` / `forkDaemon` / stream `Queue` APIs must match this Effect build in preview
- Digest generation depends on TextGeneration availability; failures keep last-good and mark `generationState: failed`
- Unmanaged MCP threads can still *read* their own project's overview; they cannot write user-owned docs or start goals
