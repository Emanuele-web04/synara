// FILE: settingsNavigation.ts
// Purpose: Share the settings topic taxonomy between the main sidebar and the settings screen.
// Layer: Route/UI support
// Exports: section ids, nav items, and search normalization helper

export const SETTINGS_SECTION_IDS = [
  "general",
  "appearance",
  "notifications",
  "behavior",
  "worktrees",
  "archived",
  "models",
  "providers",
  "advanced",
] as const;

export type SettingsSectionId = (typeof SETTINGS_SECTION_IDS)[number];
export type SettingsNavGroupId = "app" | "synara";

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
    icon: "plugin-1",
    eyebrow: "Picker visibility",
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

export function normalizeSettingsSection(value: unknown): SettingsSectionId {
  if (typeof value !== "string") {
    return "general";
  }
  return SETTINGS_SECTION_IDS.find((candidate) => candidate === value) ?? "general";
}
