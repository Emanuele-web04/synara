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
        title: "Split panes maximize in place",
        description:
          "Maximizing a chat pane now removes only the focused pane and keeps the remaining split layout intact when possible, making it easier to focus without throwing away the whole arrangement.",
      },
      {
        id: "git-branch-pr-flow",
        title: "Git flows are smoother",
        description:
          "The Git menu now includes branch creation with DP Code-style names, and PR creation can recover from GitHub duplicate-PR responses by reusing the existing open pull request.",
      },
      {
        id: "legacy-import-recovery",
        title: "Legacy T3 imports heal themselves",
        description:
          "A new migration reconciles older imported T3 Code databases whose migration history skipped DP Code schema changes, preventing missing-column crashes after import.",
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
          "OpenCode todo events now flow into DP Code as active task updates, with a compact banner option for keeping current work visible without taking over the chat.",
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
          "OpenCode sessions now report context usage more consistently, giving DP Code better runtime visibility as conversations grow.",
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
          "Toast notifications picked up feature-flag wiring, giving DP Code a safer way to roll notification changes forward or back.",
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
          "DP Code now handles messy branch switches with clearer recovery actions, recreated stashes, unpublished branch publishing, and stronger checks around conflicts and local work.",
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
          "The desktop app now has app-level back and forward navigation controls, making it easier to move around DP Code without losing your place.",
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
          "GPT-5.5 is now in the model picker with the right default reasoning behavior, so you can move new Codex sessions onto the latest model directly from DP Code.",
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
          "DP Code now shows a proper splash screen while the desktop backend spins up, so launch feels intentional instead of looking briefly stalled.",
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
          "The new theme pack editor lets you tune UI colors directly in DP Code, with shared theme tokens keeping the sidebar, composer, transcript, and controls in sync.",
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
          "If the updater never answers, DP Code now times out and recovers instead of hanging on a permanent Checking status.",
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
          "Point DP Code at your own Codex, Claude, or Gemini binary when your setup lives outside the default install path.",
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
