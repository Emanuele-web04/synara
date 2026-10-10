# Brief: Fix & harden Profile-stats data layer (server + contract + query hooks)

You are GPT-5.5 (xhigh) working in the Synara monorepo at `/Users/emanueledipietro/Developer/synara`.
A "Profile / stats" feature was just built. The DATA is wrong in three places and the loading is
slow. Your job is the DATA/LOGIC/PERF layer ONLY. A separate agent (Opus) owns all React UI.

## Strict file ownership — DO NOT TOUCH UI FILES

YOU OWN (edit freely):
- `packages/contracts/src/stats.ts` (the ProfileStats schemas)
- `apps/server/src/profileStats.ts` (the SQL stats service)
- `apps/server/src/providerUsageSnapshot.ts` (token-archive loaders)
- RPC wiring: `packages/contracts/src/ws.ts`, `packages/contracts/src/rpc.ts`,
  `packages/contracts/src/ipc.ts`, `apps/web/src/wsNativeApi.ts`, `apps/server/src/wsRpc.ts`
- `apps/web/src/lib/serverReactQuery.ts` (React Query factory functions ONLY)
- A new SQLite index migration if you add one (`apps/server/src/persistence/Migrations/*` + register in `Migrations.ts`)

DO NOT TOUCH (Opus owns these — editing them will cause merge conflicts):
- Anything under `apps/web/src/components/profile/**`
- `apps/web/src/routes/**`, `apps/web/src/components/Sidebar.tsx`, `apps/web/src/settingsNavigation.ts`,
  `apps/web/src/routes/_chat.settings.tsx`, `apps/web/src/lib/icons.tsx`

## Two databases to validate against (BOTH have live data)

- BRANCH dev DB (what the dev instance uses): `./.synara/electron-dev/dev/state.sqlite`  (~40 turns)
- REAL app DB: `~/.synara/userdata/state.sqlite`  (~437 turns, 192 MB) — the important one

Use the `sqlite3` CLI to validate every query against BOTH before and after your change.

## Verified data shapes (trust these; confirm if unsure)

- `projection_turns.requested_at` = ISO-8601 UTC, e.g. `2026-06-14T00:26:11.226Z`.
  `DATETIME(requested_at, '+02:00')` parses it and shifts to local — VERIFIED working.
- `projection_threads.model_selection_json` = `{provider, model, options?: {reasoningEffort?|effort?, fastMode?, ...}}`.
  Codex/Cursor use `options.reasoningEffort`; Claude uses `options.effort`. Many rows have NO options.
- `projection_thread_messages.skills_json` (role='user') = `[{name, path}]` (slash-command SKILLS), e.g.
  `[{"name":"check-code","path":".../check-code/SKILL.md"}]`. Sparse (24 of 540 msgs in real DB).
- `projection_thread_messages.mentions_json` (role='user') = `[{name, path}]` (AGENTS/plugins), e.g.
  `[{"name":"linear","path":"plugin://linear@openai-curated"}]`. Even sparser but real.
- `orchestration_events` rows of `event_type='thread.turn-start-requested'` carry
  `payload_json.modelSelection.{provider, model, options}` PER TURN (the canonical per-turn selection).
  Also `event_type='thread.message-sent'` carries `payload_json.skills`.
- `projection_thread_activities` rows with `tone='tool'` have `kind` = generic lifecycle
  (`tool.started`/`tool.completed`/`tool.updated`) — the skill/command name is NOT in `kind`, it is buried
  in `payload_json.detail`. DO NOT use this table for skill-name counts. (Investigated and rejected.)

## CONFIRMED BUGS (with evidence) — fix all three

### BUG 1 — reasoning / fast-mode / provider-model are THREAD-weighted, must be PER-TURN
Current code joins `projection_turns` → `projection_threads.model_selection_json`, i.e. it attributes
every turn to the thread's CURRENT/last model selection. A thread's selection changes over its life, so
this is wrong. The correct source is the per-turn snapshot in `orchestration_events` (`thread.turn-start-requested`).

Evidence (real DB):
- provider per-turn(events): cursor 206 / claudeAgent 148 / codex 91  (total 445)
- provider thread-weighted:   cursor 205 / claudeAgent 147 / codex 86  (total 438)  ← undercounts, wrong split
- reasoning per-turn vs thread-weighted distributions differ materially (e.g. xhigh 320 vs 323, max 27 vs 44).
- fastMode per-turn 156/445 = 35% vs thread-weighted 150/438 = 34%.

