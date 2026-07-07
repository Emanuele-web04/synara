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
  labelKey: string;
  description: string;
  descriptionKey: string;
  /** Basename of a SVG under `/central-icons-reversed`. */
  icon: string;
  eyebrow: string;
  eyebrowKey: string;
};

export const SETTINGS_NAV_GROUPS: ReadonlyArray<{
  id: SettingsNavGroupId;
  label: string;
  labelKey: string;
}> = [
  { id: "app", label: "App", labelKey: "settings.nav.app" },
  { id: "synara", label: "Synara", labelKey: "settings.nav.synara" },
] as const;

export const SETTINGS_NAV_ITEMS: readonly SettingsNavItem[] = [
  {
    id: "general",
    group: "app",
    label: "General",
    labelKey: "settings.nav.general",
    description: "Default provider, thread mode, and sidebar organization.",
    descriptionKey: "settings.nav.generalDescription",
    icon: "settings-gear-1",
    eyebrow: "Workflow defaults",
    eyebrowKey: "settings.nav.generalEyebrow",
  },
  {
    id: "profile",
    group: "app",
    label: "Profile",
    labelKey: "settings.nav.profile",
    description: "Your local activity, streaks, and a shareable stats card.",
    descriptionKey: "settings.nav.profileDescription",
    icon: "user",
    eyebrow: "Your stats",
    eyebrowKey: "settings.nav.profileEyebrow",
  },
  {
    id: "appearance",
    group: "app",
    label: "Appearance",
    labelKey: "settings.nav.appearance",
    description: "Theme, typography, and timestamp formatting.",
    descriptionKey: "settings.nav.appearanceDescription",
    icon: "color-palette",
    eyebrow: "Visual language",
    eyebrowKey: "settings.nav.appearanceEyebrow",
  },
  {
    id: "notifications",
    group: "app",
    label: "Notifications",
    labelKey: "settings.nav.notifications",
    description: "In-app toasts and desktop alerts.",
    descriptionKey: "settings.nav.notificationsDescription",
    icon: "bell",
    eyebrow: "Alerts",
    eyebrowKey: "settings.nav.notificationsEyebrow",
  },
  {
    id: "behavior",
    group: "app",
    label: "Behavior",
    labelKey: "settings.nav.behavior",
    description: "Streaming, diff handling, and destructive confirmations.",
    descriptionKey: "settings.nav.behaviorDescription",
    icon: "settings-slider-hor",
    eyebrow: "Interaction rules",
    eyebrowKey: "settings.nav.behaviorEyebrow",
  },
  {
    id: "shortcuts",
    group: "app",
    label: "Keyboard Shortcuts",
    labelKey: "settings.nav.shortcuts",
    description: "Every keyboard shortcut available in Synara, grouped by context.",
    descriptionKey: "settings.nav.shortcutsDescription",
    icon: "shortcut",
    eyebrow: "Key bindings",
    eyebrowKey: "settings.nav.shortcutsEyebrow",
  },
  {
    id: "worktrees",
    group: "app",
    label: "Worktrees",
    labelKey: "settings.nav.worktrees",
    description: "Review and clean up the worktrees created by Synara.",
    descriptionKey: "settings.nav.worktreesDescription",
    icon: "branch-simple",
    eyebrow: "Workspace management",
    eyebrowKey: "settings.nav.worktreesEyebrow",
  },
  {
    id: "archived",
    group: "app",
    label: "Archived",
    labelKey: "settings.nav.archived",
    description: "View and restore archived threads.",
    descriptionKey: "settings.nav.archivedDescription",
    icon: "archive",
    eyebrow: "Thread management",
    eyebrowKey: "settings.nav.archivedEyebrow",
  },
  {
    id: "models",
    group: "synara",
    label: "Models",
    labelKey: "settings.nav.models",
    description: "Git writing defaults and custom model slugs.",
    descriptionKey: "settings.nav.modelsDescription",
    icon: "brain",
    eyebrow: "AI configuration",
    eyebrowKey: "settings.nav.modelsEyebrow",
  },
  {
    id: "providers",
    group: "synara",
    label: "Providers",
    labelKey: "settings.nav.providers",
    description: "Choose visible providers, review CLI installs, and update provider tools.",
    descriptionKey: "settings.nav.providersDescription",
    icon: "puzzle",
    eyebrow: "Picker visibility",
    eyebrowKey: "settings.nav.providersEyebrow",
  },
  {
    id: "skills",
    group: "synara",
    label: "Skills",
    labelKey: "settings.nav.skills",
    description: "Every skill found across providers, with toggles to control availability.",
    descriptionKey: "settings.nav.skillsDescription",
    icon: "building-blocks",
    eyebrow: "Agent skills",
    eyebrowKey: "settings.nav.skillsEyebrow",
  },
  {
    id: "usage",
    group: "synara",
    label: "Usage",
    labelKey: "settings.nav.usage",
    description: "Remaining quota and credits for each signed-in provider.",
    descriptionKey: "settings.nav.usageDescription",
    icon: "gauge",
    eyebrow: "Limits & credits",
    eyebrowKey: "settings.nav.usageEyebrow",
  },
  {
    id: "advanced",
    group: "synara",
    label: "Advanced",
    labelKey: "settings.nav.advanced",
    description: "Keybindings, recovery, and version info.",
    descriptionKey: "settings.nav.advancedDescription",
    icon: "toolbox",
    eyebrow: "System tools",
    eyebrowKey: "settings.nav.advancedEyebrow",
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
