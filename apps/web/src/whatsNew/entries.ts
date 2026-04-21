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