FIX: compute provider/model mix, reasoning distribution, and fast-mode % from
`orchestration_events WHERE event_type='thread.turn-start-requested'`, reading
`json_extract(payload_json,'$.modelSelection.provider' | '$.modelSelection.model' |
'$.modelSelection.options.reasoningEffort' | '$.modelSelection.options.effort' | '$.modelSelection.options.fastMode')`.
When an event has no `modelSelection` (older events), fall back to that thread's current
`projection_threads.model_selection_json` joined on `payload_json.threadId` (= `stream_id`). Keep
`COALESCE(reasoningEffort, effort)` for the reasoning label. `topReasoning` = most common NON-null value;
percent = its share of all per-turn selections that have a reasoning set (decide and document the denominator).

### BUG 2 — skills metric is incomplete (missing agents) and unformatted
`skills_json` is the right source for SKILLS but it omits AGENTS (`mentions_json`). The reference
"Most used plugins" mixes `$skill` and `@agent`. Combine both:
- skills from `projection_thread_messages.skills_json` (role='user') → `kind:"skill"`, displayName `$name`
- agents from `projection_thread_messages.mentions_json` (role='user') → `kind:"agent"`, displayName `@name`
Use `json_each(...)` with the same defensive `CASE WHEN json_valid(...) AND json_type(...)='array'` guard
already in the code. Count occurrences across user messages, group by name+kind, order by count desc.
Definitions: `skillsExplored` = distinct (name,kind) used; `totalSkillsUsed` = sum of all occurrences.
`mostUsedSkill` = top row. Keep counts honest — they ARE small (this is correct; the reference numbers are mock).

### BUG 3 — heatmap should be TOKEN activity (per local day), with a turn-count fallback
The reference titles it "Token activity". The current heatmap uses turn counts and, critically, the
per-day TOKEN buckets are already computed in `providerUsageSnapshot.ts` (`accumulate*Tokens` builds
`acc.byDay`) and then THROWN AWAY. Surface them.
FIX: have the token loader expose a per-LOCAL-day token bucket array (codex + claude), capped to the
heatmap window (last 371 days). The token-based heatmap is authoritative WHEN token data exists; when a
user has no readable token archive (cursor/grok/etc.), the UI falls back to the turn-count heatmap.
So expose BOTH: keep the turn-count heatmap in the fast/core payload (instant, universal) AND add a
token-based per-day heatmap in the token payload. Each cell: `{day, count, weekday, intensity}` plus
the metric label.

## PERFORMANCE / LOADING / COMPLEXITY (the second half of the job)

The expensive operation is the JSONL archive walk (`loadLocalProviderUsageTokenStats`) which reads up to
6000 files fully and sequentially on first load — it blocks the whole RPC, so the page can't paint until
the disk walk finishes. The SQL is trivially cheap (hundreds of rows). Restructure for fast first paint:

1. SPLIT THE RPC into two:
   - `stats.getProfileStats` → CORE, SQL-only, returns in <50ms. Streaks, turn-heatmap, active hours,
     per-turn provider/model mix, per-turn reasoning + fast-mode, skills+agents, prompt/thread totals,
     identity, local Codex quota (the quota already comes from the cheap local snapshot — keep it, but if
     it requires the archive walk, move it to the token call). The page renders fully from this.
   - `stats.getProfileTokenStats` → SLOW, archive-backed: lifetime tokens, peak-day tokens+date,
     per-day token heatmap (371-day window), providers/unavailableProviders. Cached (reuse the existing
     5-min TTL + pending-coalescing pattern). The UI shows skeletons for the 2 token tiles and upgrades
     the heatmap when this resolves.
2. Make the token walk cheaper:
   - Parallelize file reads with a bounded concurrency (e.g. 16) instead of the sequential `for await`.
   - Split "lifetime" (needs all files, last `token_count` per codex session file) from "per-day heatmap"
     (only needs files within the 371-day window). Don't full-parse window files you don't need.
   - For codex session files only the LAST `token_count` event matters — you may read from the end of the
     file rather than parsing every line, if it's a clean win (optional).
3. SQL perf: the global `GROUP BY day/hour` and `(role,source)` scans have no covering index (only
   thread-scoped ones exist). Tables are small today so it's fine, but add a lightweight migration with
   `CREATE INDEX IF NOT EXISTS` on `projection_turns(requested_at) WHERE turn_id IS NOT NULL`,
   `projection_thread_messages(role, source)`, and an events index on
   `orchestration_events(event_type)` IF one doesn't already cover it. Register it in `Migrations.ts`.
   Keep index additions minimal — do not slow the hot insert path needlessly; justify each.
