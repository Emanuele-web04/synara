# Plan 007 — Codex-Parity Automation Agent Surface and Run Protocol

Status: TODO
Priority: P1
Effort: L
Depends on: 001–005 (all DONE)
Executor: gpt-5.6-sol (xhigh reasoning) via `codex exec`. Read this plan fully before touching code.

## Goal

Close the gap between Synara's automation system and the automation architecture of Codex Desktop, as reverse-engineered in the reference report (summarized below — this plan is self-contained; you do not need the report). Synara's scheduler, persistence, misfire policies, and web UI are already at or above Codex parity. The gaps are all in the **agent-facing surface and the run-time protocol**:

1. MCP-connected agents can only create crippled automations (heartbeat + interval only, no update, no view).
2. Automation runs receive a bare prompt with no identity envelope, no last-run context, and no persistent memory.
3. Heartbeat runs have no structured way to decide "notify the user vs. stay silent", and are injected without checking whether the target thread is actually idle from the user's perspective.
4. Standalone (cron-like) runs have no structured way to report a result title/summary; triage relies on heuristics.
5. Scheduled recurrences all fire at the exact configured second (thundering-herd + "everything at 09:00:00" problem).

## How Codex Desktop does it (reference model)

Condensed from a static reverse-engineering of the Codex Desktop Electron bundle:

- One agent-visible tool, `automation_update`, with modes `view | create | suggested_create | update | suggested_update | delete`. `update` is full-replacement; tool instructions require the model to `view` first and preserve unchanged fields. Two kinds: `cron` (new thread per run) and `heartbeat` (new turn in an existing thread). Enums are strict (`ACTIVE`/`PAUSED`).
- Definitions persisted durably; a scheduler in the main process ticks every 30s, selects at most 3 due automations per tick, launches them in parallel.
- Deterministic jitter of 0–119s for hourly/daily/weekly cron occurrences, derived from `SHA-256(local salt : automation id : scheduled timestamp)`. Interval heartbeats and `COUNT=1` rules get no jitter.
- Each cron automation has a persistent memory file (`memory.md`) it is instructed to read at the start and update at the end of every run.
- The synthetic user message for a cron run is an envelope:

  ```text
  Automation: <name>
  Automation ID: <id>
  Automation memory: <path>
  Last run: <ISO timestamp or "never">

  <configured prompt>
  ```

- Cron runs end with a structured directive (`::inbox-item{title="..." summary="..."}`) that feeds a review inbox.
- Heartbeat runs inject a structured `<heartbeat>` envelope (automation id, current time, instructions) and developer instructions requiring a final structured decision: `NOTIFY` (with message) or `DONT_NOTIFY` (silent — no prose outside the block). The model may also delete its own automation mid-run when monitoring is no longer needed.
- Before injecting a heartbeat, the host checks eligibility gates: heartbeat feature enabled, thread exists, thread not currently working, no pending user-input or approval requests, last event is a safe terminal event, cooldown elapsed since last activity. Ineligible → deferred, not silently dropped.
- `notificationPolicy: "failed_runs_only" | null` silences routine notifications but keeps failures.
- Manual "run now" bypasses the schedule but reuses the exact same dispatch path.

## Current Synara state (verified 2026-07-23 — re-verify before editing, code moves fast)

