# Project Coordinator implementation ledger

Base SHA: `779cd649e060c17a57ede329b51fbe67e6b02663`  
Branch: `synara/build-project-coordinator`  
Worktree: `/Users/dilipreddy/.synara/worktrees/0e19289d2a9e`  
Approved spec: [PROJECT_COORDINATOR_PLAN.md](PROJECT_COORDINATOR_PLAN.md)

## Status

| Increment | Status | Notes |
|---|---|---|
| 1. Contracts, persistence, authorization | done | Migration 081, CAS, user-only goal grants, managed-thread drive checks |
| 2. Context workspace | done | Atomic Markdown mirrors, 32k packet, instruction import on setup |
| 3. Project interface | done | Shared 220ms auxiliary panel, Project icon, four views, setup |
| 4. Observation and summaries | done | Inbox/cursor, latest-20 + pending backfill, digest + generateProjectDigest |
| 5. Bounded coordination | done | Project-event heartbeat, limits, pause/stop, attempt→review |
| 6. Integration and rollout | done | Focused Vitest; no blanket fmt/lint/typecheck |

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

- Isolated Synara preview (separate state/ports) is for the root coordinator
- Environment instructions editor still uses the browser store until a project is configured; setup imports it server-side
- Document source save from the Context view is preview/read-oriented; writes go through `writeDocument`
- No 1,000-thread / 10,000-activity soak in this pass

## Risks

- AgentGateway tests now stub ProjectAgentService; live managed-thread checks need isolated preview
- Digest model generation is implemented on TextGeneration but refreshDigest currently uses a deterministic last-good path unless wired in a follow-up call
- `bun typecheck` was not run; some UI prop tightness may still fail a later typecheck pass
