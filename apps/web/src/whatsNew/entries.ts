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