4. Reduce complexity: the `getProfileStats` Effect is a long single function. Factor the per-metric SQL
   into small named helpers. Keep every query wrapped in the existing `safeQuery`/`orElseSucceed([])`
   so one missing column never blanks the card. Keep error channel `never` (graceful degradation).

## PINNED CONTRACT (both you and the UI build to this — keep these exact names)

```ts
// stats.getProfileStats  (CORE, fast)
ProfileStats {
  generatedAt: string
  timezone: { utcOffsetMinutes: number; today: string }
  identity: { homeDirBasename: string; initials: string; defaultHandle: string }
  activity: {
    currentStreakDays: number; longestStreakDays: number
    totalPromptsSent: number; totalThreads: number; promptsToday: number
    heatmapMetric: "turns"                       // core heatmap is always turn-based
    heatmap: Array<{ day: string; count: number; weekday: number; intensity: number }>
  }
  activeHours: { startHour: number|null; endHour: number|null; turnCount: number; label: string|null }
  insights: {
    fastModePercent: number|null
    topReasoning: string|null; topReasoningPercent: number|null
    skillsExplored: number; totalSkillsUsed: number
  }
  providerModels: Array<{ provider: ProviderKind|"unknown"; model: string; turnCount: number; percent: number }>
  skills: Array<{ name: string; displayName: string; kind: "skill"|"agent"; runCount: number }>
  mostUsedSkill: { name: string; displayName: string; kind: "skill"|"agent"; runCount: number } | null
  quota: { status: "available"|"unavailable"; provider: ProviderKind|null; window: string|null;
           usedPercent: number|null; resetsAt: string|null; planName: string|null }
}

// stats.getProfileTokenStats(input: { utcOffsetMinutes: number; codexHomePath?: string })  (SLOW, archive)
ProfileTokenStats {
  available: boolean
  lifetimeTotalTokens: number|null
  peakDayTokens: number|null
  peakDay: string|null                            // YYYY-MM-DD
  providers: ProviderKind[]
  unavailableProviders: ProviderKind[]
  heatmapMetric: "tokens"
  heatmap: Array<{ day: string; count: number; weekday: number; intensity: number }>  // tokens/day, 371d window
}
```

Notes:
- Move the quota into whichever call keeps the CORE call fast & network-free. Quota MUST stay on-device
  (read from the local Codex session archive's `rate_limits`, as today) — NEVER call provider HTTP APIs.
- Keep `StatsGetProfileStatsInput { utcOffsetMinutes: number; codexHomePath?: string }`.
- Intensity = 0..4 bucket relative to the window max (keep the existing helper).
- `heatmap[].weekday` = 0..6 (Sun..Sat); cells span the trailing 371 local days inclusive of today.

## Effect / codebase idioms to follow

- Service: `ProfileStatsQuery` is a `ServiceMap.Service` with `Layer.effect`, wired in
  `serverLayers.ts` already. Add the token call either to the same service or a sibling — your choice —
  but keep it provided through `makeServerRuntimeServicesLayer` and yielded in `makeWsRpcLayer`.
- RPC: follow the existing `Rpc.make(...)` + `WsRpcGroup.make(...)` + `WS_METHODS` + `tagRequestBody` +
  `NativeApi` + `wsNativeApi.ts transport.request` pattern exactly (the existing `stats.getProfileStats`
  is your template — add `stats.getProfileTokenStats` the same way).
- React Query: in `serverReactQuery.ts` add `serverProfileTokenStatsQueryOptions()` next to the existing
  `serverProfileStatsQueryOptions()`. Keep both keyed by `utcOffsetMinutes`. The UI will call both.
- Use `sql<{ readonly col: type }>\`...\`` typed raw queries (see existing code). Bind the tz modifier as
  a parameter (`${tz}`) — verified that SQLite accepts it inside `DATETIME(col, ?)`.
- `noUncheckedIndexedAccess` is ON — guard array index access.

## Validation (do this before declaring done)

1. For each fixed metric, run the OLD vs NEW SQL against BOTH DBs with `sqlite3` and paste the numbers in
   your summary, showing the per-turn vs thread-weighted difference is resolved.
2. `npx turbo run typecheck --filter=@synara/contracts --filter=@synara/cli` must pass. DO NOT run the web
   (`@synara/web`) typecheck — its UI is being rewritten in parallel and will be red until Opus finishes.
3. `bun fmt` and `bun lint` (lint must have 0 errors; warnings ok). NEVER run `bun test`.
4. In your final summary, document: the exact final `ProfileStats` + `ProfileTokenStats` field list, the
   exact exported query-factory names in `serverReactQuery.ts`, and any contract deviation from the pin.

Take your time; correctness of the per-turn attribution and the fast-first-paint split are the priorities.