- Contracts: `packages/contracts/src/automation.ts` — `AutomationSchedule` (`manual|once|interval|daily|weekdays|weekly|cron`), `AutomationMode` (`standalone|heartbeat`), run statuses, `AutomationMisfirePolicy` (`skip|coalesce|run-latest`), `AutomationCompletionPolicy` (`none|ai-evaluated`, heartbeat-only), `acknowledgedRisks` (`full-access|local-checkout|fast-interval`), `AutomationStreamEvent`. Retry policy is schema-defined but rejected at runtime ("not supported yet") — **keep it that way; out of scope**.
- Server domain: `apps/server/src/automation/` — `Layers/AutomationService.ts` (~2400 lines: create/update/delete, `dispatchRun`, `runDueOnce`, `reconcileThread`, `recoverPendingRuns`, AI completion-evaluation workers), `Layers/AutomationScheduler.ts` (adaptive poll, base 60s, event-driven early wake via sliding queue, SQLite advisory lease `automation_scheduler_leases`), `Layers/AutomationRunReactor.ts` (orchestration-event-driven reconciliation), `schedule.ts` (pure recurrence math + tests), `runResult.ts` (run summary normalization).
- Persistence: `apps/server/src/persistence/Migrations/044`–`049`, `Layers/AutomationRepository.ts` (raw SQL). `automation_runs` has a unique index on `(automation_id, scheduled_for)` for scheduled triggers.
- Agent gateway (the Synara MCP server): `apps/server/src/agentGateway/` — `automationTools.ts` (`synara_create_automation` heartbeat-only/interval-only, `synara_list_automations`, `synara_cancel_automation`), `Layers/AgentGateway.ts` (flat tool array, ~line 551), `mcpTransport.ts` (hand-rolled JSON-RPC MCP over `POST /mcp`, bearer auth per provider session, `requiresActiveTurn` enforcement), `harnessPolicy.ts` (policy text injected into every provider session — versioned string).
- Dispatch detail: `dispatchRun` persists planned thread/message/command IDs **before** dispatching (crash-safe), re-checks risk acknowledgements at dispatch time, sends the automation `prompt` verbatim as the user message with `dispatchOrigin: "automation"`. Heartbeat ticks are skipped (recorded as a `skipped` run) when the target thread already has an active automation run or a pending completion evaluation — but there is **no** check for user-driven thread activity, pending approvals/user-input requests, or an activity cooldown, and no defer-and-retry.
- Web: `apps/web/src/routes/_chat.automations.*`, `-automations.shared.tsx` (hooks + `AutomationDialog` + live event reducer), `lib/automationForm.ts`, `lib/automationIntent.ts` (chat-intent parsing with mandatory user confirmation), `components/chat/AutomationCreatedCard.tsx`, `ComposerAutomationSetupBanner.tsx`.

## Non-negotiable constraints

- `packages/contracts` stays schema-only. All runtime logic in `packages/shared` or the owning app.
- Additive MCP changes only: never rename or break the existing three tools' current call shapes; new capabilities are new optional params or new tools. Existing automations rows must keep decoding (all new definition fields optional with safe defaults in JSON decode paths).
- Keep the scheduler adaptive — no fixed sub-minute global loop (guardrail from `plans/README.md`).
- Agent-created automations must not escalate privileges: inherit the caller/target thread's already-consented risk posture exactly as `synara_create_automation` does today; never auto-acknowledge `fast-interval` — that one must be an explicit tool param and stays subject to the existing max-iterations cap.
- Structured results come from an MCP tool call, not from parsing magic directives out of the final message. Synara is multi-provider; directive parsing (`::inbox-item`, XML blocks) is fragile across providers. Codex's _protocol shape_ is the model; the _transport_ here is a tool call. Fallbacks must be conservative (see W3/W4).
- Any new open/close UI element uses the shared disclosure motion (`apps/web/src/lib/disclosureMotion.ts` / `DisclosureRegion`) per repo convention.
- Update `harnessPolicy.ts` (bump its version string) whenever the tool surface or automation-run protocol changes, so provider sessions learn the new contract.
- `bun run test` only (never `bun test`). One final `bun fmt` + `bun lint` + `bun typecheck` pass at the end.

## Workstreams (execute in order; W1→W4 are the core, W5–W6 are lower risk)

### W1 — Full-parity agent tool surface

Files: `apps/server/src/agentGateway/automationTools.ts`, `Layers/AgentGateway.ts`, `harnessPolicy.ts`, contracts as needed.

