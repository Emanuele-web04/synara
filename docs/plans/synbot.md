# SynBot: bots in Synara (Beta)

Status: in progress on `claude/bots-to-synara-03d285` (Synara) and `claude/synbot` (SynaraIOS).
Decided with the founder on 2026-11-05. HoloBot (`~/Developer/holobot`) is the UI and behaviour
reference; Synara's Hubs engine is the orchestration it runs on.

## Product

SynBot is an orchestration layer above every chat: bots with memory that delegate to each other,
spawn tasks in isolated worktrees, report back when the work is done, and give one recap.

- **Bot**: a role with a scope. Name, mascot (shape + color), role line, instructions, scope
  (projects: all or a list; optional path globs), engine (any provider that can mount the Synara
  gateway, plus model and options), autonomy (`auto` | `ask`), pinned skills, pinned tile.
- **SynBot**: the main bot. Seeded once, scope all projects, cannot be removed, uses the Synara
  logo as its mascot, runs on a strong model the user picks. It routes work to bots.
- **Bot chat**: a persistent conversation, read-only plus the bot tools. All edits happen in
  tasks (worker threads), in a worktree by default.
- **Task**: a worker thread a bot started. Opens in the right dock.

## Decisions

| Topic | Decision |
| --- | --- |
| Data model | A bot is a Hub (project kind `group`) with a row in `bot_profiles`. Coordinator thread = bot chat, workers = tasks. Same queue, health ladder, memory and Library. |
| Rollout | Beta only (`synbot` in `BETA_ONLY_FEATURES`; server refuses on Stable). Beta hides the Hubs UI; Stable keeps it untouched until SynBot ships to Stable, then the Hubs UI is deleted. |
| Existing Hubs | Fresh start. On Beta, Hubs without a bot profile are paused once and hidden. Nothing is deleted. |
| Naming | New surface uses bot vocabulary on the wire (`bots.*`). Physical SQL tables keep their names; migrations are additive. `projectAgent.*` stays for Stable Hubs and older iOS builds until promotion. |
| Delegation | Any bot chat may delegate to any other bot: a message into the target bot's chat that carries the original human request (provenance), tracked in `bot_delegations`. Workers cannot spawn. |
| Caps | Depth 3, 4 delegations per turn, no cycles (a bot already in the chain cannot be asked again), one active task per bot (rest queued), 3 tasks across all bots (setting 1–8). |
| Control over other chats | Full read, write, steer and stop on every Synara thread when the bot's turn is rooted in a human message. Turns started by reports, wakes or automations need the user's Yes. Every intervention is labelled in the target chat; a global Stop exists; a setting turns "control without asking" off. |
| Memory | Per bot (the Hub memory) plus SynBot's global memory; SynBot's context includes every bot's role, scope and memory index. |
| Recap | One recap per request (default) or one line per task, chosen in Settings. Failures report at once. |
| Engines | Any gateway-capable provider, models from live discovery. New bots default to an economy model of their provider. |
| Scope | Guides routing and is told to the bot; a task that touched files outside the scope shows a warning, never blocks. |
| Creation | Templates (Frontend, Backend, QA, Docs, iOS, the three-bot crew), pinned skills, project-scan suggestions, proposals from use ("Save as a bot?"), and adding a folder that is not a Synara project yet (offers `git init` when needed). |
| Autonomy | Per bot, default `auto`. `ask` turns an incoming delegation into a Start / Not now card. |
| Merge proof | Off by default (Settings). When on: Merge enabled only with required checks green on the current head and the PR up to date with its base (behind → update branch, wait, ask); red flags always shown; merge only from the user's press. |
| Periodic check-ins | Out of v1. Wakes are event-driven only (the Hubs machinery). |
| Long threads | Provider compaction. |
| Desktop UI | HoloBot layout and components, Synara skin (`text-ui` tokens, themes). Mascots ported; no WebGL rim or dither. Rail item `synbot` replaces `studio` on Beta. Panel: pinned tiles, My bots rows with status dots. Main: bot thread. Task opens its worker thread in the right dock. |
| Transcript | HoloBot transcript shell (bubbles, cards, live line, folded work) with Synara internals (ChatMarkdown, end-follow scroll). Bot threads show replies, delegation lines, task cards, choice cards and recaps; no tool rows. |
| Composer | Synara's composer in a pill variant. |
| iPhone | TabView Bot / Threads (sidebar-adaptable on iPad), full mirror including bot editing and Merge. Hidden when the host has no SynBot. |

Out of v1: proactive GitHub (guardian), limit hand-off / copy bot, periodic check-ins, Live
Activity, WebGL rim and dither.

## Architecture

### Storage (additive)

- `bot_profiles(project_id PK → project_agent_configs, kind 'main'|'bot', role, mascot_shape,
  mascot_color, scope_json, autonomy, pinned_skills_json, pinned, created_at, updated_at)`.
- `bot_delegations(id PK, request_id, root_id, depth, from_project_id, from_thread_id,
  from_turn_id, to_project_id, to_thread_id, message_id, brief, source_messages_json, state,
  result_summary, created_at, started_at, settled_at)`.
- `bot_settings(singleton)`: recap mode, control without asking, merge proof, max parallel tasks,
  fresh-start marker.

### Server

- `apps/server/src/bots/`: `BotService` (profiles, roster, settings, delegations, cards,
  merge proof) built on `ProjectAgentService` (the Hub engine).
- Gateway tools (bot chats only): `synara_bots_list`, `synara_bot_delegate`,
  `synara_bot_delegations`, `synara_bot_propose`, `synara_bot_suggest`, `synara_bot_add_project`.
  Existing thread tools gain the full-control rule for bot principals.
- Provenance: a delegation message resolves to the original human messages when the target bot
  starts Hub work from it.
- Settlement: a delegation settles when the target bot is idle and every work item started from
  the delegation's turns is terminal; the report (the target's last reply plus task outcomes) is
  posted into the requester's chat, which wakes it.

### Web

- Route `/synbot` (+ `/synbot/$botId`), rail item `synbot`, panel bot list, ported transcript,
  composer pill, bot sheet with templates, Settings → SynBot.

### iOS (SynaraIOS)

- Swift mirrors of `bots.*`, TabView Bot / Threads, bot list, bot thread, cards, editor, Merge.

## Done when

On an isolated Beta instance with real providers, on the Mac and the iPhone simulator: "add X to
the frontend and test it" → SynBot routes to Frontend → Frontend delegates to QA → worktrees →
one recap → proof card when enabled. `bun run fmt:check`, `lint`, `typecheck`, affected tests and
`migrations:check` pass; then one PR to `main`.
