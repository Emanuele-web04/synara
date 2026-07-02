// FILE: settingsNavigation.ts
// Purpose: Share the settings topic taxonomy between the main sidebar and the settings screen.
// Layer: Route/UI support
// Exports: section ids, nav items, and search normalization helper

export const SETTINGS_SECTION_IDS = [
  "general",
  "profile",
  "appearance",
  "notifications",
  "behavior",
  "shortcuts",
  "worktrees",
  "archived",
  "models",
  "providers",
  "skills",
  "usage",
  "advanced",
] as const;

export type SettingsSectionId = (typeof SETTINGS_SECTION_IDS)[number];
export type SettingsNavGroupId = "app" | "synara";

/**
 * Deep-link scroll targets inside a settings panel. Each id is shared by the element that owns
 * it (its `id` + scroll ref), the panel effect that scrolls it into view, and any caller that
 * navigates to it via `?target=…`. Centralizing them keeps the anchor and its links from
 * silently drifting apart.
 */
export const SETTINGS_TARGETS = {
  providerUpdates: "provider-updates",
  providerInstalls: "provider-installs",
  environmentPanel: "environment-panel",
} as const;

export type SettingsTargetId = (typeof SETTINGS_TARGETS)[keyof typeof SETTINGS_TARGETS];

export type SettingsNavItem = {
  id: SettingsSectionId;
  group: SettingsNavGroupId;
  label: string;
  description: string;
  /** Basename of a SVG under `/central-icons-reversed`. */
  icon: string;
  eyebrow: string;
};

export const SETTINGS_NAV_GROUPS: ReadonlyArray<{
  id: SettingsNavGroupId;
  label: string;
}> = [
  { id: "app", label: "App" },
  { id: "synara", label: "Synara" },
] as const;

export const SETTINGS_NAV_ITEMS: readonly SettingsNavItem[] = [
  {
    id: "general",
    group: "app",
    label: "General",
    description: "Default provider, thread mode, and sidebar organization.",
    icon: "settings-gear-1",
    eyebrow: "Workflow defaults",
  },
  {
    id: "profile",
    group: "app",
    label: "Profile",
    description: "Your local activity, streaks, and a shareable stats card.",
    icon: "user",
    eyebrow: "Your stats",
  },
  {
    id: "appearance",
    group: "app",
    label: "Appearance",
    description: "Theme, typography, and timestamp formatting.",
    icon: "color-palette",
    eyebrow: "Visual language",
  },
  {
    id: "notifications",
    group: "app",
    label: "Notifications",
    description: "In-app toasts and desktop alerts.",
    icon: "bell",
    eyebrow: "Alerts",
  },
  {
    id: "behavior",
    group: "app",
    label: "Behavior",
    description: "Streaming, diff handling, and destructive confirmations.",
    icon: "settings-slider-hor",
    eyebrow: "Interaction rules",
  },
  {
    id: "shortcuts",
    group: "app",
    label: "Keyboard Shortcuts",
    description: "Every keyboard shortcut available in Synara, grouped by context.",
    icon: "shortcut",
    eyebrow: "Key bindings",
  },
  {
    id: "worktrees",
    group: "app",
    label: "Worktrees",
    description: "Review and clean up the worktrees created by Synara.",
    icon: "branch-simple",
    eyebrow: "Workspace management",
  },
  {
    id: "archived",
    group: "app",
    label: "Archived",
    description: "View and restore archived threads.",
    icon: "archive",
    eyebrow: "Thread management",
  },
  {
    id: "models",
    group: "synara",
    label: "Models",
    description: "Git writing defaults and custom model slugs.",
    icon: "brain",
    eyebrow: "AI configuration",
  },
  {
    id: "providers",
    group: "synara",
    label: "Providers",
    description: "Choose visible providers, review CLI installs, and update provider tools.",
    icon: "puzzle",
    eyebrow: "Picker visibility",
  },
  {
    id: "skills",
    group: "synara",
    label: "Skills",
    description: "Every skill found across providers, with toggles to control availability.",
    icon: "building-blocks",
    eyebrow: "Agent skills",
  },
  {
    id: "usage",
    group: "synara",
    label: "Usage",
    description: "Remaining quota and credits for each signed-in provider.",
    icon: "gauge",
    eyebrow: "Limits & credits",
  },
  {
    id: "advanced",
    group: "synara",
    label: "Advanced",
    description: "Keybindings, recovery, and version info.",
    icon: "toolbox",
    eyebrow: "System tools",
  },
] as const;

/**
 * Stable DOM id for a settings row, derived from its (string) title. Shared by the row that
 * renders the anchor and by the search index that deep-links to it via `?target=…`, so the
 * two can't drift. Panels mount one section at a time, so the slug only needs to be unique
 * within a section.
 */
export function settingRowAnchorId(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `setting-${slug}`;
}

export function normalizeSettingsSection(value: unknown): SettingsSectionId {
  if (typeof value !== "string") {
    return "general";
  }
  return SETTINGS_SECTION_IDS.find((candidate) => candidate === value) ?? "general";
}
