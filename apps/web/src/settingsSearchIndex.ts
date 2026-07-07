// FILE: settingsSearchIndex.ts
// Purpose: Declarative, searchable index of settings rows/sections so the sidebar can
//          surface matches by title/description the same way the editor file search does.
// Layer: Route/UI support
// Exports: entry type, the index, section label lookup, and the ranking helper

import { rankProviderDiscoveryItems } from "~/lib/providerDiscovery";
import {
  settingRowAnchorId,
  SETTINGS_NAV_ITEMS,
  type SettingsSectionId,
} from "./settingsNavigation";

/**
 * One searchable settings result. `title` usually matches a string SettingsRow heading so
 * the default anchor can be derived; `target: null` marks panel-only or conditional rows.
 */
export interface SettingsSearchEntry {
  id: string;
  section: SettingsSectionId;
  title: string;
  titleKey: string;
  keywords: string;
  target?: string | null;
}

/** DOM id a result deep-links to, or null for panel-level entries with no anchored row. */
export function settingsSearchEntryTarget(entry: SettingsSearchEntry): string | null {
  // Use entry.id to generate stable anchor that works across locales.
  // entry.target === null means panel-level entry with no anchored row.
  // entry.target === undefined means use default anchor derivation.
  if (entry.target === null) return null;
  if (entry.target !== undefined) return entry.target;
  // Convert entry.id (e.g., "general:default-provider") to anchor id (e.g., "setting-default-provider")
  return `setting-${entry.id.replace(/:/g, "-")}`;
}

