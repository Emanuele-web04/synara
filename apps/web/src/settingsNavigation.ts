export const SETTINGS_SECTION_IDS = [
  "general",
  "profile",
  "appearance",
  "notifications",
  "behavior",
  "appsnap",
  "shortcuts",
  "worktrees",
  "archived",
  "models",
  "providers",
  "skills",
  "usage",
  "integrations",
  "advanced",
] as const;

export type SettingsSectionId = (typeof SETTINGS_SECTION_IDS)[number];
export type SettingsNavGroupId = "personal" | "integrations" | "coding" | "system" | "archived";

// deep-link targets shared by the DOM owner and `?target=…` callers — the route resolves them after the active panel mounts
export const SETTINGS_TARGETS = {
  providerUpdates: "provider-updates",
  environmentPanel: "environment-panel",
} as const;

export type SettingsNavItem = {
  id: SettingsSectionId;
  group: SettingsNavGroupId;
  label: string;
  description: string;
  icon: string;
  eyebrow: string;
};

export const SETTINGS_NAV_GROUPS: ReadonlyArray<{
  id: SettingsNavGroupId;
  label: string;
}> = [
  { id: "personal", label: "Personal" },
  { id: "integrations", label: "Integrations" },
  { id: "coding", label: "Coding" },
  { id: "system", label: "System" },
  { id: "archived", label: "Archived" },
] as const;

export const SETTINGS_NAV_ITEMS: readonly SettingsNavItem[] = [
  {
    id: "general",
    group: "personal",
    label: "General",
    description: "Choose defaults for new chats, navigation, and the Environment panel.",
    icon: "settings-gear-4",
    eyebrow: "Workflow defaults",
  },
  {
    id: "profile",
    group: "personal",
    label: "Profile",
    description: "Your local activity, streaks, and a shareable stats card.",
    icon: "user",
    eyebrow: "Your stats",
  },
  {
    id: "appearance",
    group: "personal",
    label: "Appearance",
    description: "Customize the theme, typography, density, and time format.",
    icon: "color-palette",
    eyebrow: "Visual language",
  },
  {
    id: "notifications",
    group: "personal",
    label: "Notifications",
    description: "Choose how Synara tells you when work finishes or needs attention.",
    icon: "bell",
    eyebrow: "Alerts",
  },
  {
    id: "behavior",
    group: "personal",
    label: "Chat behavior",
    description: "Control live responses, follow-ups, review defaults, and safety confirmations.",
    icon: "settings-slider-hor",
    eyebrow: "Interaction rules",
  },
  {
    id: "shortcuts",
    group: "personal",
    label: "Keybindings",
    description: "Capture, customize, and add shortcuts for every Synara command.",
    icon: "shortcut",
    eyebrow: "Key bindings",
  },
  {
    id: "usage",
    group: "personal",
    label: "Usage & limits",
    description: "See remaining quota and credits for every signed-in provider.",
    icon: "gauge",
    eyebrow: "Provider limits",
  },
  {
    id: "appsnap",
    group: "integrations",
    label: "AppSnap",
    description: "Capture another app's frontmost window directly into a task.",
    icon: "screen-capture",
    eyebrow: "Screen capture",
  },
  {
    id: "integrations",
    group: "integrations",
    label: "MCP connections",
    description: "Give Codex, Claude, and other local agents scoped access to Synara tasks.",
    icon: "plugin-1",
    eyebrow: "External agents",
  },
  {
    id: "providers",
    group: "coding",
    label: "Agent providers",
    description: "Choose visible coding agents and manage their installed CLI tools.",
    icon: "puzzle",
    eyebrow: "Coding agents",
  },
  {
    id: "models",
    group: "coding",
    label: "Models & writing",
    description: "Choose the model used for Git writing and add custom model slugs.",
    icon: "brain",
    eyebrow: "Model configuration",
  },
  {
    id: "skills",
    group: "coding",
    label: "Agent skills",
    description: "Review reusable workflows discovered across all configured providers.",
    icon: "building-blocks",
    eyebrow: "Reusable workflows",
  },
  {
    id: "worktrees",
    group: "coding",
    label: "Managed worktrees",
    description: "Review and clean up isolated workspaces created by Synara.",
    icon: "branch-simple",
    eyebrow: "Workspace management",
  },
  {
    id: "advanced",
    group: "system",
    label: "System tools",
    description: "Manage sessions, recovery tools, low-level keybindings, and version details.",
    icon: "toolbox",
    eyebrow: "System tools",
  },
  {
    id: "archived",
    group: "archived",
    label: "Archived threads",
    description: "Find and restore threads you previously archived.",
    icon: "archive",
    eyebrow: "Thread management",
  },
] as const;

// DOM id shared by the row and the search index so they can't drift; panels stay mounted, so unique-within-section suffices
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
