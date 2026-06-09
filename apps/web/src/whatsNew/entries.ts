// FILE: whatsNew/entries.ts
// Purpose: Curated "What's new" changelog rendered in the post-update dialog
// and the settings Release history view.
// Layer: static data consumed by `useWhatsNew`, `WhatsNewDialog`, and
// `ChangelogAccordion`.
//
// Authoring guide
// ---------------
//   - Prepend new releases so the file reads newest-first (the UI sorts too,
//     but keeping the source tidy makes PRs easier to review).
//   - `version` must match `apps/web/package.json#version` exactly. The
//     logic compares versions as semver and only opens the dialog when the
//     installed build has a curated entry here.
//   - `date` is rendered verbatim — pick whatever format you want (e.g.
//     `"Apr 18"`, `"2026-04-18"`), just be consistent release-to-release.
//   - Each feature takes an `id` (stable, unique per release), a short
//     `title`, a marketing `description`, and optionally an `image`
//     (absolute path from `apps/web/public`, e.g. `/whats-new/0.0.29/foo.png`)
//     plus `details` for the longer technical note shown under the image.

import type { WhatsNewEntry } from "./logic";

export const WHATS_NEW_ENTRIES: readonly WhatsNewEntry[] = [
  {
    version: "0.1.6",
    date: "Jun 9",
    features: [
      {
        id: "thread-markers",
        title: "Transcript markers make long chats easier to navigate",
        description:
          "You can now mark important transcript moments, jump back to them, and manage them from the Environment panel without losing your place in busy threads.",
        details:
          "Markers now round-trip through orchestration events, projection storage, migrations, shared validation helpers, transcript selection actions, highlighted markdown spans, marker-aware scrolling, and focused browser/unit coverage.",
      },
      {
        id: "link-favicons",
        title: "Links show real site identity",
        description:
          "AI response links, source lists, composer chips, and sent user bubbles now share the same link parsing path with website favicons instead of generic globe icons.",
        details:
          "Synara now caches site favicons server-side, serves authenticated favicon image URLs, recognizes bare domains in composer text, and keeps markdown link text aligned with the same medium-weight chip styling used while composing.",
      },
      {
        id: "local-server-environment",
        title: "Local dev servers are easier to spot",
        description:
          "The Environment panel can now show local servers tied to the current project, with clearer browser/terminal identity and controls for tracked project runs.",
        details:
          "The server now monitors listening processes with address-family metadata, tracks project-run ownership, syncs local server state over WebSocket/RPC contracts, and adds sidebar/project-run affordances for starting, viewing, and stopping dev servers.",
      },
      {
        id: "transcript-scroll-reliability",
        title: "Transcript scrolling is calmer",
        description:
          "Collapsed work sections no longer drag the transcript tail, marker navigation is more predictable, and thread rendering does less surprising work while sessions update.",
        details:
          "The timeline path now separates marker scroll behavior from live-output sticking, avoids retriggering tail scrolls for collapsed work disclosure changes, and has extra coverage around marker selection, rendering, and scrolling.",
      },
      {
        id: "orchestration-and-keybindings",
        title: "Small orchestration and shortcut fixes landed too",
        description:
          "Thread orchestration, terminal identity, recent view switching, retired-model shortcuts, and local-server cleanup picked up focused reliability fixes.",
        details:
          "This release tightens provider/runtime event projection, terminal visual identity, local-server process cleanup, recent-view key handling, and retired model picker shortcuts, with new tests for the affected contracts and stores.",
      },
    ],
  },
  {
    version: "0.1.5",
    date: "Jun 8",
    features: [
      {
        id: "desktop-update-packaging",
        title: "Desktop updates are packaged more reliably",
        description:
          "The macOS release path now has stronger artifact smoke checks, zip finalization helpers, and updater download coverage so new builds are easier to trust before they ship.",
        details:
          "Release tooling now validates Mac update artifacts, parses boolean environment flags consistently, and tests the resumable update downloader without the older update-feed cache layer. The README and release docs were refreshed around the current Synara desktop flow too.",
      },
      {
        id: "diff-panel-refactor",
        title: "The diff panel is easier to navigate",
        description:
          "Diff review now has a cleaner toolbar, file list, jump menu, and patch viewport so repository and turn changes are easier to scan without losing context.",
        details:
          "The large diff panel was split into focused components with explicit repo-vs-turn view logic, shared selectors, searchable file filtering, and tests for the new source-resolution behavior.",
      },
      {
        id: "queued-plan-dispatch",
        title: "Queued chat turns stay chat turns",
        description:
          "Queued follow-ups now preserve their own mode and attachments even when the live composer is sitting in a plan follow-up state.",
        details:
          "Queue draining now dispatches the queued turn payload directly, keeps in-progress composer drafts intact, and has browser coverage for plan-mode threads with pending follow-ups and image attachments.",
      },
      {
        id: "composer-stack-polish",
        title: "Composer panels line up cleanly",
        description:
          "Plan activity, queued follow-ups, and live file-change panels now share one frame style above the composer, with consistent width, borders, radius, and dark-mode opacity.",
        details:
          "The stacked composer chrome now flows through a shared panel wrapper and rail sizing token, while the file-change strip only appears for active turns that actually contain provider file edits.",
      },
      {
        id: "markdown-and-menu-icons",
        title: "Markdown and mention menus got sharper",
        description:
          "Chat markdown spacing, composer command selection, plugin discovery, file icons, and mention rendering were tightened so selected references look the same before and after sending.",
        details:
          "Provider discovery now normalizes aliases and built-in metadata more carefully, command menu grouping is simpler, markdown blocks have better visual rhythm, and sent user bubbles preserve the selected file/plugin icon instead of falling back to generic text.",
      },
    ],
  },
  {
    version: "0.1.4",
    date: "Jun 7",
    features: [
      {
        id: "workspace-pinning-depth",
        title: "Important work can stay pinned",
        description:
          "Projects, threads, and specific transcript messages can now be pinned so the context you keep returning to stays close at hand across sessions.",
        details:
          "Pin state is now projected through the orchestration model, stored in dedicated persistence columns, reconciled for older databases, and shared with focused client stores so sidebar ordering, project rows, and thread detail all agree after reloads.",
      },
      {
        id: "environment-memory",
        title: "Thread context has a memory shelf",
        description:
          "The environment panel now carries pinned messages and editable notes, giving long-running chats a durable place for decisions, constraints, and useful references.",
        details:
          "Pinned message actions round-trip through server commands and snapshots, while thread notes autosave through the same projected thread detail path. This keeps the side panel useful without turning the transcript itself into a scratchpad.",
      },
      {
        id: "recent-view-switcher",
        title: "Jump between recent views faster",
        description:
          "A new recent-view switcher lets you move through recent chats, terminals, and workspace surfaces with keyboard-first navigation and visible keycap hints.",
        details:
          "Recent views are tracked in a dedicated store, activated through shared route logic, and covered by browser and unit tests so switching does not lose terminal/workspace state or collide with existing global shortcuts.",
      },
      {
        id: "composer-mentions-drafts",
        title: "Composer references behave better",
        description:
          "Mention chips, draft restoration, queued composer headers, picker sizing, and empty-chat controls were cleaned up so references stay readable while you build prompts.",
        details:
          "Mention parsing now has shared helpers and tests, composer drafts keep stronger thread/project references, and compact controls use consistent iconography across the empty state and active chat surface.",
      },
      {
        id: "resumable-desktop-updates",
        title: "Desktop updates can resume",
        description:
          "The desktop updater now has resumable download infrastructure with coverage for partial files, retries, checksum-style state, and release browser test fixes.",
        details:
          "The update downloader writes through a dedicated resumable path, validates persisted metadata, handles interrupted ranges, and is tested separately from the Electron main process wiring so future updater changes have a sturdier base.",
      },
      {
        id: "git-action-guardrails",
        title: "Git actions know when pull is available",
        description:
          "Git action controls now surface pull availability more accurately and avoid offering branch actions that cannot safely run for the current repository state.",
        details:
          "The Git core contract, broadcaster, React query helpers, and UI control logic now carry pull availability together, so action buttons line up with upstream/behind checks instead of guessing locally in the component.",
      },
      {
        id: "claude-terminal-reliability",
        title: "Runtime failures are easier to survive",
        description:
          "External Claude shutdowns, terminal cleanup, websocket RPC errors, and provider session recovery picked up extra guards for reconnects and interrupted work.",
        details:
          "Claude SIGTERM from outside Synara is treated as a benign suspend path, terminal process cleanup has stronger tests, and websocket RPC failure handling is less likely to leave the UI believing a request is still in flight.",
      },
      {
        id: "migration-and-release-hardening",
        title: "Migrations and release checks got sharper",
        description:
          "Pinned-state migrations, snapshot projection tests, browser release tests, shortcut tests, and shared pinning logic were expanded to keep this deeper state model predictable.",
        details:
          "New migrations cover pinned messages, thread notes, and project pins; legacy pinned-thread reconciliation was tightened; and the release suite now exercises the new state through contracts, server projection, shared helpers, and web UI logic.",
      },
    ],
  },
  {
    version: "0.1.3",
    date: "Jun 5",
    features: [
      {
        id: "session-side-panel-clarity",
        title: "The chat side panel is clearer",
        description:
          "Thread activity, agent detail rows, environment controls, Git actions, branch controls, and queued composer state were tightened so the main chat and side panel stay easier to scan during busy sessions.",
      },
      {
        id: "thread-recap-panel",
        title: "Long chats can be recapped in place",
        description:
          "Synara can now generate and cache thread recaps, show current-state context in the chat environment, and reuse provider-backed recap generation without making the transcript harder to follow.",
      },
      {
        id: "diff-totals-performance",
        title: "Large diffs do less duplicate work",
        description:
          "Repo diff totals are computed once for the active chat and shared between the header and environment panel, with memoized patch stats to avoid re-parsing the same large diff during live updates.",
      },
      {
        id: "archived-delete-cleanup",
        title: "Archived cleanup is more immediate",
        description:
          "Deleting archived threads now goes through one shared client path, removes rows optimistically, batches worktree-linked deletes, and reconciles once with the latest server snapshot.",
      },
      {
        id: "terminal-and-transcript-guards",
        title: "Terminals and transcripts are safer under load",
        description:
          "Terminal runtime cleanup, provider activity ingestion, transcript rendering, and session handoff logic picked up extra safeguards for reconnects, shell summaries, agent activity, and active task rendering.",
      },
      {
        id: "desktop-update-polish",
        title: "Desktop update prompts are quieter",
        description:
          "Background update polling no longer exposes a manual check button at the wrong time, update state is restored more predictably, and production builds keep source maps off unless a diagnostic release opts in.",
      },
      {
        id: "release-readiness-fixes",
        title: "Small release-readiness fixes landed too",
        description:
          "Image attachment expectations, optional callback typing, recap test doubles, composer spacing, reference chips, and queued row styling were aligned with the current UI so the final check suite stays green.",
      },
    ],
  },
  {
    version: "0.1.2",
    date: "Jun 4",
    features: [
      {
        id: "lighter-terminals",
        title: "Terminals are lighter",
        description:
          "Terminal output now does less work end-to-end: batching, renderer acknowledgements, smarter backpressure, cheaper history updates, and more faithful reconnect replay keep busy terminals lighter under noisy commands and long-running TUIs.",
      },
      {
        id: "terminal-workspace-and-appearance",
        title: "Terminal workspaces feel cleaner",
        description:
          "Terminal-only workspaces skip hidden chat work, panes move between layouts without remount churn, close prompts only appear when a tab is active or needs attention, and terminal font/color settings now follow the active theme.",
      },
      {
        id: "opencode-startup-reliability",
        title: "OpenCode starts faster and fails louder",
        description:
          "Local OpenCode servers are pooled for recent sessions, startup waits longer before timing out, session creation runs alongside inventory discovery, and failure details now include redacted command output instead of vague startup errors.",
      },
      {
        id: "provider-health-stability",
        title: "Provider health checks are less jumpy",
        description:
          "Slow Claude and OpenCode probes get longer timeouts, transient command timeouts no longer make a previously ready provider look broken, and Claude auth refreshes invalidate cached subscription state.",
      },
      {
        id: "stale-claude-resume-recovery",
        title: "Claude resumes recover from stale native sessions",
        description:
          "When Claude reports a missing conversation id, Synara clears the stale resume cursor, recreates the provider session, and retries with transcript context instead of leaving the turn failed.",
      },
      {
        id: "desktop-update-manual-fallback",
        title: "Desktop updates now have a manual escape hatch",
        description:
          "If an in-app install silently fails, Synara restarts the backend, resumes update polling, deduplicates error toasts, and points you at the exact GitHub release page for a manual download.",
      },
      {
        id: "mac-desktop-chrome-alignment",
        title: "macOS desktop chrome stays aligned",
        description:
          "Traffic-light placement and renderer gutter spacing now share one geometry helper and react to Electron zoom changes, keeping top-bar controls lined up across chat, settings, and workspace views.",
      },
      {
        id: "settings-appearance-refresh",
        title: "Settings and appearance controls are easier to scan",
        description:
          "Theme selection moved to a segmented control, settings rows share tighter typography, provider update failures can expose a copyable manual command, and custom binary-path confirmations survive restarts.",
      },
      {
        id: "agent-task-activity-rendering",
        title: "Agent task activity is easier to follow",
        description:
          "OpenCode task child sessions and newer shell-step events now flow into Synara's activity timeline, while generic agent task rows keep their useful prompt and result text instead of disappearing or showing wrapper noise.",
      },
      {
        id: "transport-reconnect-events",
        title: "Reconnect state is visible to UI runtimes",
        description:
          "The web transport now publishes local WebSocket state changes, giving terminal recovery and other renderer code a cleaner signal when the server reconnects or closes.",
      },
    ],
  },
  {
    version: "0.1.1",
    date: "Jun 4",
    features: [
      {
        id: "opencode-provider-depth",
        title: "OpenCode support is much deeper",
        description:
          "OpenCode startup, model discovery, command discovery, server connection options, and experimental WebSocket mode now flow through the same settings and runtime paths as the rest of Synara.",
      },
      {
        id: "opencode-command-discovery-settings",
        title: "Slash commands respect your OpenCode setup",
        description:
          "Composer slash-command discovery now uses the configured OpenCode binary, server URL, password state, and WebSocket mode, so command lists match the runtime you actually selected.",
      },
      {
        id: "desktop-update-recovery",
        title: "Desktop updates are harder to get stuck",
        description:
          "The updater now caches GitHub release metadata, preserves actionable update state across transient failures, detects stalled downloads, and clears stale same-version update payloads more deliberately.",
      },
      {
        id: "chat-chrome-refresh",
        title: "The chat surface feels tighter",
        description:
          "Composer padding, button spacing, picker sizing, panel headers, banners, dock surfaces, and chat chrome were tuned so the main workspace reads cleaner without losing controls.",
      },
      {
        id: "desktop-window-polish",
        title: "Desktop chrome fits the OS better",
        description:
          "macOS traffic-light spacing, sidebar seams, Electron card borders, motion, and titlebar controls were refined so the app frame feels more native on desktop.",
      },
      {
        id: "markdown-and-transcript-performance",
        title: "Large chats do less unnecessary work",
        description:
          "Markdown parsing is deferred more carefully, pending-interaction state is derived in one place, and transcript/session rendering avoids extra churn during busy or long-running chats.",
      },
      {
        id: "settings-back-navigation",
        title: "Settings back navigation lands in the right place",
        description:
          "The Settings sidebar back button now restores the last valid chat route, falls back to the newest live thread when needed, and drops stale split-view routes before navigating.",
      },
      {
        id: "sidebar-section-toggles",
        title: "Chats and Workspace can be hidden",
        description:
          "New sidebar section toggles let you hide the standalone Chats footer list or the Workspace tab while keeping Threads always available.",
      },
      {
        id: "legacy-database-repairs",
        title: "Imported legacy databases recover missing columns",
        description:
          "Fresh repair migrations reconcile older imported migration trackers that skipped Synara's sidechat-source or pinned-thread columns, preventing startup crashes in those upgraded histories.",
      },
      {
        id: "opencode-visual-polish",
        title: "OpenCode looks better in dark mode",
        description:
          "The OpenCode provider icon now switches to a clearer reversed asset in dark mode, with sidebar and provider picker styling adjusted around it.",
      },
      {
        id: "settings-surface-cleanup",
        title: "Settings are easier to scan",
        description:
          "Repeated boolean settings were consolidated into a shared row pattern, provider install rows got cleaner reset behavior, and OpenCode-specific controls sit with the rest of provider tools.",
      },
    ],
  },
  {
    version: "0.1.0",
    date: "Jun 3",
    features: [
      {
        id: "synara-home-migration",
        title: "Synara is now the default home",
        description:
          "The app now starts from `~/.synara`, carries the Synara environment variables through the desktop and server runtime, and safely imports existing `~/.dpcode` or `~/.t3` data on first launch.",
      },
      {
        id: "desktop-platform-polish",
        title: "Desktop startup feels more native",
        description:
          "Windows now hydrates the desktop environment from the registry so provider CLIs are found reliably, macOS keeps Liquid Glass styling only where it belongs, and older Macs get a rounded dock icon without breaking Tahoe.",
      },
      {
        id: "dock-state-recovery",
        title: "Right dock and saved UI state are sturdier",
        description:
          "Recovered browser, dock, sidechat, split-view, and panel state is now validated before use, preventing stale or corrupted localStorage from crashing the workspace.",
      },
      {
        id: "composer-picker-refresh",
        title: "Composer pickers are cleaner",
        description:
          "The traits picker and shared menu styling were refreshed with a tighter layout, clearer selection states, and a calmer feel across model and composer controls.",
      },
      {
        id: "provider-runtime-fixes",
        title: "Provider runtime noise is reduced",
        description:
          "Claude thinking-token telemetry no longer floods the timeline, provider task warnings are deduplicated more carefully, and Codex home overlays avoid stale SQLite sidecar files during startup.",
      },
      {
        id: "daily-polish",
        title: "Small workflow details got sharper",
        description:
          "Context meter labels, edit actions, completion separators, Git controls, diff routing, desktop update retry state, and shortcut handling all picked up focused fixes for smoother day-to-day sessions.",
      },
    ],
  },
  {
    version: "0.0.50",
    date: "May 28",
    features: [
      {
        id: "claude-opus-4-8",
        title: "Claude Opus 4.8 is available",
        description: "Synara now includes Claude Opus 4.8 in the Claude model picker.",
      },
    ],
  },
  {
    version: "0.0.49",
    date: "May 23",
    features: [
      {
        id: "grok-build-discovery",
        title: "Grok Build models stay current",
        description:
          "Grok model discovery now combines the CLI with xAI language-model metadata, including API aliases, so Grok Build and code-fast variants appear in the picker without waiting for another manual app update.",
      },
      {
        id: "provider-picker-readiness",
        title: "Provider choices wait for real readiness",
        description:
          "The provider picker no longer treats unknown provider status as usable. Providers stay in a checking state until Synara has confirmed that the local runtime is available and authenticated.",
      },
      {
        id: "desktop-shutdown-recovery",
        title: "Desktop shutdown is calmer",
        description:
          "The desktop backend now shuts down more deliberately on quit, reducing noisy restarts and preserving a cleaner thread sync path when the app is closing.",
      },
      {
        id: "faster-large-history-sync",
        title: "Large histories sync with less work",
        description:
          "Snapshot queries, checkpoint reads, and transcript updates picked up more focused data paths, keeping busy workspaces lighter when sessions reconnect or histories grow.",
      },
      {
        id: "diff-and-transcript-polish",
        title: "Diffs and transcripts feel steadier",
        description:
          "Whitespace diff controls, thread title updates, copy metadata, and live transcript rows received targeted fixes so common review and resume flows update more predictably.",
      },
    ],
  },
  {
    version: "0.0.48",
    date: "May 21",
    features: [
      {
        id: "grok-provider-headline",
        title: "Grok joins Synara",
        description:
          "Pick Grok as a first-class coding provider with ACP-backed sessions, model selection, approval handling, resume support, provider health checks, settings, icons, and handoff wired through the same app surfaces as the rest of your agents.",
      },
      {
        id: "provider-fallbacks-and-menus",
        title: "Provider fallbacks and desktop menus behave better",
        description:
          "Provider startup and recovery paths are more forgiving when preferred runtimes are unavailable, and desktop menu shortcuts now line up more reliably with the active workspace.",
      },
      {
        id: "snapshot-memory-caps",
        title: "Large histories stay lighter",
        description:
          "Snapshot hydration, diagnostics, and capped history paths now do less unnecessary work, reducing memory pressure when busy sessions or large workspaces reconnect.",
      },
      {
        id: "pi-and-opencode-polish",
        title: "Pi and OpenCode edge cases are smoother",
        description:
          "Pi aborts now read as interruptions, thinking levels are clamped more safely, live sidebar updates are steadier, and OpenCode/provider update handling picked up targeted reliability fixes.",
      },
      {
        id: "rpc-input-answer-preservation",
        title: "Answers survive the RPC hop",
        description:
          "User-input answers are preserved through the JSON-RPC codec, which keeps pending provider questions from losing their payload as they move between the app and server.",
      },
    ],
  },
  {
    version: "0.0.47",
    date: "May 15",
    features: [
      {
        id: "pi-provider-headline",
        title: "Pi gets a much sturdier seat at the table",
        description:
          "Pi provider sessions now benefit from tighter lifecycle handling, clearer extension-limit warnings, and provider probes that respect the binaries configured in settings.",
      },
      {
        id: "provider-auto-updates",
        title: "Providers can keep themselves fresher",
        description:
          "Provider auto-update plumbing landed across the app, making it easier to keep agent runtimes current without turning setup and maintenance into a separate chore.",
      },
      {
        id: "create-pr-availability",
        title: "Create PR only appears when it can actually work",
        description:
          "Create-PR actions now check upstream branch and availability state more carefully, so the UI is quieter until the repository is ready for a real pull request.",
      },
      {
        id: "pending-input-recovery",
        title: "Pending questions stop advancing at the wrong time",
        description:
          "Pending user-input auto-advance now cancels on question changes and in-flight responses, reducing stale answers and empty submissions in interrupted provider flows.",
      },
      {
        id: "git-and-transcript-polish",
        title: "Git status and provider transcripts read cleaner",
        description:
          "Git status refreshes, pull-error messaging, Kilo/OpenCode transcript handling, repo diff scopes, and provider install docs links all picked up focused reliability polish.",
      },
    ],
  },
  {
    version: "0.0.46",
    date: "May 13",
    features: [
      {
        id: "attachment-previews-stay-visible",
        title: "Image attachments stay visible after sending",
        description:
          "Persisted image previews now load through the same reliable byte-serving path as local generated images, fixing the brief preview flash followed by broken attachment thumbnails.",
      },
      {
        id: "kilo-code-provider",
        title: "Kilo Code joins the provider lineup",
        description:
          "Synara can now launch and monitor Kilo Code sessions alongside Codex, Claude, Cursor, OpenCode, and Gemini, with health checks, settings, mentions, handoff, and model compatibility wired through the app.",
      },
      {
        id: "provider-ordering",
        title: "Provider order is now yours to arrange",
        description:
          "The settings screen now lets you drag providers into the order that fits your workflow, and the composer, sidebar, search palette, and plugin surfaces follow the same custom ordering.",
      },
      {
        id: "opencode-snapshot-cleanup",
        title: "Cleaner OpenCode and Kilo transcript updates",
        description:
          "Synthetic snapshot progress is filtered more carefully, so restored or refreshed provider output avoids repeating internal progress text while keeping real assistant activity intact.",
      },
      {
        id: "diff-header-totals",
        title: "Diff totals are easier to trust at a glance",
        description:
          "The chat header now owns unified diff totals, keeping added and removed line counts consistent between the header and diff panel as content refreshes.",
      },
    ],
  },
  {
    version: "0.0.45",
    date: "May 12",
    features: [
      {
        id: "opencode-latest-events",
        title: "OpenCode sessions understand the latest event stream",
        description:
          "Synara now tracks the newer OpenCode SDK session events, keeps titles fresher, and has much deeper coverage around OpenCode startup, output, and recovery flows.",
      },
      {
        id: "turn-recovery-stability",
        title: "Interrupted turns recover more predictably",
        description:
          "Ready and idle transitions now clear or restore turn state more carefully, reducing stuck busy states after reconnects, restarts, and partial provider streams.",
      },
      {
        id: "cursor-live-model-options",
        title: "Cursor model choices follow live ACP metadata",
        description:
          "Cursor model selection now normalizes against the provider's current ACP options instead of relying on stale context traits, so the composer better matches what Cursor can actually run.",
      },
      {
        id: "diff-and-pinned-state",
        title: "Diff and pinned-thread state stay in sync",
        description:
          "Projection, sidebar, and store updates now carry pinned-thread metadata through the app, while the diff panel handles refreshed content with fewer display glitches.",
      },
      {
        id: "quieter-git-keybinding-polish",
        title: "Small workflow polish for Git and keybindings",
        description:
          "Git summaries are clearer for rename-like moves into untracked folders, and routine keybinding reloads no longer pop a success toast every time they quietly refresh.",
      },
    ],
  },
  {
    version: "0.0.44",
    date: "May 10",
    features: [
      {
        id: "codex-generated-images",
        title: "Codex image generation now renders in chat",
        description:
          "Generated images from Codex are captured as local artifacts, rendered inline in assistant messages, and include expand and download controls without dragging bulky base64 payloads through the transcript.",
      },
      {
        id: "secure-local-image-route",
        title: "Generated images use a safer local route",
        description:
          "Synara now serves generated files through a dedicated local-image endpoint with MIME checks, workspace-aware path resolution, and Codex generated_images allowlists for both the normal home and desktop overlay home.",
      },
      {
        id: "provider-favorites",
        title: "Provider favorites are quicker to manage",
        description:
          "The provider model picker gained native favorite toggles and cleaner context-menu separators, making large Codex, Cursor, and OpenCode model lists easier to shape around the models you actually use.",
      },
      {
        id: "thread-retention-cleanup",
        title: "Old inactive threads clean up after seven days",
        description:
          "A safer retention job now removes stale inactive threads in batches, publishes maintenance progress, protects running work and approvals, and compacts SQLite when enough space can be reclaimed.",
      },
      {
        id: "websocket-and-server-polish",
        title: "Transport and server edges are steadier",
        description:
          "WebSocket HTTP URL helpers, lifecycle events, provider runtime ingestion, and chat-route plumbing were tightened so generated artifacts and cleanup events move through the app more predictably.",
      },
    ],
  },
  {
    version: "0.0.43",
    date: "May 9",
    features: [
      {
        id: "cursor-provider",
        title: "Cursor is now a first-class Synara provider",
        description:
          "Run Cursor CLI sessions directly from Synara with ACP-backed startup, model discovery, existing-chat resume, handoff, and provider health checks alongside Codex and OpenCode.",
      },
      {
        id: "effect-acp-runtime",
        title: "New Effect TS ACP runtime",
        description:
          "The new Effect TS ACP package owns generated schemas, JSON-RPC transport, client and agent helpers, terminal release handling, and protocol tests so provider integrations have a sturdier core.",
      },
      {
        id: "effect-websocket-server",
        title: "The server moved onto Effect RPC",
        description:
          "WebSocket routing, auth, readiness, settings, environment, git status, and orchestration flows were rebuilt around Effect services so reconnects and failure paths stay more predictable.",
      },
      {
        id: "cursor-streaming-polish",
        title: "Cursor output is easier to read and resume",
        description:
          "Cursor reasoning, tool progress, usage events, plan updates, composer behavior, and model-selection compatibility now render more consistently across fresh and resumed threads.",
      },
      {
        id: "sidebar-and-task-polish",
        title: "Busy sessions stay calmer",
        description:
          "Sidebar project recovery, visible-thread PR lookups, task banner resizing, stale target repair, sidechat split handling, and compact chat controls were tightened for heavier day-to-day use.",
      },
    ],
  },
  {
    version: "0.0.41",
    date: "May 2",
    features: [
      {
        id: "sidechat-threads",
        title: "Sidechat threads are easier to track",
        description:
          "Sidechat source metadata now flows through projections, filters, and snapshots so secondary threads stay easier to separate from the main conversation.",
      },
      {
        id: "desktop-startup-window",
        title: "Desktop startup feels faster",
        description:
          "Packaged desktop builds now open the app window before backend readiness finishes, reducing the blank-start feeling while services come online.",
      },
      {
        id: "git-commit-push-action",
        title: "Git gained commit and push",
        description:
          "The Git actions menu can now commit current work and push it from Synara, keeping the common release and handoff flow closer to the chat.",
      },
      {
        id: "task-and-approval-polish",
        title: "Task controls are clearer",
        description:
          "Active task controls were tightened, and approval counts are now separated from user input requests so pending work is easier to read at a glance.",
      },
    ],
  },
  {
    version: "0.0.40",
    date: "Apr 29",
    features: [
      {
        id: "visible-browser-use-webview",
        title: "Browser-use now drives the visible browser",
        description:
          "The desktop browser and browser-use tools now share the same visible webview, so automation, screenshots, navigation, and manual browsing stay in sync instead of racing separate hidden pages.",
      },
      {
        id: "browser-panel-polish",
        title: "The browser panel is steadier",
        description:
          "Browser resizing, overlay handling, tab controls, screenshot actions, and browser-use panel requests were tightened while keeping the browser from reopening by default.",
      },
      {
        id: "plan-markdown-actions",
        title: "Plans are easier to export",
        description:
          "Proposed plans now share one compact action set for copying markdown, saving into a `.plan` workspace folder, or exporting a markdown file through the desktop save dialog.",
      },
      {
        id: "split-pane-maximize",
        title: "Split panes expand predictably",
        description:
          "Expanding a chat pane now opens that selected chat as the single full-screen surface, closing the rest of the split layout.",
      },
      {
        id: "git-branch-pr-flow",
        title: "Git flows are smoother",
        description:
          "The Git menu now includes branch creation with Synara-style names, and PR creation can recover from GitHub duplicate-PR responses by reusing the existing open pull request.",
      },
      {
        id: "legacy-import-recovery",
        title: "Legacy T3 imports heal themselves",
        description:
          "A new migration reconciles older imported T3 Code databases whose migration history skipped Synara schema changes, preventing missing-column crashes after import.",
      },
      {
        id: "runtime-idle-cleanup",
        title: "Idle sessions clean up after themselves",
        description:
          "Provider runtimes and Codex discovery sessions now stop after idle periods, while active turns and pending approvals remain protected from premature shutdown.",
      },
      {
        id: "assistant-stream-stability",
        title: "Streaming output lands in the right message",
        description:
          "Assistant turn ingestion now prefers existing completed item IDs when possible, reducing placeholder duplication and keeping streamed assistant text attached to the intended message.",
      },
      {
        id: "diff-copy-and-thread-details",
        title: "Small workflow polish landed",
        description:
          "Diff views can copy the full patch directly, terminal-started chats get a clearer header icon, sidebar titles truncate more cleanly, and long transcripts cap normalized messages for lighter rendering.",
      },
    ],
  },
  {
    version: "0.0.39",
    date: "Apr 28",
    features: [
      {
        id: "split-chat-drag-drop",
        title: "Split chats are easier to arrange",
        description:
          "Split chat panes now support direct drag-and-drop, cross-project drops, and safer orphan handling so multi-chat layouts stay easier to build and recover.",
      },
      {
        id: "split-chat-routing-stability",
        title: "Split chat navigation is steadier",
        description:
          "Split chat activation, route restore, sidebar grouping, and thread subscriptions were tightened so opening and switching chats feels more predictable.",
      },
      {
        id: "opencode-task-events",
        title: "OpenCode tasks show live progress",
        description:
          "OpenCode todo events now flow into Synara as active task updates, with a compact banner option for keeping current work visible without taking over the chat.",
      },
      {
        id: "opencode-model-favourites",
        title: "OpenCode models can be favourited",
        description:
          "The model picker now supports OpenCode favourites, making preferred models quicker to find across larger provider model lists.",
      },
      {
        id: "opencode-context-usage",
        title: "OpenCode context usage is tracked",
        description:
          "OpenCode sessions now report context usage more consistently, giving Synara better runtime visibility as conversations grow.",
      },
      {
        id: "production-debug-flags",
        title: "Debug controls stay out of production",
        description:
          "Debug feature flags are now hidden behind local opt-in behavior, keeping production sidebars cleaner while preserving developer-only controls.",
      },
    ],
  },
  {
    version: "0.0.38",
    date: "Apr 26",
    features: [
      {
        id: "cursor-provider",
        title: "Cursor CLI support landed",
        description:
          "Cursor is now available as a provider, with ACP sessions, model discovery, existing chats, handoff, shortcuts, and git text generation wired into Synara.",
      },
      {
        id: "chatgpt-voice-transcription",
        title: "Voice transcription is scoped more carefully",
        description:
          "Voice transcription now stays on ChatGPT sessions, avoiding confusing provider mismatches while keeping dictation available where it is supported.",
      },
      {
        id: "api-key-voice-transcription",
        title: "Voice transcription setup is smoother",
        description:
          "Voice transcription setup was tightened so spoken prompts can flow into the composer more reliably in supported ChatGPT sessions.",
      },
      {
        id: "composer-mention-labels",
        title: "Mentions keep their names",
        description:
          "Composer replacements now preserve mention labels, so referenced files, apps, and tools remain readable after the prompt text is normalized.",
      },
      {
        id: "plugin-mentions",
        title: "Plugin mentions are handled in prompts",
        description:
          "Plugin references can now flow through composer prompts cleanly, making connected-tool context less brittle when you hand work to an agent.",
      },
      {
        id: "toast-feature-flags",
        title: "Toast behavior can be feature-flagged",
        description:
          "Toast notifications picked up feature-flag wiring, giving Synara a safer way to roll notification changes forward or back.",
      },
      {
        id: "desktop-bridge-reconnects",
        title: "Desktop reconnects are steadier",
        description:
          "The desktop bridge now refreshes reconnects more reliably and preserves the workspace home directory, reducing drift after desktop runtime restarts.",
      },
    ],
  },
  {
    version: "0.0.37",
    date: "Apr 25",
    features: [
      {
        id: "branch-switch-recovery",
        title: "Branch switching is much safer",
        description:
          "Synara now handles messy branch switches with clearer recovery actions, recreated stashes, unpublished branch publishing, and stronger checks around conflicts and local work.",
      },
      {
        id: "plan-mode-proposals",
        title: "Plan mode proposals show up properly",
        description:
          "Proposed plans from providers are now parsed and surfaced as first-class UI state, so planning turns feel more predictable instead of blending into ordinary assistant output.",
      },
      {
        id: "desktop-navigation-controls",
        title: "Desktop navigation controls landed",
        description:
          "The desktop app now has app-level back and forward navigation controls, making it easier to move around Synara without losing your place.",
      },
      {
        id: "sidebar-sort-stability",
        title: "Sidebar ordering stays put",
        description:
          "Stored sidebar sort preferences are preserved on load, fixing cases where project and thread ordering could unexpectedly reset.",
      },
      {
        id: "font-consistency",
        title: "Fonts are more consistent",
        description:
          "Theme and chat font handling now share one normalization path, tightening up typography across the chat UI, model controls, and theme settings.",
      },
    ],
  },
  {
    version: "0.0.36",
    date: "Apr 24",
    features: [
      {
        id: "gpt-5-5-available",
        title: "GPT-5.5 is available",
        description:
          "GPT-5.5 is now in the model picker with the right default reasoning behavior, so you can move new Codex sessions onto the latest model directly from Synara.",
      },
      {
        id: "opencode-provider",
        title: "OpenCode support is here",
        description:
          "OpenCode is now available as a provider, with runtime model discovery, session handling, provider settings, model search, variants, agents, and git text generation wired into the app.",
      },
      {
        id: "model-picker-search-polish",
        title: "Model search feels faster",
        description:
          "Large OpenCode model lists now get provider-aware search, clearer labels, automatic search focus, arrow-key navigation, and tighter picker clipping.",
      },
      {
        id: "turn-start-diffs",
        title: "Diffs now start from the turn",
        description:
          "Turn diffs use turn-start checkpoints, making changed-file views line up more closely with what the agent actually changed in the current turn.",
      },
      {
        id: "chat-markdown-math",
        title: "Chat markdown is smarter",
        description:
          "Math rendering was added to chat markdown, while literal dollar amounts stay intact so normal prices and currency snippets do not get misread as formulas.",
      },
      {
        id: "theme-and-release-polish",
        title: "More polish around search and releases",
        description:
          "Sidebar theme search, release verification, Windows signing config, and a handful of provider/model edge cases were tightened up for a smoother build and update path.",
      },
    ],
  },
  {
    version: "0.0.35",
    date: "Apr 22",
    features: [
      {
        id: "project-import-path-browsing",
        title: "🗂️ Project import browsing got smarter",
        description:
          "The import palette can now browse nearby paths more directly, helping you find and open the right project location with less guesswork.",
      },
      {
        id: "provider-usage-in-branch-toolbar",
        title: "📊 Provider usage is visible in-context",
        description:
          "The branch toolbar now surfaces provider usage snapshots, making it easier to keep an eye on current usage without leaving your working view.",
      },
      {
        id: "desktop-boot-splash-screen",
        title: "🚀 Desktop startup feels clearer",
        description:
          "Synara now shows a proper splash screen while the desktop backend spins up, so launch feels intentional instead of looking briefly stalled.",
      },
      {
        id: "provider-capability-and-theme-polish",
        title: "🎛️ Better provider and theme polish",
        description:
          "Model capability handling, theme editing, and related picker behavior were tightened up so settings feel more consistent and trustworthy.",
      },
      {
        id: "desktop-release-reliability",
        title: "🛠️ Desktop release plumbing is sturdier",
        description:
          "Startup readiness checks, desktop packaging config, and platform entitlements were refined to make desktop builds and app boot more reliable.",
      },
    ],
  },
  {
    version: "0.0.34",
    date: "Apr 21",
    features: [
      {
        id: "theme-pack-editor",
        title: "🎨 Theme packs are editable",
        description:
          "The new theme pack editor lets you tune UI colors directly in Synara, with shared theme tokens keeping the sidebar, composer, transcript, and controls in sync.",
      },
      {
        id: "sidebar-notifications",
        title: "🔔 Sidebar notifications are easier to read",
        description:
          "Thread activity now surfaces more clearly in the sidebar, so updates, background work, and attention states are easier to spot without opening every conversation.",
      },
      {
        id: "steadier-transcript-performance",
        title: "🧵 Steadier transcripts under load",
        description:
          "Transcript rendering and sidebar-owned state were separated more cleanly, reducing unnecessary churn while long conversations and live agent output are moving.",
      },
      {
        id: "runtime-mode-recovery",
        title: "🛡️ Safer runtime-mode recovery",
        description:
          "Codex runtime permissions now propagate more reliably across resumed sessions and provider restarts, keeping the app closer to the mode you actually selected.",
      },
      {
        id: "composer-and-picker-polish",
        title: "✨ Cleaner composer and picker styling",
        description:
          "Composer chrome, picker hover states, runtime controls, and changed-file rows picked up a more consistent visual pass across light and dark themes.",
      },
    ],
  },
  {
    version: "0.0.33",
    date: "Apr 20",
    features: [
      {
        id: "local-folder-browsing-in-composer",
        title: "📂 Browse local folders right from the composer",
        description:
          "Folder mentions now open a real local directory picker, so you can drill into nearby files and attach the right path without leaving the chat flow.",
      },
      {
        id: "cleaner-file-and-folder-mentions",
        title: "🗂️ Cleaner file and folder mentions",
        description:
          "Mention chips, file trees, and changed-file rows now use a lighter shared icon system that keeps paths easier to scan across the app.",
      },
      {
        id: "desktop-browser-and-runtime-upgrades",
        title: "🌐 Stronger desktop browser runtime",
        description:
          "The desktop browser path picked up better IPC plumbing, screenshots, clipboard support, and more efficient state syncing for browser-driven tasks.",
      },
      {
        id: "safer-startup-and-provider-recovery",
        title: "🛟 Smoother startup and provider recovery",
        description:
          "Project hydration, desktop startup, auth visibility, and aborted-turn cleanup were tightened up so sessions recover more predictably after interruptions.",
      },
    ],
  },
  {
    version: "0.0.32",
    date: "Apr 19",
    features: [
      {
        id: "steering-conversation-label",
        title: "↪︎ Steering messages are clearly marked",
        description:
          "Messages sent with steering now keep a lightweight 'Steering conversation' label above the bubble, even after the app reconciles with the server.",
      },
      {
        id: "calmer-foreground-update-checks",
        title: "🚦 Less aggressive background return checks",
        description:
          "Desktop update checks now wait for a real background return instead of reacting to every tiny blur/focus bounce.",
      },
      {
        id: "update-check-timeout-recovery",
        title: "🛟 No more stuck checking state",
        description:
          "If the updater never answers, Synara now times out and recovers instead of hanging on a permanent Checking status.",
      },
    ],
  },
  {
    version: "0.0.31",
    date: "Apr 19",
    features: [
      {
        id: "gemini-provider-support",
        title: "♊ Gemini support is here",
        description:
          "Use Gemini alongside Codex and Claude Agent, with provider-aware models and handoff support built into the app.",
      },
      {
        id: "custom-provider-binaries",
        title: "🛠️ Custom binary paths for every provider",
        description:
          "Point Synara at your own Codex, Claude, or Gemini binary when your setup lives outside the default install path.",
      },
      {
        id: "assistant-selections-as-context",
        title: "📎 Reuse assistant replies as attachments",
        description:
          "Select parts of an assistant response and send them back as structured context in your next prompt.",
      },
      {
        id: "stronger-thread-continuity",
        title: "🧵 Better thread continuity",
        description:
          "The app now remembers your last open thread, carries pull request context into draft threads, and keeps sidebar state more stable.",
      },
      {
        id: "stability-and-update-polish",
        title: "🩹 Smoother recovery and update checks",
        description:
          "Project creation recovery, foreground update checks, and a few rough edges around long messages and download state have been tightened up.",
      },
    ],
  },
  {
    version: "0.0.30",
    date: "Apr 18",
    features: [
      {
        id: "chats-are-now-available",
        title: "💬 Chats are now available!",
        description: "Write without a selected project, or create threads from there.",
      },
      {
        id: "new-shortcuts",
        title: "⌨️ New shortcuts",
        description:
          "Quickly open a new chat or jump to your latest project thread with dedicated shortcuts.",
      },
      {
        id: "claude-1m-context",
        title: "🧠 Claude 1M context support",
        description:
          "Take full advantage of Claude's 1M-token context window for long conversations and large codebases.",
      },
      {
        id: "bulk-thread-actions",
        title: "📁 Bulk thread actions",
        description: "Select multiple threads at once and act on them together.",
      },
      {
        id: "cleaner-reasoning-picker",
        title: "✨ Cleaner reasoning picker order",
        description:
          "The reasoning picker has been reordered to make the most common choices quicker to reach.",
      },
      {
        id: "polished-ui-ux",
        title: "💻 New polished UI/UX",
        description: "A round of visual and interaction polish across the app.",
      },
    ],
  },
  {
    version: "0.0.29",
    date: "Apr 18",
    features: [
      {
        id: "whats-new-dialog",
        title: "🆕 What's new, inline",
        description:
          "Every update now opens a one-time dialog highlighting the latest changes, so you don't have to hunt through a changelog to know what shipped.",
        details:
          "The dialog only shows up once per release — dismiss it and it stays out of your way until the next version.",
      },
      {
        id: "release-history-settings",
        title: "📚 Release history in Settings",
        description:
          "A full changelog lives under Settings → Release history, grouped by version in a collapsible accordion.",
        details:
          "Revisit any past release at any time. The same notes as the post-update dialog, nothing to hunt for.",
      },
    ],
  },
];