// Mirrors row titles/descriptions rendered in settings panels. Panels only mount the active
// section, so the sidebar cannot read row text at runtime; keep this list in sync when rows
// are added, renamed, hidden conditionally, or represented as panel-level results.
export const SETTINGS_SEARCH_ENTRIES: readonly SettingsSearchEntry[] = [
  // ── General ────────────────────────────────────────────────────────────────
  {
    id: "general:default-provider",
    section: "general",
    title: "Default provider",
    titleKey: "settings.general.defaultProvider",
    keywords: "Choose the provider used for new chats. agent codex claude",
  },
  {
    id: "general:new-threads",
    section: "general",
    title: "New threads",
    titleKey: "settings.general.newThreads",
    keywords:
      "Pick the default workspace mode for newly created draft threads. local worktree environment",
  },
  {
    id: "general:project-order",
    section: "general",
    title: "Project order",
    titleKey: "settings.general.projectOrder",
    keywords: "Controls how projects are arranged in the main sidebar. sort updated created manual",
  },
  {
    id: "general:thread-order",
    section: "general",
    title: "Thread order",
    titleKey: "settings.general.threadOrder",
    keywords:
      "Controls how threads are arranged inside each project in the main sidebar. sort updated created",
  },
  {
    id: "general:chats-section",
    section: "general",
    title: "Chats",
    titleKey: "settings.general.chats",
    keywords:
      "Show the standalone Chats list in the sidebar footer chats not tied to a project. sidebar section",
  },
  {
    id: "general:workspace-section",
    section: "general",
    title: "Workspace",
    titleKey: "settings.general.workspace",
    keywords:
      "Show the Workspace tab in the sidebar switcher. The Threads tab always stays visible. sidebar section",
  },
  {
    id: "general:environment-usage",
    section: "general",
    title: "Usage",
    titleKey: "settings.general.usage",
    keywords: "Show the provider usage row in the chat Environment panel.",
  },
  {
    id: "general:environment-repository",
    section: "general",
    title: "Repository",
    titleKey: "settings.general.repository",
    keywords: "Show the GitHub repository link in the chat Environment panel. git changes worktree",
  },
  {
    id: "general:environment-pull-request",
    section: "general",
    title: "Pull request",
    titleKey: "settings.general.environmentPullRequest",
    keywords:
      "Show the open pull request CI checks and review comments in the chat Environment panel. pr fix github",
  },
  {
    id: "general:environment-editor",
    section: "general",
    title: "Editor",
    titleKey: "settings.general.editor",
    keywords:
      "Show the Editor section in-app editor view and Open in editor picker in the chat Environment panel.",
  },
  {
    id: "general:environment-recap",
    section: "general",
    title: "Recap",
    titleKey: "settings.general.recap",
    keywords: "Show the auto-generated chat recap in the Environment panel.",
  },
  {
    id: "general:environment-pinned",
    section: "general",
    title: "Pinned messages",
    titleKey: "settings.general.pinnedMessages",
    keywords: "Show the pinned-messages checklist in the Environment panel.",
  },
  {
    id: "general:environment-markers",
    section: "general",
    title: "Text markers",
    titleKey: "settings.general.textMarkers",
    keywords: "Show highlighted and underlined transcript text in the Environment panel.",
  },
  {
    id: "general:environment-notepad",
    section: "general",
    title: "Notepad",
    titleKey: "settings.general.notepad",
    keywords: "Show the per-thread notepad in the Environment panel.",
  },

  // ── Appearance ───────────────────────────────────────────────────────────────
  {
    id: "appearance:theme",
    section: "appearance",
    title: "Theme",
    titleKey: "settings.appearance.theme",
    keywords: "Choose how Synara looks across the app. dark light system color",
  },
  {
    id: "appearance:ui-density",
    section: "appearance",
    title: "UI density",
    titleKey: "settings.appearance.uiDensity",
    keywords:
      "Control spacing in the sidebar, composer, chat gutters, and settings rows without changing font size. compact comfortable",
  },
  {
    id: "appearance:base-font-size",
    section: "appearance",
    title: "Base font size",
    titleKey: "settings.appearance.baseFontSize",
    keywords:
      "Adjust the app text base in pixels. Chat and UI typography scale proportionally. font",
  },
  {
    id: "appearance:terminal-font-size",
    section: "appearance",
    title: "Terminal font size",
    titleKey: "settings.appearance.terminalFontSize",
    keywords: "Adjust terminal text independently from the app and chat font size.",
  },
  {
    id: "appearance:terminal-font",
    section: "appearance",
    title: "Terminal font",
    titleKey: "settings.appearance.terminalFont",
    keywords:
      "Type any monospace font installed on this device e.g. Fira Code. system monospace family",
  },
  {
    id: "appearance:font-smoothing",
    section: "appearance",
    title: "Font smoothing",
    titleKey: "settings.appearance.fontSmoothing",
    keywords: "Use macOS-style antialiasing for lighter, crisper text rendering.",
    target: null,
  },
  {
    id: "appearance:time-format",
    section: "appearance",
    title: "Time format",
    titleKey: "settings.appearance.timeFormat",
    keywords:
      "System default follows your browser or OS clock preference. timestamp 12-hour 24-hour locale",
  },

  // ── Notifications ─────────────────────────────────────────────────────────────
  {
    id: "notifications:activity-toasts",
    section: "notifications",
    title: "Activity toasts",
    titleKey: "settings.notifications.activityToasts",
    keywords:
      "Show an in-app toast when a chat or managed terminal agent finishes or needs input. alerts",
  },
  {
    id: "notifications:desktop-notifications",
    section: "notifications",
    title: "Desktop notifications",
    titleKey: "settings.notifications.desktopNotifications",
    keywords:
      "Show an OS notification when a chat or managed terminal agent finishes or needs input while the app is in the background. alerts toast",
  },

  // ── Behavior ──────────────────────────────────────────────────────────────────
  {
    id: "behavior:assistant-output",
    section: "behavior",
    title: "Assistant output",
    titleKey: "settings.behavior.assistantOutput",
    keywords: "Show token-by-token output while a response is in progress. streaming",
  },
  {
    id: "behavior:diff-line-wrapping",
    section: "behavior",
    title: "Diff line wrapping",
    titleKey: "settings.behavior.diffLineWrapping",
    keywords: "Set the default wrap state when the diff panel opens. word wrap",
  },
  {
    id: "behavior:delete-confirmation",
    section: "behavior",
    title: "Delete confirmation",
    titleKey: "settings.behavior.deleteConfirmation",
    keywords: "Ask before deleting a thread and its chat history. safety confirm",
  },
  {
    id: "behavior:archive-confirmation",
    section: "behavior",
    title: "Archive confirmation",
    titleKey: "settings.behavior.archiveConfirmation",
    keywords: "Ask before archiving a thread. safety confirm",
  },
  {
    id: "behavior:terminal-close-confirmation",
    section: "behavior",
    title: "Terminal close confirmation",
    titleKey: "settings.behavior.terminalCloseConfirmation",
    keywords: "Ask before closing a terminal tab and clearing its history. safety confirm",
  },

  // ── Keyboard Shortcuts ────────────────────────────────────────────────────────
  {
    id: "shortcuts:keyboard-shortcuts",
    section: "shortcuts",
    title: "Keyboard Shortcuts",
    titleKey: "settings.nav.shortcuts",
    keywords:
      "Every keyboard shortcut available in Synara, grouped by context. keybindings hotkeys key combo cmd ctrl reference",
    target: null,
  },

  // ── Worktrees ─────────────────────────────────────────────────────────────────
  {
    id: "worktrees:managed-worktrees",
    section: "worktrees",
    title: "Managed worktrees",
    titleKey: "settings.worktrees.worktree",
    keywords: "Review and clean up the worktrees created by Synara. git branch remove",
    target: null,
  },

  // ── Archived ──────────────────────────────────────────────────────────────────
  {
    id: "archived:archived-threads",
    section: "archived",
    title: "Archived threads",
    titleKey: "settings.archived.archivedThreadsHere",
    keywords: "View and restore archived threads. unarchive history",
    target: null,
  },

  // ── Models ────────────────────────────────────────────────────────────────────
  {
    id: "models:git-writing-model",
    section: "models",
    title: "Git writing model",
    titleKey: "settings.models.gitWritingModel",
    keywords: "Used for generated commit messages, PR titles, and branch names.",
  },
  {
    id: "models:saved-model-slugs",
    section: "models",
    title: "Saved model slugs",
    titleKey: "settings.models.savedModelSlugs",
    keywords: "Add custom model slugs for supported providers. custom model",
  },

  // ── Providers ─────────────────────────────────────────────────────────────────
  {
    id: "providers:automatic-cli-update-checks",
    section: "providers",
    title: "Automatic CLI update checks",
    titleKey: "settings.providerUpdates.automaticCliUpdateChecks",
    keywords:
      "Check Codex Claude and other provider CLIs for newer versions in the background. updates upgrade disable nags",
  },
  {
    id: "providers:visible-providers",
    section: "providers",
    title: "Visible providers",
    titleKey: "settings.providers.visibleProviders",
    keywords:
      "Drag providers into your preferred picker order and hide the ones you don't use. visibility order",
  },
  {
    id: "providers:provider-updates",
    section: "providers",
    title: "Provider updates",
    titleKey: "settings.providerUpdates.providerUpdates",
    keywords: "Update installed provider tools that Synara can safely update. upgrade cli",
  },
  {
    id: "providers:installed-clis",
    section: "providers",
    title: "Installed CLIs",
    titleKey: "settings.providers.installedClis",
    keywords: "Review provider versions and update tools. binary overrides path install",
  },

  // ── Skills ────────────────────────────────────────────────────────────────────
  {
    id: "skills:skills",
    section: "skills",
    title: "Skills",
    titleKey: "settings.nav.skills",
    keywords: "Every skill found across providers, with toggles to control availability. agent",
    target: null,
  },

  // ── Usage ─────────────────────────────────────────────────────────────────────
  {
    id: "usage:usage",
    section: "usage",
    title: "Usage and billing",
    titleKey: "settings.providerUsage.sectionTitle",
    keywords: "Remaining quota and credits for each signed-in provider. limits credits",
    target: null,
  },

  // ── Advanced ──────────────────────────────────────────────────────────────────
  {
    id: "advanced:keybindings",
    section: "advanced",
    title: "Keybindings",
    titleKey: "settings.advanced.keybindings",
    keywords:
      "Open the persisted keybindings.json file to edit advanced bindings directly. shortcuts",
  },
  {
    id: "advanced:recovery-tools",
    section: "advanced",
    title: "Recovery tools",
    titleKey: "settings.advanced.recoveryTools",
    keywords:
      "Rebuild local project indexes without clearing existing chats when the local state gets out of sync.",
  },
  {
    id: "advanced:version",
    section: "advanced",
    title: "Version",
    titleKey: "settings.advanced.version",
    keywords: "Current application version. about",
  },
  {
    id: "advanced:release-history",
    section: "advanced",
    title: "Release history",
    titleKey: "settings.advanced.releaseHistory",
    keywords:
      "A running log of every update, newest first. changelog what's new about release notes",
  },
] as const;