1. Extend `synara_create_automation` (additive params, existing calls keep working):
   - `mode: "heartbeat" | "standalone"` (default `"heartbeat"` — current behavior).
   - Full schedule object accepting the existing `AutomationSchedule` union (`interval|once|daily|weekdays|weekly|cron` with timezone), while keeping `everyMinutes` as a supported shorthand.
   - Standalone-only: optional `projectId` (default: caller thread's project), `worktreeMode`, `notificationPolicy` (see W4).
   - Heartbeat-only: existing `targetThreadId` semantics unchanged; optional `completionPolicy` passthrough (`ai-evaluated` with `stopWhen`).
   - `fastInterval: true` explicit param required to unlock sub-minute schedules (maps to the `fast-interval` acknowledged risk; keep the existing max-iterations cap and dispatch-time backstop).
2. New `synara_view_automation` tool: full definition + last N runs (default 5) + `nextRunAt` + memory excerpt (W2). Read capability, same authorization rule as `synara_cancel_automation` (creator thread or authorized against target thread), plus project-scoped read for standalone.
3. New `synara_update_automation` tool: Codex-style **full-replacement** of the mutable config (name, prompt, schedule, enabled, maxIterations, notificationPolicy, completionPolicy). Tool description must instruct: call `synara_view_automation` first and resend unchanged fields. Reject partial ambiguity loudly rather than guessing. Same authorization as cancel. `requiresActiveTurn: true`.
4. Suggested-create (Codex `suggested_create` parity, Synara-safe): add `suggested: true` param to `synara_create_automation`. When set, the automation is persisted with `enabled: false` plus a new `proposal` state (new nullable definition column, e.g. `proposal_state: "pending" | "accepted" | "dismissed" | null`), and a proposal card is surfaced in the caller thread's conversation (reuse the existing `AutomationCreatedCard` pattern — extend it with Accept/Dismiss actions wired to new WS RPC `automation.resolveProposal`). Accepting enables it; dismissing archives it. Direct (non-suggested) creation stays allowed — it is already gated by turn authority + inherited risk posture — but the harness policy text should steer agents toward `suggested: true` when the user hasn't explicitly asked for an automation.
5. Update `harnessPolicy.ts`: document the new tools/params, the view-before-update rule, and the W3/W4 reporting protocol. Bump the policy version string.

Tests: extend the agent-gateway/automation tool tests (mirror existing test layout); cover authorization failures, additive-compat of old call shapes, fast-interval gating, proposal lifecycle.

### W2 — Run envelope + persistent automation memory

Files: `AutomationService.ts` (`dispatchRun`), contracts, `AutomationRepository.ts` + new migration, `automationTools.ts`.

1. New migration: `automation_memory` (`automation_id` PK/FK, `content` TEXT, `updated_at`). DB-backed, not a file — worktree runs and multi-provider runtimes cannot rely on a stable host path.
2. Build the dispatch message as an envelope prepended to the configured prompt (both modes; wording adapted per mode):

   ```text
   Automation: <name>
   Automation ID: <id>
   Run: <trigger_type>, scheduled for <ISO> (last run: <ISO or "never">, iteration <n>/<max or ∞>)
   Memory (persistent across runs — update it via synara_update_automation_memory before finishing):
   <memory content, or "(empty)">

   ---

   <configured prompt>
   ```

   Cap injected memory at 8 KiB (truncate oldest content with an explicit truncation marker). Keep the envelope construction in one pure, unit-tested helper (e.g. `apps/server/src/automation/runEnvelope.ts`).

3. New MCP tool `synara_update_automation_memory({automationId, content})` — full replacement, 32 KiB hard limit, callable only from a turn dispatched by that automation (match on the run's thread/turn) or from the automation's creator/target thread. `requiresActiveTurn: true`.
4. Include a memory excerpt in `synara_view_automation`. Show memory read-only in the web automation detail route.

Tests: envelope helper unit tests (never re-derive the format inline elsewhere), memory CRUD + authorization, truncation behavior.

### W3 — Heartbeat protocol: structured decision + eligibility gates

Files: `AutomationService.ts`, `AutomationRunReactor.ts`, `runResult.ts`, contracts, `automationTools.ts`, web triage surfaces.

1. New MCP tool `synara_report_automation_result({decision: "notify" | "silent", title?, summary?})`, callable only from within an automation-dispatched turn (resolve the run from the caller's thread/turn; error otherwise). Persist into the run's `result_json`. This replaces Codex's `NOTIFY/DONT_NOTIFY` XML block and its `::inbox-item` directive with one uniform tool for both modes.
2. Heartbeat envelope (W2) instructs: finish by calling `synara_report_automation_result`; use `"silent"` when nothing needs the user's attention; you may call `synara_cancel_automation` on yourself when monitoring is no longer needed (already supported — keep working).
3. Fallback when the tool was never called in a run: heartbeat runs default to `"notify"` **iff** the final assistant message is non-empty, else `"silent"`; standalone runs always default to `"notify"` with a heuristic summary (current `runResult.ts` behavior). Conservative: never silently swallow a failed run — failures always notify regardless of decision.
4. Triage semantics: `"silent"` successful runs are auto-marked read (no attention badge, still in history). Wire through `applyAutomationEvent` and the attention-count helpers in `apps/web/src/routes/-automations.shared.tsx` / `lib/automationStatus.ts`.
5. Eligibility gates before dispatching a heartbeat turn (extend the current skip logic in `dispatchRun`/`runDueOnce`):
   - Target thread has an active turn (any origin, including the user typing/running — today only automation runs are checked).
   - Pending approval request or user-input request on the target thread.
   - Activity cooldown: less than `heartbeatCooldownSeconds` (default 60, definition-level override optional) since the thread's last turn completion.
   - Ineligible → **defer**, not skip: keep the run row `pending` with a `deferred_until`-style short retry (reuse the scheduler's early-wake queue; retry on subsequent passes) within a defer window of 10 minutes from `scheduled_for`; past the window, record `skipped` with the gate reason in `result_json`. Determine "thread busy / pending approval" from the orchestration engine's existing thread/turn state — do not scrape logs.

Tests: decision persistence + fallbacks, gate matrix (busy / approval-pending / cooldown / defer-window-expiry), silent-run triage behavior.

### W4 — Notification policy

Files: contracts, migration (nullable `notification_policy` column), `AutomationService.ts`, web dialog + detail route, `automationTools.ts`.

1. `notificationPolicy: "all" | "failed-runs-only"` (default `"all"`; store null as `"all"`). `"failed-runs-only"`: successful runs are auto-marked read like `"silent"` decisions; failed/interrupted runs surface normally.
2. Settable from `AutomationDialog`, `synara_create_automation`, and `synara_update_automation`.
3. If Synara push-notification/attention plumbing distinguishes levels, honor the policy there too; otherwise triage-badge behavior is sufficient for this plan.

### W5 — Deterministic schedule jitter

Files: `apps/server/src/automation/schedule.ts` (+ tests), `AutomationService.ts` (next-run computation call sites), small persistence addition for the salt.

1. Apply a deterministic 0–119s jitter to computed `next_run_at` for `daily`, `weekdays`, `weekly`, and `cron` schedules only (never `interval`, `once`, `manual`): `jitter = SHA256(installSalt + ":" + automationId + ":" + unjitteredOccurrenceISO) mod 120`.
2. `installSalt`: one random value generated once and persisted server-side (e.g. a `server_settings`-style KV row; create the smallest reasonable storage if none exists).
3. Keep jitter inside the pure schedule module so it is unit-testable (same inputs → same offset); misfire policies operate on jittered times consistently. UI "next run" previews may show the unjittered time — do not plumb the salt into the web app.

### W6 — Scheduler parallel dispatch cap

Files: `AutomationScheduler.ts`, `AutomationService.ts` (`runDueOnce`).

Change due-definition dispatch from sequential (`concurrency: 1`) to bounded parallel (cap 3, mirroring Codex's per-tick selection). One automation's dispatch failure must not block or fail the others (isolate per-item, log, continue). Keep lease semantics unchanged. Verify no shared mutable state in `dispatchRun` breaks under parallelism (worktree creation, repository writes) — if anything is unsafe, fix it or keep that path serialized with a comment stating why.

## Out of scope (do not do)

- Retry policies (`fixed`/`exponential`) — keep rejected at validation, per plans 001–005 decisions.
- File-based memory, `::inbox-item`/XML directive parsing, attachments in automation runs, a generic inbox system beyond the existing triage surfaces, telemetry/analytics events.
- Any change to the scheduler's adaptive polling model beyond W6.

## Verification

- Focused: `cd apps/server && bun run test src/automation/schedule.test.ts src/automation/Layers/AutomationService.test.ts src/persistence/Layers/AutomationRepository.test.ts` plus new agent-gateway tests; `cd packages/contracts && bun run test src/automation.test.ts`; relevant `apps/web` tests.
- Migration safety: existing definition rows (pre-007 JSON) must load with defaults; write a decode test with a pre-007 fixture row.
- Final gate: `bun fmt`, `bun lint`, `bun typecheck` all pass (one pass at the end).
- Report back: what shipped per workstream, deviations from this plan with rationale, remaining risks, and exact test/verification output.

## STOP conditions

- Stop and report if the orchestration engine cannot expose "thread busy / pending approval / last activity" state needed for W3 gates without invasive changes — do not scrape rollout logs or SQLite projections directly from the automation domain.
- Stop and report if additive-compat of the existing three MCP tools cannot be preserved.
- Stop and report before any migration that would rewrite or drop existing automation rows.
