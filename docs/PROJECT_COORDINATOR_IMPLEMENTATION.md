# Project Coordinator implementation ledger

Base SHA: `779cd649e060c17a57ede329b51fbe67e6b02663`  
Branch: `synara/build-project-coordinator`  
Worktree: `/Users/dilipreddy/.synara/worktrees/0e19289d2a9e`  
Approved spec: [PROJECT_COORDINATOR_PLAN.md](PROJECT_COORDINATOR_PLAN.md)

## Status

| Increment                                | Status      | Notes                                                                                                                                 |
| ---------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Contracts, persistence, authorization | repaired    | Unmanaged MCP principals are not user; worker drive requires active-goal association                                                  |
| 2. Context workspace                     | repaired    | Context Save uses CAS; preview/source/history/export; Environment instructions use server doc when configured                         |
| 3. Project interface                     | repaired    | Editable setup/settings; Work evidence/archive; activity pagination; thread exclusion                                                 |
| 4. Observation and summaries             | repaired    | `generateProjectDigest` with 60s debounce, one inflight, source validation, last-good retention                                       |
| 5. Bounded coordination                  | repaired    | Wake event-range receipts + restart reconcile; creationCoordinator goal/limit hook; context packet injected at provider turn dispatch |
| 6. Integration and rollout               | in progress | Focused Vitest; isolated preview owned by root                                                                                        |
| 7. Sidebar project agent                 | done        | Project row owns the named agent; coordinator thread hidden from child lists                                                          |

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
- `22e624222` Record Project Coordinator commit in the implementation ledger.
- `2369e560d` Repair Project Coordinator security and product gaps.
- `6453cd5cc` Make Project Coordinator pass fmt, lint, and typecheck.
- `f53ad79db` Render Project Context preview as Markdown and update ledger.
- (this commit) Move project agent identity into the sidebar project row.

## Checks

- `apps/server` principal, digest, lifecycle, ProjectAgentRepository, Migrations, AgentGateway (73) passed
- `packages/contracts` projectAgent + ws passed
- `apps/web` auxiliary panel, ChatView.logic, projectInstructionsStore passed
- `bun fmt` applied; `bun lint` 0 errors; `bun typecheck` passes (2026-09-17)
- `bun run test`: 2994 passed, 36 failed in 5 web store/markdown files; the same 36 fail on `main` (missing `localStorage` in this test environment), so they are not caused by this branch
- Isolated preview (`SYNARA_HOME=~/.synara/project-coordinator-preview`, web 8891, server 6931) smoke-tested: Project icon, Overview/Work/Context/Activity, Context save with CAS revision + history + on-disk mirror, Environment instructions read from server doc, settings form
- Independently confirmed the six security/recovery repairs: unmanaged principal for ordinary MCP callers, goal-association check in drive authorization, context packet injected in ProviderCommandReactor, creationCoordinator goal hook wired, wake receipts + reconcile, live-subscribe-then-snapshot stream ordering
- Server rejects mode/schedule/target edits on project-managed automations

## Remaining requirements

- No 1,000-thread / 10,000-activity soak
- Starting a goal (autonomous coordination, live digest generation) not exercised in preview; user validation pending
- ProviderCommandReactor tests stub `formatContextPacketForTurn`; live injection needs preview
- Settings model picker reuses the current chat model rather than a full composer catalog
- Isolated preview server (6931) needs a restart to pick up `projectAgent.listSummaries`

## Risks

- `Effect.service` / `forkDaemon` / stream `Queue` APIs must match this Effect build in preview
- Digest generation depends on TextGeneration availability; failures keep last-good and mark `generationState: failed`
- Unmanaged MCP threads can still _read_ their own project's overview; they cannot write user-owned docs or start goals