const SETTINGS_SECTION_LABEL_KEY_BY_ID = new Map<SettingsSectionId, string>(
  SETTINGS_NAV_ITEMS.map((item) => [item.id, item.labelKey]),
);

/** Returns the i18n translation key for a section label (for display). */
export function settingsSectionLabelKey(section: SettingsSectionId): string {
  return SETTINGS_SECTION_LABEL_KEY_BY_ID.get(section) ?? section;
}

/** Returns the English fallback label (for search indexing). */
export function settingsSectionLabel(section: SettingsSectionId): string {
  const item = SETTINGS_NAV_ITEMS.find((i) => i.id === section);
  return item?.label ?? section;
}

/**
 * Fuzzy-rank settings rows for the sidebar search. Title carries the strongest intent;
 * the description/synonym keywords and the owning section label match more loosely so a
 * query like "appearance" or "wrap" still surfaces the right rows.
 */
export function rankSettingsSearchEntries(
  query: string,
  limit: number,
): readonly SettingsSearchEntry[] {
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    return [];
  }
  const ranked = rankProviderDiscoveryItems(SETTINGS_SEARCH_ENTRIES, trimmed, (entry) => [
    { value: entry.title },
    { value: entry.keywords, weight: 200 },
    { value: settingsSectionLabel(entry.section), weight: 400 },
  ]);
  return ranked.slice(0, limit);
}
